/*
 * Goals audit — the weekly backstop for what the structural rules cannot catch (ADR 487 §5.4).
 *
 *   pnpm goals:audit                  print findings; exit 0 either way
 *   pnpm goals:audit --post           post one team-visible status_update when there are findings
 *   pnpm goals:audit --weekly --post  the scheduled form: at most once per 7 days (a stamp file)
 *
 * Three cheap checks, re-run from the spec's four-slice audit:
 *
 *   1. a Goal that reads `shipped` while a doc's Increments/Phases section, which cites one of its
 *      lanes, still lists increments with no lane — the plan's tail is on paper, not the board;
 *   2. a lane that declared itself one part of several (`leftoverSignal`) and closed with no
 *      `follows_up` — after lane 3 made the question exist, so history is not re-litigated;
 *   3. an unfinished-to-do snapshot older than 7 days that no `follows_up` answered.
 *
 * Silence means clean: a run with no findings posts nothing. A finding is a pointer for a human or a
 * seat to dispose of, never an automatic action (ADR 338: a finding is not a fix request).
 *
 * Scheduled by the ADR 166 sweep LaunchAgent (`musterd service install --sweep`), which runs from
 * the daemon's checkout every 5 minutes and calls this with `--weekly --post`; it posts as that
 * agent's `sweep` service seat (ADR 232). Unprovisioned → it prints and posts nothing.
 *
 * Runs on Node's native TypeScript against the BUILT cli/protocol, like its sibling scripts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectIncrementItems } from './intents-corpus.ts';
import type { IncrementItem } from './intents.ts';

/** The shapes this audit reads — a structural subset of the protocol's Lane and Goal. */
export interface AuditLane {
  id: string;
  title: string;
  detail: string | null;
  state: string;
  goal_id: string | null;
  resolved_at: number | null;
  follows_up?: 'none' | string[] | null | undefined;
  unfinished_todos?: { items: string[]; at: number } | null | undefined;
}
export interface AuditGoal {
  id: string;
  status: string;
}

/** When lane 3 (#1897) merged and the close question began to exist. Earlier closes were never asked it. */
export const FOLLOWS_UP_SINCE = Date.parse('2026-10-01T00:42:04Z');
export const TODOS_STALE_MS = 7 * 86_400_000;
export const WEEK_MS = 7 * 86_400_000;

/** A short id, as the board abbreviates it. */
const short = (id: string): string => id.slice(0, 10);

export function auditFindings(input: {
  lanes: readonly AuditLane[];
  goals: readonly AuditGoal[];
  items: readonly IncrementItem[];
  now: number;
  signal: (lane: AuditLane) => string | null;
}): string[] {
  const out: string[] = [];
  const byId = new Map(input.lanes.map((l) => [l.id, l]));
  const shipped = new Set(input.goals.filter((g) => g.status === 'shipped').map((g) => g.id));
  const resolve = (cited: string): AuditLane | undefined =>
    byId.get(cited) ?? input.lanes.find((l) => l.id.startsWith(cited));

  // 1. A shipped goal whose plan still lists uncited increments.
  const sections = new Map<string, IncrementItem[]>();
  for (const it of input.items) {
    const key = `${it.file}#${it.section}`;
    sections.set(key, [...(sections.get(key) ?? []), it]);
  }
  for (const [key, items] of sections) {
    const uncited = items.filter((i) => !i.cited).length;
    if (uncited === 0) continue;
    const goals = new Set<string>();
    for (const it of items)
      for (const m of it.text.matchAll(/\b0[0-9A-HJKMNP-TV-Z]{9}(?:[0-9A-HJKMNP-TV-Z]{16})?\b/g)) {
        const g = resolve(m[0])?.goal_id;
        if (g && shipped.has(g)) goals.add(g);
      }
    for (const g of goals)
      out.push(
        `goal ${g} reads shipped, but ${key.replace('#', ' §')} lists ${uncited} increment(s) with no lane`,
      );
  }

  // 2. A part-of-several lane closed without saying what is left.
  for (const l of input.lanes) {
    if (l.state !== 'done' || (l.resolved_at ?? 0) < FOLLOWS_UP_SINCE) continue;
    if (l.follows_up !== undefined && l.follows_up !== null) continue;
    const sig = input.signal(l);
    if (sig) out.push(`lane ${short(l.id)} "${l.title}" closed as "${sig}" with no follows_up`);
  }

  // 3. Unfinished to-dos left a week with no answer.
  for (const l of input.lanes) {
    const t = l.unfinished_todos;
    if (!t || input.now - t.at < TODOS_STALE_MS) continue;
    if (l.follows_up !== undefined && l.follows_up !== null) continue;
    const days = Math.floor((input.now - t.at) / 86_400_000);
    out.push(
      `lane ${short(l.id)} "${l.title}" has ${t.items.length} unfinished to-do(s) from ${days}d ago`,
    );
  }
  return out;
}

