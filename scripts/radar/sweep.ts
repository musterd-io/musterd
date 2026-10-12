/**
 * Research radar dry-sweep + optional M3 triage (ADR 056 ingest).
 *
 * Fetches arXiv + HF Papers, dedups against docs/research/radar/seen.json, prints a report.
 * With `--triage`, runs tier-1/tier-2 LLM scoring (requires ANTHROPIC_API_KEY).
 * Print-only — never writes seen.json, digests, or thesis docs (M4).
 *
 *   pnpm radar:sweep [--json] [--since <days>] [--limit <n>] [--triage]
 *
 * The scheduled form (lane 01M3TAKHQ4, see ./weekly.ts): `--weekly --post` — at most once a week,
 * the DRY sweep's summary is posted to the team as the `sweep` service seat. No key, no write; the
 * triaged emit stays a hand-run step (research-radar-plan.md §8).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PRINT_LIMIT, DEFAULT_SINCE_DAYS, radarDir, repoRoot, seenPath } from './config.ts';
import { loadSeen, mergeCandidates, partitionBySeen, partitionRadarCandidates } from './dedup.ts';
import { sweepArxiv, sweepExn, sweepHf, type FetchFn } from './fetch.ts';
import type { CandidateReadResult } from './fullText.ts';
import { requireAnthropicKey } from './llm.ts';
import { runTriage, type CompleteFn } from './triage.ts';
import type { RadarCandidate, SweepReport, TriageReport } from './types.ts';
import { dueThisWeek, latestDigestWeek, markRan, readSweepToken, weeklySummary } from './weekly.ts';

export interface SweepArgs {
  json: boolean;
  sinceDays: number;
  limit: number;
  triage: boolean;
  /** Read full article and attached episode scripts before triage. */
  fullText: boolean;
  /** Maximum number of pending candidates selected for retry. */
  retryLimit: number;
  /** M4: write the weekly digest + append triaged ids to seen.json. Requires triage. */
  emit: boolean;
  /** Workflow-only opt-in after verifying an existing draft is unreviewed. */
  resumeDraft: boolean;
  /** The scheduled form: run at most once per 7 days (a stamp file); otherwise exit at once. */
  weekly: boolean;
  /** Post the dry-sweep summary to the team as the `sweep` service seat (print-only without a token). */
  post: boolean;
  /** Injected for tests. */
  fetchFn?: FetchFn | undefined;
  seenFile?: string;
  apiKey?: string;
  completeFn?: CompleteFn | undefined;
  promptBody?: string | undefined;
}

export interface SweepRunReport extends SweepReport {
  readFailures: Array<{ candidateId: string; failure: string }>;
}

export function parseArgs(argv: string[]): SweepArgs {
  let json = false;
  let sinceDays = DEFAULT_SINCE_DAYS;
  let limit = DEFAULT_PRINT_LIMIT;
  let triage = false;
  let fullText = false;
  let retryLimit = 50;
  let emit = false;
  let resumeDraft = false;
  let weekly = false;
  let post = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--triage') triage = true;
    else if (a === '--full-text') fullText = true;
    else if (a === '--emit') emit = true;
    else if (a === '--resume-draft') resumeDraft = true;
    else if (a === '--weekly') weekly = true;
    else if (a === '--post') post = true;
    else if (a === '--since') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1)
        throw new Error('--since requires a positive number of days');
      sinceDays = Math.floor(v);
    } else if (a === '--limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1) throw new Error('--limit requires a positive integer');
      limit = Math.floor(v);
    } else if (a === '--retry-limit') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
        throw new Error('--retry-limit requires a positive integer');
      }
      retryLimit = v;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--dry-run') {
      // Default/only write mode — accepted for plan flag parity
    } else {
      throw new Error(`unknown flag: ${a} (try --help)`);
    }
  }
  if (emit && !triage) {
    throw new Error('--emit requires --triage — a digest is a triage artifact');
  }
  if (fullText && !triage) throw new Error('--full-text requires --triage');
  if (resumeDraft && !emit) throw new Error('--resume-draft requires --emit');
  return { json, sinceDays, limit, triage, fullText, retryLimit, emit, resumeDraft, weekly, post };
}

