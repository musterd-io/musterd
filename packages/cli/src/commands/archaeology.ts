import { execFileSync } from 'node:child_process';
import type { Lane } from '@musterd/protocol';
import {
  classify,
  type ArchaeologyReport,
  type PrTally,
  type WasteClass,
} from '../archaeology/engine.js';
import { DEFAULT_EXCLUDES, extractFacts } from '../archaeology/git.js';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd archaeology --start <sha>` — the cookoff wasted-work reference collector (ADR 123 /
 * ADR 122 §5). Classifies every authored line in the window after the kickoff commit per predicate
 * set v1 (W3 duplicated → W1 abandoned → W2 clobbered → W4 conflict churn) from git alone: no
 * daemon, no musterd state, actor identity from git attribution (ADR 109). This is also the seed
 * of the parked self-diagnosis funnel — it runs on any repo.
 */

const USAGE =
  'usage: musterd archaeology (--start <sha> | --lane <id>) [--delivered <ref>] [--repo <path>] ' +
  '[--population all|pulls] [--remote <name>] [--by-lane] [--exclude <glob>[,<glob>…]] [--json]';

/** One lane's share of the report (ADR 462): the lane whose merge attestation names the PR. */
export interface LaneWaste extends PrTally {
  lane: string | null;
  title: string | null;
  pr: number;
}

/** Join the report's per-PR tallies to lanes by their merge attestation's PR number. */
export function wasteByLane(byPr: Record<string, PrTally>, lanes: Lane[]): LaneWaste[] {
  const laneOfPr = new Map<number, Lane>();
  for (const l of lanes) if (l.merged?.pr != null) laneOfPr.set(l.merged.pr, l);
  return Object.entries(byPr)
    .map(([pr, t]) => {
      const l = laneOfPr.get(Number(pr));
      return { ...t, pr: Number(pr), lane: l?.id ?? null, title: l?.title ?? null };
    })
    .sort((a, b) => b.wasted - a.wasted || b.authored - a.authored || a.pr - b.pr);
}

function renderLanes(rows: LaneWaste[]): string {
  const out = ['', 'by lane (PR joined to the lane’s merge attestation — ADR 462):'];
  for (const r of rows) {
    const pct = r.authored === 0 ? '0.0' : ((r.wasted / r.authored) * 100).toFixed(1);
    const id = r.lane ? r.lane.slice(0, 10) : theme.meta('(no lane) ');
    const title = (r.title ?? '').slice(0, 44).padEnd(44);
    const split = (['W3', 'W1', 'W2', 'W4'] as WasteClass[])
      .filter((c) => r.classes[c] > 0)
      .map((c) => `${c} ${r.classes[c]}`)
      .join(' · ');
    out.push(
      `  ${id}  ${title} #${String(r.pr).padEnd(5)} ${String(r.authored).padStart(6)} authored ${String(r.wasted).padStart(5)} wasted (${pct}%)${split ? `  ${theme.meta(split)}` : ''}`,
    );
  }
  return out.join('\n');
}

const CLASS_LABEL: Record<WasteClass, string> = {
  W3: 'W3 duplicated',
  W1: 'W1 abandoned',
  W2: 'W2 clobbered',
  W4: 'W4 conflict churn',
};