/** The one post: a count line and up to eight findings — a pointer, not a report. */
export function auditBody(findings: readonly string[]): string {
  const head = `nothing-vanishes audit (ADR 487): ${findings.length} item(s) with no lane or disposition`;
  const shown = findings.slice(0, 8).map((f) => `- ${f}`);
  const more = findings.length > 8 ? [`- …and ${findings.length - 8} more (pnpm goals:audit)`] : [];
  return [head, ...shown, ...more].join('\n');
}

const STAMP = join(homedir(), '.musterd', 'sweep', 'goals-audit.last');

function dueThisWeek(now: number): boolean {
  try {
    return now - Number(readFileSync(STAMP, 'utf8').trim()) >= WEEK_MS;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const now = Date.now();
  const weekly = process.argv.includes('--weekly');
  if (weekly && !dueThisWeek(now)) return;

  const [{ HttpClient }, { loadConfig, findBinding }, { traceClient }, protocol, { ulid }] =
    await Promise.all([
      import('../packages/cli/dist/client.js'),
      import('../packages/cli/dist/config.js'),
      import('../packages/cli/dist/trace/hook.js'),
      import('../packages/protocol/dist/index.js'),
      import('ulid'),
    ]);
  const { makeEnvelope, leftoverSignal } = protocol;
  const config = loadConfig();
  // Who reads and who speaks. The scheduled run is the `sweep` service seat (ADR 232) and speaks as
  // itself. A hand-run reads through THIS folder's seat binding — never the machine's global
  // identity, which on a shared laptop is whichever seat last joined, so reading through it would
  // be acting as someone else. A hand-run never posts.
  let token: string | undefined;
  try {
    token = readFileSync(
      process.env['MUSTERD_SERVICE_TOKEN_FILE'] ??
        join(homedir(), '.musterd', 'sweep', 'seat-token'),
      'utf8',
    ).trim();
  } catch {
    token = undefined;
  }
  const binding = findBinding(process.cwd());
  const team = process.env['MUSTERD_SERVICE_TEAM'] ?? binding?.team ?? config.current;
  if (!team) throw new Error('no team — run from a bound folder or set MUSTERD_SERVICE_TEAM');
  const http = token
    ? new HttpClient({ server: config.server, key: token, surface: 'cli' })
    : binding
      ? traceClient(binding, process.cwd())
      : null;
  if (!http) throw new Error('no sweep seat token and no seat binding in this folder');
  const [{ lanes }, { goals }] = await Promise.all([http.laneBoard(team), http.goals(team)]);

  const findings = auditFindings({
    lanes,
    goals,
    items: collectIncrementItems(),
    now,
    signal: (l) => leftoverSignal(l),
  });
  if (findings.length === 0)
    process.stdout.write('✓ goals:audit — nothing without a lane or disposition\n');
  else process.stdout.write(auditBody(findings) + '\n');

  if (process.argv.includes('--post') && findings.length > 0) {
    if (!token) {
      process.stdout.write(
        'not posted — only the sweep seat posts (musterd service install --sweep)\n',
      );
    } else {
      await http.send(
        team,
        makeEnvelope({
          id: ulid(),
          team,
          from: 'sweep',
          to: { kind: 'team' },
          act: 'status_update',
          body: auditBody(findings),
        }),
      );
    }
  }
  if (weekly) {
    mkdirSync(dirname(STAMP), { recursive: true });
    writeFileSync(STAMP, String(now));
  }
}

if (process.argv[1]?.endsWith('goals-audit.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`✗ goals:audit — ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
