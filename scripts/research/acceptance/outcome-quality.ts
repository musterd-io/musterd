/**
 * Outcome quality on our own team: from the lane record, how often a landed lane is sent back at
 * acceptance, how many rounds it takes to get accepted, and how that splits by kind of work.
 * Lane 01M6S2NYC4; finding 039.
 *
 * READ-ONLY over `~/.musterd/musterd.db` (or `MUSTERD_DB`). Touches no lane, no seat, no daemon.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/acceptance/outcome-quality.ts \
 *     [--team revive] [--since 2026-08-01] [--json]
 *
 * A DIAGNOSTIC OF THE WORK, NEVER A RANKING OF SEATS (human-agent-dynamics.md §4). The output
 * splits by area and by who judged (human or agent). It deliberately has no per-owner column.
 *
 * WHAT A ROUND IS. Every `lane.ready_for_review` row is one submission: the owner put a landed
 * outcome in front of an acceptor. A `lane.review_sent_back` row is an acceptor's decline: "not
 * what we wanted" (ADR 192). The lane's `lane.closed` row says how it ended, and only
 * `reason = 'counterpart_confirm'` is an accept by someone other than the owner. Every other close
 * reason (self_close, exempt, no_candidate, swept, the ADR 217 wait verdicts) ended the lane
 * without a judgement, so it says nothing about quality either way.
 *
 * THE DENOMINATOR is lanes that got at least one verdict: accepted, sent back, or both. A lane
 * nobody judged is counted separately as `unjudged`, because counting it as an accept would turn
 * "nobody looked" into "it was good".
 *
 * KNOWN BLIND SPOTS, said here so the numbers are read with them:
 *  - A decline that never moved the lane out of `awaiting_acceptance` writes no sent-back row.
 *  - A lane re-submitted after a send-back usually gets a second ready row, but an owner who fixes
 *    and closes without re-submitting leaves rounds = 1 with a sent-back on it. That is classed
 *    `sent_back_then_closed_unjudged`, not counted as an accept.
 *  - Verdicts relayed from a hub (`authorityRelay.ts`) write the same sent-back verb, so they are
 *    in. Verdicts given on another team's daemon are not in this DB.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AuditRow {
  ts: number;
  action: string;
  actor: string | null;
  detail: string | null;
}

export interface LaneRow {
  id: string;
  title: string;
  surface_globs: string | null;
  areas_json?: string | null;
  goal_id?: string | null;
}

export type Outcome =
  | 'accepted_first_round'
  | 'accepted_after_send_back'
  | 'sent_back_still_open'
  | 'sent_back_then_closed_unjudged'
  | 'unjudged';

export interface LaneResult {
  lane: string;
  title: string;
  areas: string[];
  submits: number;
  sentBacks: number;
  /** submissions up to and including the accepting one; null when never accepted */
  roundsToAccept: number | null;
  outcome: Outcome;
  closeReason: string | null;
  /** who gave each verdict, as member kind */
  judgedBy: ('human' | 'agent' | 'unknown')[];
  firstSubmitTs: number;
}

const ACTIONS = ['lane.ready_for_review', 'lane.review_sent_back', 'lane.closed'] as const;