function printHelp(): void {
  console.log(`Usage: pnpm radar:sweep [--json] [--since <days>] [--limit <n>] [--triage] [--full-text]

  Dry-sweep arXiv + HF Papers for multi-agent / human-agent research.
  Dedups against docs/research/radar/seen.json. Print-only (does not mark seen).

  --json         machine-readable SweepReport
  --since <n>    lookback days (default ${DEFAULT_SINCE_DAYS})
  --limit <n>    max new candidates to print / feed into triage (default ${DEFAULT_PRINT_LIMIT})
  --triage       run tier-1 + tier-2 LLM triage (needs ANTHROPIC_API_KEY)
  --full-text    read every complete article and attached episode script before triage
  --retry-limit  maximum old pending candidates to retry (default 50)
  --emit         write docs/research/radar/<YYYY-WW>.md + mark triaged ids seen (requires --triage)
  --resume-draft  append retry results to an existing unreviewed draft (requires --emit)
  --weekly       the scheduled form: run at most once per 7 days (stamp ~/.musterd/sweep/radar-sweep.last)
  --post         post the dry-sweep summary to the team as the sweep service seat (lane 01M3TAKHQ4)
  --dry-run      no-op (print-only without --emit)
`);
}

export async function runSweep(args: SweepArgs): Promise<SweepRunReport> {
  const warnings: string[] = [];
  const fetchFn = args.fetchFn;
  const [arxiv, hf, exn] = await Promise.all([
    sweepArxiv({ sinceDays: args.sinceDays, fetchFn }),
    sweepHf({ sinceDays: args.sinceDays, fetchFn }),
    sweepExn({ sinceDays: args.sinceDays, fetchFn }),
  ]);
  if (arxiv.warning) warnings.push(arxiv.warning);
  if (hf.warning) warnings.push(hf.warning);
  if (exn.warning) warnings.push(exn.warning);

  const merged = mergeCandidates([arxiv.candidates, hf.candidates, exn.candidates]);
  const seen = loadSeen(args.seenFile ?? seenPath);
  const { fresh, alreadySeen } = partitionBySeen(merged, seen);
  const selection = args.fullText
    ? partitionRadarCandidates(fresh, seen, args.retryLimit, args.limit)
    : undefined;
  const printed = selection?.ready ?? fresh.slice(0, args.limit);
  const truncated = selection?.truncated ?? fresh.length > args.limit;

  let triage: TriageReport | undefined;
  let readResults: CandidateReadResult[] = [];
  if (args.triage) {
    const apiKey = args.apiKey ?? requireAnthropicKey();
    if (args.fullText) {
      const exaApiKey = process.env.EXA_API_KEY ?? '';
      if (!exaApiKey.trim()) throw new Error('EXA_API_KEY is required for --full-text');
      const { readCandidateFullText } = await import('./fullText.ts');
      readResults = await readCandidatesWithLimit(printed, (candidate) =>
        readCandidateFullText(candidate, {
          exaApiKey,
          ...(fetchFn ? { fetchFn } : {}),
          ...(args.completeFn ? { completeFn: args.completeFn } : {}),
        }),
      );
    }
    triage = await runTriage({
      candidates: printed,
      ...(args.fullText ? { readResults } : {}),
      apiKey,
      fetchFn,
      completeFn: args.completeFn,
      promptBody: args.promptBody,
    });
    warnings.push(...triage.warnings);
  }

  return {
    ...(args.fullText
      ? {
          fullTextReads: readResults.map((result) => ({
            candidateId: result.candidateId,
            status: result.status,
            ...(result.status === 'failed' ? { failure: result.failure } : {}),
            manifest: result.manifest,
          })),
          selection: {
            freshTruncated:
              fresh.filter((c) => !(seen.pending ?? []).some((p) => p.canonicalId === c.id))
                .length > Math.min(50, args.limit),
            pendingTruncated: (selection?.deferred.length ?? 0) > 0,
          },
        }
      : {}),
    generated: new Date().toISOString(),
    since_days: args.sinceDays,
    candidates_fetched: merged.length,
    already_seen: alreadySeen.length,
    new_count: fresh.length,
    printed: printed.length,
    truncated,
    new: printed,
    warnings,
    readFailures: readResults.flatMap((result) =>
      result.status === 'failed'
        ? [{ candidateId: result.candidateId, failure: result.failure }]
        : [],
    ),
    ...(triage !== undefined ? { triage } : {}),
  };
}