function render(report: ArchaeologyReport): string {
  const lines: string[] = [];
  const pct = report.wastedPct.toFixed(1);
  lines.push(
    `wasted-work ${theme.warn(`${pct}%`)} — ${report.wastedTotal}/${report.totalAuthoredLines} authored lines (predicate set ${report.predicateSet})`,
  );
  for (const cls of ['W3', 'W1', 'W2', 'W4'] as WasteClass[]) {
    lines.push(`  ${CLASS_LABEL[cls].padEnd(18)} ${String(report.wasted[cls]).padStart(6)}`);
  }
  lines.push('');
  lines.push('by actor:');
  const actors = Object.entries(report.byActor).sort((a, b) => b[1].authored - a[1].authored);
  for (const [actor, a] of actors) {
    const apct = a.authored === 0 ? '0.0' : ((a.wasted / a.authored) * 100).toFixed(1);
    lines.push(
      `  ${theme.memberName(actor, 'agent').padEnd(40)} ${String(a.authored).padStart(6)} authored  ${String(a.wasted).padStart(6)} wasted  (${apct}%)`,
    );
  }
  if (report.inFlightPrs && report.inFlightPrs.length > 0) {
    lines.push('');
    lines.push(
      theme.meta(
        `in flight, left out (open PRs): ${report.inFlightPrs.map((n) => `#${n}`).join(' ')}`,
      ),
    );
  }
  lines.push('');
  lines.push(
    theme.meta(
      'line-level approximation (ADR 123 honest edges) — read with the acceptance-test guardrail, never alone',
    ),
  );
  return lines.join('\n');
}

export async function archaeologyCommand(
  parsed: Parsed,
  baseDir: string = process.cwd(),
): Promise<number> {
  const laneId = flagStr(parsed.flags, 'lane');
  const byLane = parsed.flags['by-lane'] === true || laneId !== undefined;
  const repo = flagStr(parsed.flags, 'repo') ?? baseDir;
  const delivered = flagStr(parsed.flags, 'delivered');
  const populationRaw = flagStr(parsed.flags, 'population') ?? (byLane ? 'pulls' : 'all');
  if (populationRaw !== 'all' && populationRaw !== 'pulls') {
    throw new CliError(`--population must be all or pulls\n${USAGE}`, 2);
  }
  const population: 'all' | 'pulls' = populationRaw;
  const remote = flagStr(parsed.flags, 'remote');

  // Lanes are read only when the report is grouped by them; the cookoff path stays daemon-free.
  let lanes: Lane[] = [];
  let lane: Lane | undefined;
  if (byLane) {
    const { team, http } = resolve(parsed.flags);
    // Merged history is the whole point here, so it asks past the 14-day window (ADR 534).
    lanes = (await http.laneBoard(team, { history: true })).lanes;
    if (laneId !== undefined) {
      lane = lanes.find((l) => l.id === laneId || l.id.startsWith(laneId));
      if (!lane) throw new CliError(`no lane ${laneId} on ${team}`, 1);
      if (lane.merged?.pr == null) {
        throw new CliError(
          `lane ${lane.id} has no merge attestation naming a PR — nothing to measure`,
          1,
        );
      }
    }
  }

  let start = flagStr(parsed.flags, 'start');
  if (!start && lane?.claimed_at != null) {
    // The lane's window opens at its claim: the delivered tip as it stood then.
    const before = Math.floor(lane.claimed_at / 1000);
    start = execFileSync('git', ['rev-list', '-1', `--before=${before}`, delivered ?? 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  }
  if (!start) throw new CliError(`--start <sha> (the kickoff commit) is required\n${USAGE}`, 2);
  const excludeRaw = flagStr(parsed.flags, 'exclude');
  const exclude = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_EXCLUDES;

  let report: ArchaeologyReport;
  try {
    report = classify(
      extractFacts({
        repo,
        start,
        exclude,
        population,
        ...(delivered ? { delivered } : {}),
        ...(remote ? { remote } : {}),
      }),
    );
  } catch (err) {
    throw new CliError(`git archaeology failed: ${(err as Error).message.split('\n')[0]}`, 1);
  }

  let laneRows = byLane ? wasteByLane(report.byPr, lanes) : [];
  if (lane) laneRows = laneRows.filter((r) => r.lane === lane.id);
  const out = parsed.flags['json']
    ? JSON.stringify(byLane ? { ...report, byLane: laneRows } : report, null, 2)
    : render(report) + (byLane ? renderLanes(laneRows) : '');
  // The full JSON (per-line verdicts) can exceed the pipe buffer; bin.ts process.exit()s on
  // return, so an unawaited write would truncate. Flush before returning.
  await new Promise<void>((resolve) => process.stdout.write(out + '\n', () => resolve()));
  return 0;
}
