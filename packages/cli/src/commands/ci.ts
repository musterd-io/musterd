import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { CiRunSample } from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { configPath } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';
import { serviceSeatAuth } from './service.js';

const run = promisify(execFile);

/**
 * ADR 610: `musterd ci sample` — read the forge's completed CI runs since the last tick and hand
 * them to the daemon as `ci.run_measured` rows. Run hourly by the ci-probe LaunchAgent as the
 * `autorefresh` service seat (the platform's ledger seat, ADR 232); by hand it runs as you.
 *
 * Idempotent twice over: the daemon dedupes by run id, and the tick keeps a high-water mark so a
 * steady state posts only the hour's runs. `--full` ignores the mark and re-reads the forge's
 * recent history (the first install, or after the daemon's store was reset).
 *
 * Reads the forge through `gh` — the same credential the probe dispatches with — and never stores
 * a log line, a PR body or a token: shapes and timings only (ADR 051).
 */
/**
 * The flags `musterd ci` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const CI_FLAGS = ['full', 'gh', 'repo'] as const;

export async function ciCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...CI_FLAGS],
    'the flags `musterd ci` takes are listed by `musterd help ci`',
  );
  const sub = parsed.positionals[0];
  if (sub !== 'sample')
    throw new CliError('usage: musterd ci sample [--repo <owner/name>] [--full] [--json]', 2);
  const repo =
    flagStr(parsed.flags, 'repo') ?? process.env['MUSTERD_PROBE_REPO'] ?? 'musterd-io/musterd';
  const full = parsed.flags['full'] === true;
  const json = parsed.flags['json'] === true;
  const markPath = join(dirname(configPath()), 'ci-trend', '.last-run-id');
  const mark = full ? null : readMark(markPath);

  const runs = await listRuns(repo, mark);
  const samples: CiRunSample[] = [];
  for (const r of runs) samples.push(await sampleRun(repo, r));

  const auth = serviceSeatAuth() ?? resolve(parsed.flags);
  const result =
    samples.length === 0
      ? { added: 0, seen: 0 }
      : await auth.http.sampleCiRuns(auth.team, { runs: samples });
  if (runs.length > 0) {
    const newest = runs.reduce((a, b) => (b.databaseId > a.databaseId ? b : a));
    writeMark(markPath, String(newest.databaseId));
  }
  const out = { repo, runs: samples.length, ...result };
  if (json) process.stdout.write(JSON.stringify(out) + '\n');
  else
    process.stdout.write(
      `${theme.accent('ci sample')} ${repo} — ${samples.length} completed run${samples.length === 1 ? '' : 's'} read · ${result.added} new · ${result.seen} already recorded\n`,
    );
  return 0;
}

interface ForgeRun {
  databaseId: number;
  headSha: string;
  headBranch: string;
  event: string;
  attempt: number;
  conclusion: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT')
      throw new CliError('gh is not on PATH — the sampler reads the forge through it', 1);
    throw new CliError(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(e.stderr ?? e.message).trim()}`,
      1,
    );
  }
}

/** Completed runs of ci.yml newer than the mark (or the newest 200 when there is none). */
async function listRuns(repo: string, mark: string | null): Promise<ForgeRun[]> {
  const raw = await gh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    'ci.yml',
    '--limit',
    mark ? '100' : '200',
    '--json',
    'databaseId,headSha,headBranch,event,attempt,conclusion,status,createdAt,updatedAt',
  ]);
  const all = JSON.parse(raw) as ForgeRun[];
  const floor = mark ? Number(mark) : 0;
  return all.filter((r) => r.status === 'completed' && r.databaseId > floor);
}

async function sampleRun(repo: string, r: ForgeRun): Promise<CiRunSample> {
  const raw = await gh(['run', 'view', String(r.databaseId), '--repo', repo, '--json', 'jobs']);
  const { jobs } = JSON.parse(raw) as {
    jobs: { name: string; conclusion: string; startedAt: string; completedAt: string }[];
  };
  const ms = (iso: string) => Date.parse(iso);
  return {
    run_id: String(r.databaseId),
    head_sha: r.headSha.toLowerCase(),
    branch: r.headBranch,
    event: r.event,
    attempt: r.attempt,
    conclusion: r.conclusion || 'unknown',
    created_at: ms(r.createdAt),
    duration_ms: Math.max(0, ms(r.updatedAt) - ms(r.createdAt)),
    jobs: jobs
      .filter((j) => j.conclusion !== 'skipped' && j.startedAt && j.completedAt)
      .slice(0, 64)
      .map((j) => ({
        // Printable ASCII only, so a job name the forge lets a workflow author pick cannot carry a
        // terminal escape into the ledger (the schema refuses the rest; this keeps the batch valid).
        name: j.name.replace(/[^\x20-\x7e]/g, '?').slice(0, 64),
        conclusion: j.conclusion || 'unknown',
        duration_ms: Math.max(0, ms(j.completedAt) - ms(j.startedAt)),
      })),
  };
}

function readMark(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

function writeMark(p: string, v: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, v + '\n', 'utf8');
}