function parse(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const v = JSON.parse(detail) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Kind of work, coarse on purpose. Declared areas win (ADR 582); otherwise the first meaningful
 * path segment of each scope glob: `packages/<pkg>` → `<pkg>`, `docs/**` → `docs`, `scripts/**` →
 * `scripts`, anything else → its first segment. A lane with no scope is `unscoped`. A lane with
 * several areas counts once in each, so the per-area rows do not sum to the total.
 */
export function areasOf(lane: Pick<LaneRow, 'surface_globs' | 'areas_json'>): string[] {
  const declared = parseList(lane.areas_json ?? null);
  if (declared.length > 0) return [...new Set(declared.map((a) => a.trim().toLowerCase()))];
  const globs = parseList(lane.surface_globs);
  const out = new Set<string>();
  for (const g of globs) {
    const segs = g.replace(/^\/+/, '').split('/').filter(Boolean);
    if (segs.length === 0) continue;
    if (segs[0] === 'packages' && segs[1] && !segs[1].includes('*')) out.add(segs[1]);
    else if (segs.length === 1 && /\.mdx?$/i.test(segs[0]!)) out.add('docs');
    else out.add(segs[0]!.replace(/[{}*]/g, '') || 'unscoped');
  }
  return out.size > 0 ? [...out] : ['unscoped'];
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One lane's acceptance history, from its rows in time order. Events after the lane's last close
 * are ignored only if there is no later submit — a reopened lane's second life still counts.
 */
export function classify(
  lane: LaneRow,
  rows: AuditRow[],
  kindOf: (name: string | null) => 'human' | 'agent' | 'unknown',
): LaneResult | null {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  let submits = 0;
  let sentBacks = 0;
  let roundsToAccept: number | null = null;
  let closeReason: string | null = null;
  let firstSubmitTs = 0;
  const judgedBy: LaneResult['judgedBy'] = [];
  for (const r of sorted) {
    const d = parse(r.detail);
    if (r.action === 'lane.ready_for_review') {
      if (submits === 0) firstSubmitTs = r.ts;
      submits++;
    } else if (r.action === 'lane.review_sent_back') {
      if (submits === 0) continue; // a send-back with no submit on record is a fold artefact
      sentBacks++;
      judgedBy.push(kindOf(str(d['reviewer']) ?? r.actor));
    } else if (r.action === 'lane.closed') {
      if (submits === 0) continue;
      closeReason = str(d['reason']);
      if (closeReason === 'counterpart_confirm' && roundsToAccept === null) {
        roundsToAccept = submits;
        judgedBy.push(kindOf(str(d['closed_by']) ?? r.actor));
      }
    }
  }
  if (submits === 0) return null;
  const outcome: Outcome =
    roundsToAccept !== null
      ? sentBacks === 0
        ? 'accepted_first_round'
        : 'accepted_after_send_back'
      : sentBacks > 0
        ? closeReason === null
          ? 'sent_back_still_open'
          : 'sent_back_then_closed_unjudged'
        : 'unjudged';
  return {
    lane: lane.id,
    title: lane.title,
    areas: areasOf(lane),
    submits,
    sentBacks,
    roundsToAccept,
    outcome,
    closeReason,
    judgedBy,
    firstSubmitTs,
  };
}

export interface Tally {
  lanes: number;
  judged: number;
  unjudged: number;
  acceptedFirst: number;
  acceptedAfter: number;
  sentBackNeverAccepted: number;
  /** lanes with ≥1 send-back, over judged lanes */
  sendBackRate: number | null;
  /** accepted lanes only: histogram of rounds-to-accept */
  rounds: Record<string, number>;
  meanRoundsToAccept: number | null;
}

export function tally(results: LaneResult[]): Tally {
  const judgedRows = results.filter((r) => r.outcome !== 'unjudged');
  const accepted = results.filter((r) => r.roundsToAccept !== null);
  const rounds: Record<string, number> = {};
  for (const r of accepted) {
    const k = r.roundsToAccept! >= 4 ? '4+' : String(r.roundsToAccept);
    rounds[k] = (rounds[k] ?? 0) + 1;
  }
  const sentBackAny = judgedRows.filter((r) => r.sentBacks > 0).length;
  return {
    lanes: results.length,
    judged: judgedRows.length,
    unjudged: results.length - judgedRows.length,
    acceptedFirst: results.filter((r) => r.outcome === 'accepted_first_round').length,
    acceptedAfter: results.filter((r) => r.outcome === 'accepted_after_send_back').length,
    sentBackNeverAccepted: results.filter(
      (r) => r.outcome === 'sent_back_still_open' || r.outcome === 'sent_back_then_closed_unjudged',
    ).length,
    sendBackRate: judgedRows.length > 0 ? sentBackAny / judgedRows.length : null,
    rounds,
    meanRoundsToAccept:
      accepted.length > 0
        ? accepted.reduce((s, r) => s + r.roundsToAccept!, 0) / accepted.length
        : null,
  };
}

export interface Report {
  team: string;
  since: string | null;
  firstSubmit: string | null;
  lastSubmit: string | null;
  overall: Tally;
  byArea: Record<string, Tally>;
  /** verdicts (not lanes) by who gave them: accepts and send-backs */
  verdictsByJudge: Record<string, { accepts: number; sendBacks: number }>;
  closeReasonsUnjudged: Record<string, number>;
  /** the sent-back lanes themselves, for reading what the declines were about */
  sentBack: Pick<LaneResult, 'lane' | 'title' | 'areas' | 'submits' | 'sentBacks' | 'outcome'>[];
}

export function report(
  team: string,
  since: number | null,
  lanes: LaneRow[],
  rowsByLane: Map<string, AuditRow[]>,
  kindOf: (name: string | null) => 'human' | 'agent' | 'unknown',
): Report {
  const results: LaneResult[] = [];
  for (const lane of lanes) {
    const r = classify(lane, rowsByLane.get(lane.id) ?? [], kindOf);
    if (r && (since === null || r.firstSubmitTs >= since)) results.push(r);
  }
  const areaNames = [...new Set(results.flatMap((r) => r.areas))].sort();
  const byArea: Record<string, Tally> = {};
  for (const a of areaNames) byArea[a] = tally(results.filter((r) => r.areas.includes(a)));
  const verdictsByJudge: Report['verdictsByJudge'] = {};
  for (const r of results) {
    // judgedBy is in event order; the last entry is the accept when there is one
    r.judgedBy.forEach((k, i) => {
      const v = (verdictsByJudge[k] ??= { accepts: 0, sendBacks: 0 });
      const isAccept = r.roundsToAccept !== null && i === r.judgedBy.length - 1;
      if (isAccept) v.accepts++;
      else v.sendBacks++;
    });
  }
  const closeReasonsUnjudged: Record<string, number> = {};
  for (const r of results.filter((x) => x.outcome === 'unjudged')) {
    const k = r.closeReason ?? '(still open)';
    closeReasonsUnjudged[k] = (closeReasonsUnjudged[k] ?? 0) + 1;
  }
  const ts = results.map((r) => r.firstSubmitTs).sort((a, b) => a - b);
  const day = (t: number | undefined) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  return {
    team,
    since: since === null ? null : day(since),
    firstSubmit: day(ts[0]),
    lastSubmit: day(ts[ts.length - 1]),
    overall: tally(results),
    byArea,
    verdictsByJudge,
    closeReasonsUnjudged,
    sentBack: results
      .filter((r) => r.sentBacks > 0)
      .sort((a, b) => a.firstSubmitTs - b.firstSubmitTs)
      .map(({ lane, title, areas, submits, sentBacks, outcome }) => ({
        lane,
        title,
        areas,
        submits,
        sentBacks,
        outcome,
      })),
  };
}

function pct(n: number | null): string {
  return n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`;
}

export function render(r: Report): string {
  const o = r.overall;
  const lines = [
    `outcome quality — team ${r.team} · submits ${r.firstSubmit} → ${r.lastSubmit}` +
      (r.since ? ` (since ${r.since})` : ''),
    '',
    `lanes submitted for acceptance  ${o.lanes}`,
    `  judged (≥1 accept or decline) ${o.judged}`,
    `  never judged                  ${o.unjudged}  ${JSON.stringify(r.closeReasonsUnjudged)}`,
    '',
    `of the judged lanes:`,
    `  accepted first round          ${o.acceptedFirst}`,
    `  accepted after a send-back    ${o.acceptedAfter}`,
    `  sent back, never accepted     ${o.sentBackNeverAccepted}`,
    `  send-back rate                ${pct(o.sendBackRate)}`,
    `  rounds to accept              ${JSON.stringify(o.rounds)} · mean ${o.meanRoundsToAccept?.toFixed(2) ?? 'n/a'}`,
    '',
    `by area (a lane counts in each of its areas):`,
    `  ${'area'.padEnd(14)} ${'judged'.padStart(6)} ${'sent back'.padStart(9)} ${'rate'.padStart(5)} ${'mean rounds'.padStart(11)}`,
  ];
  const areas = Object.entries(r.byArea).sort((a, b) => b[1].judged - a[1].judged);
  for (const [a, t] of areas) {
    if (t.judged === 0) continue;
    const sb = t.acceptedAfter + t.sentBackNeverAccepted;
    lines.push(
      `  ${a.padEnd(14)} ${String(t.judged).padStart(6)} ${String(sb).padStart(9)} ${pct(t.sendBackRate).padStart(5)} ${(t.meanRoundsToAccept?.toFixed(2) ?? 'n/a').padStart(11)}`,
    );
  }
  lines.push('', 'verdicts by who gave them:');
  for (const [k, v] of Object.entries(r.verdictsByJudge))
    lines.push(`  ${k.padEnd(8)} accepts ${v.accepts} · send-backs ${v.sendBacks}`);
  lines.push('', `sent-back lanes (${r.sentBack.length}):`);
  for (const s of r.sentBack)
    lines.push(
      `  ${s.lane.slice(0, 10)} ${s.outcome.padEnd(30)} ${s.sentBacks}×  [${s.areas.join(',')}] ${s.title.slice(0, 90)}`,
    );
  return lines.join('\n');
}

function main(argv: string[]): void {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const teamName = arg('--team') ?? 'revive';
  const sinceArg = arg('--since');
  const since = sinceArg ? Date.parse(`${sinceArg}T00:00:00Z`) : null;
  const db = new DatabaseSync(
    process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db'),
    { readOnly: true },
  );
  const team = db.prepare('select id from teams where name = ?').get(teamName) as
    | { id: string }
    | undefined;
  if (!team) throw new Error(`no team named ${teamName} in this DB`);
  const laneCols = new Set(
    (db.prepare('pragma table_info(lanes)').all() as { name: string }[]).map((c) => c.name),
  );
  const lanes = db
    .prepare(
      `select id, title, surface_globs${laneCols.has('areas_json') ? ', areas_json' : ''}${laneCols.has('goal_id') ? ', goal_id' : ''} from lanes where team_id = ?`,
    )
    .all(team.id) as unknown as LaneRow[];
  const rowsByLane = new Map<string, AuditRow[]>();
  const audit = db
    .prepare(
      `select ts, action, actor, detail from audit where team_id = ? and action in (${ACTIONS.map(() => '?').join(',')}) order by ts`,
    )
    .all(team.id, ...ACTIONS) as unknown as AuditRow[];
  for (const r of audit) {
    const lane = str(parse(r.detail)['lane']);
    if (!lane) continue;
    if (!rowsByLane.has(lane)) rowsByLane.set(lane, []);
    rowsByLane.get(lane)!.push(r);
  }
  const kinds = new Map(
    (
      db.prepare('select name, kind from members where team_id = ?').all(team.id) as {
        name: string;
        kind: string;
      }[]
    ).map((m) => [m.name, m.kind]),
  );
  const kindOf = (name: string | null) => {
    const k = name ? kinds.get(name) : undefined;
    return k === 'human' ? 'human' : k ? 'agent' : 'unknown';
  };
  const r = report(teamName, since, lanes, rowsByLane, kindOf);
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