async function readCandidatesWithLimit(
  candidates: RadarCandidate[],
  read: (candidate: RadarCandidate) => Promise<CandidateReadResult>,
): Promise<CandidateReadResult[]> {
  const results = new Array<CandidateReadResult>(candidates.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, candidates.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      results[index] = await read(candidates[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatHuman(report: SweepReport): string {
  const lines: string[] = [];
  lines.push(`research radar dry-sweep · last ${report.since_days}d`);
  lines.push(
    `fetched ${report.candidates_fetched} · already_seen ${report.already_seen} · new ${report.new_count}` +
      (report.truncated ? ` (showing ${report.printed}, truncated)` : ''),
  );
  if (report.warnings.length) {
    for (const w of report.warnings) lines.push(`⚠ ${w}`);
  }
  lines.push('');
  if (report.new.length === 0) {
    lines.push('(no new candidates)');
  } else if (!report.triage) {
    for (const c of report.new) {
      lines.push(formatRow(c));
    }
  }

  if (report.triage) {
    lines.push(...formatTriage(report.triage));
  }

  lines.push('');
  lines.push(`seen ledger: ${seenPath} (read-only until M4)`);
  lines.push(`radar dir:   ${radarDir}`);
  return lines.join('\n');
}

function formatTriage(t: TriageReport): string[] {
  const lines: string[] = [];
  lines.push(
    `triage ${t.prompt_version} · tier1=${t.tier1_model} · tier2=${t.tier2_model} · floor=${t.relevance_floor}`,
  );
  lines.push(
    `candidates_in ${t.candidates_in} · shortlisted ${t.shortlisted}` +
      (t.shortlist_truncated ? ' (shortlist truncated)' : '') +
      ` · surfaced ${t.surfaced.length}`,
  );
  lines.push('');
  if (t.surfaced.length === 0) {
    lines.push('(no surfaced papers — all ignore or empty shortlist)');
  } else {
    for (const r of t.surfaced) {
      lines.push(`[${r.verdict}] ${r.score.toFixed(2)} ${r.id}  ${r.title}`);
      lines.push(`  ${r.url}`);
      lines.push(`  what: ${r.one_line}`);
      lines.push(`  why:  ${r.why_musterd}`);
      lines.push(`  gut:  ${r.gut_check}`);
      lines.push(`  conf: ${r.confidence.toFixed(2)}`);
      lines.push('');
    }
  }
  return lines;
}

function formatRow(c: RadarCandidate): string {
  const src = c.source.padEnd(5);
  const date = (c.published || '????-??-??').padEnd(10);
  const title = c.title.length > 90 ? `${c.title.slice(0, 87)}...` : c.title;
  return `${src} ${date} ${c.id.padEnd(12)} ${title}\n       ${c.url}`;
}

/** Thesis / ledger paths the dry-sweep must never write (test hook). */
export function forbiddenWritePaths(): string[] {
  return [
    join(repoRoot, 'docs', 'design', 'research-foundation.md'),
    join(repoRoot, 'docs', 'research', 'radar', 'seen.json'),
  ];
}

/**
 * The weekly post (lane 01M3TAKHQ4). Who speaks: the `sweep` service seat (ADR 232), through its
 * token file — the same mechanics as `scripts/goals-audit.ts`. A hand-run with no token prints the
 * summary and posts nothing: a seat must never speak as the service.
 */
async function postSummary(body: string): Promise<void> {
  const token = readSweepToken();
  if (!token) {
    process.stdout.write(
      'not posted — only the sweep seat posts (musterd service install --sweep)\n',
    );
    return;
  }
  const [{ HttpClient }, { loadConfig, findBinding }, { makeEnvelope }, { ulid }] =
    await Promise.all([
      import('../../packages/cli/dist/client.js'),
      import('../../packages/cli/dist/config.js'),
      import('../../packages/protocol/dist/index.js'),
      import('ulid'),
    ]);
  const config = loadConfig();
  const team =
    process.env['MUSTERD_SERVICE_TEAM'] ?? findBinding(process.cwd())?.team ?? config.current;
  if (!team) throw new Error('no team — set MUSTERD_SERVICE_TEAM or run from a bound folder');
  const http = new HttpClient({ server: config.server, key: token, surface: 'cli' });
  await http.send(
    team,
    makeEnvelope({
      id: ulid(),
      team,
      from: 'sweep',
      to: { kind: 'team' },
      act: 'status_update',
      body,
    }),
  );
  process.stdout.write(`posted to ${team} as sweep\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();
  if (args.weekly && !dueThisWeek(now)) return;
  const report = await runSweep(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(report)}\n`);
  }
  if (args.post) {
    const summary = weeklySummary(report, latestDigestWeek(radarDir), now);
    process.stdout.write(`${summary}\n`);
    await postSummary(summary);
  }
  // Stamped after the post, so a run that died before speaking is retried next tick.
  if (args.weekly) markRan(now);
  if (args.emit) {
    const { emitDigest } = await import('./digest.ts');
    const out = emitDigest(report, radarDir, report.readFailures, args.resumeDraft);
    process.stdout.write(
      `digest ready: ${out.digestPath} (seen +${out.appended.arxiv} arxiv, +${out.appended.hf} hf, +${out.appended.exn} exn)\n`,
    );
  }
  if (report.candidates_fetched === 0 && report.warnings.length) {
    process.exitCode = 2;
  }
  if (report.triage && report.triage.warnings.some((w) => w.startsWith('tier-1 failed'))) {
    process.exitCode = 2;
  }
}

// Run only when invoked directly (`node sweep.ts`), not when tests import helpers.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
