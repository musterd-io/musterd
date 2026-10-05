/**
 * Reach-and-boundaries §5 — the delivery measurement that governs the wake host's attended-session
 * deferral (lane 01M3TAKT16, ADR 423's rail data), as a re-runnable read.
 *
 * WHY THIS EXISTS. The spec (2026-09-23) retired the relay and left §5 as a MEASUREMENT: the
 * attended deferral (10 min) may shrink only when three criteria read well. The evidence was
 * already in the ledger and nobody had read it: `interrupt.raised` carries the act id, so the
 * act's `created_at` gives send→first-raise latency per rail; `interrupt.refused` is a live session
 * whose bell is off (a dead or missing lease), per seat. This prints both, and the verdict rule.
 *
 * THE THREE CRITERIA (§5), and how each is read here:
 *   1. Mid-turn delivery latency per harness — send→FIRST raise of each act, p50/p95 per `rail`.
 *      This measures the recipient's turn cadence as much as the rail (stanley), so the buckets are
 *      printed beside the percentiles: a p95 of 20 min with most acts under 30 s is an idle seat,
 *      not a slow rail.
 *   2. No deaf seats — `interrupt.refused` per seat, with the lease state and (once #PR lands)
 *      the reason. A seat with refusals AND raises in the same window went deaf and came back.
 *   3. Idle-at-prompt reach — the same latency distribution, read as "how long a directed act
 *      waited": the >5 min and >1 h buckets ARE the idle-at-prompt number the deferral trades
 *      against.
 *
 * THE VERDICT RULE, so the read cannot be argued into either answer afterwards:
 *   HOLD the attended deferral while refusals in the window exceed 25% of raises, or any rail's
 *   p95 exceeds 30 s with fewer than 80% of its acts under 30 s. SHRINK is a lane with its own
 *   number, never this script's output.
 *
 * READ-ONLY over `~/.musterd/musterd.db`. Touches no lane, no seat, no daemon. No spend.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/delivery-measurement.ts [--json] [--days N]
 *
 * TRAPS. `interrupt.raised` is written per PROBE, not per act (`count` on the row is how many
 * acts that probe carried), and the same act raises again on every boundary until it is read — so
 * latency is to the FIRST raise of each act id, never a mean over rows. `actor` on a raised row is
 * the SENDER (sometimes weeks earlier); the recipient is `target`. A refused row is damped
 * (`hasRecentInterruptRefusal`), so refusals undercount probes, never overcount seats.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The first cut, frozen for the printed comparison (lane 01M3TAKT16, 14 days to 2026-10-02). */
export const BASELINE = {
  taken: '2026-10-02',
  note: '279 acts — 141 <30s, 110 30s–5m, 23 5m–1h, 5 >1h; 311 refusals vs 352 raises, every seat',
};

export interface RaisedRow {
  ts: number;
  target: string | null;
  detail: string | null;
  /** The act's own `created_at`, joined from `messages`; null when the act is gone from the log. */
  act_created_at: number | null;
}

export interface RefusedRow {
  ts: number;
  actor: string | null;
  detail: string | null;
}

export const BUCKETS = [
  ['<30s', 30_000],
  ['30s–5m', 300_000],
  ['5m–1h', 3_600_000],
  ['>1h', Infinity],
] as const;

export interface RailStats {
  rail: string;
  acts: number;
  p50Ms: number;
  p95Ms: number;
  under30s: number;
  buckets: Record<string, number>;
}

export interface SeatRefusals {
  seat: string;
  refusals: number;
  raises: number;
  byLease: Record<string, number>;
  byReason: Record<string, number>;
}

export interface Summary {
  acts: number;
  raises: number;
  refusals: number;
  /** ADR 511: refusals from a session whose adapter had not claimed yet — not deaf, not gated on. */
  notJoined: number;
  rails: RailStats[];
  seats: SeatRefusals[];
  unparseable: number;
  verdict: { hold: boolean; why: string[] };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

function bucketOf(ms: number): string {
  for (const [label, max] of BUCKETS) if (ms < max) return label;
  return BUCKETS[BUCKETS.length - 1]![0];
}

/** Criterion 1 + 3: send→FIRST raise per act, per rail. */
export function latencyByRail(rows: RaisedRow[]): { rails: RailStats[]; unparseable: number } {
  const first = new Map<string, { ts: number; rail: string; created: number }>();
  let unparseable = 0;
  for (const r of rows) {
    let d: { act?: string; rail?: string };
    try {
      d = JSON.parse(r.detail ?? '{}') as { act?: string; rail?: string };
    } catch {
      unparseable++;
      continue;
    }
    if (!d.act || r.act_created_at === null) continue;
    const have = first.get(d.act);
    if (!have || r.ts < have.ts)
      first.set(d.act, { ts: r.ts, rail: d.rail ?? '(none)', created: r.act_created_at });
  }
  const byRail = new Map<string, number[]>();
  for (const f of first.values()) {
    const lat = Math.max(0, f.ts - f.created);
    const list = byRail.get(f.rail) ?? [];
    list.push(lat);
    byRail.set(f.rail, list);
  }
  const rails: RailStats[] = [...byRail.entries()]
    .map(([rail, lats]) => {
      const sorted = [...lats].sort((a, b) => a - b);
      const buckets: Record<string, number> = {};
      for (const [label] of BUCKETS) buckets[label] = 0;
      for (const l of sorted) buckets[bucketOf(l)] = (buckets[bucketOf(l)] ?? 0) + 1;
      return {
        rail,
        acts: sorted.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        under30s: sorted.length ? sorted.filter((l) => l < 30_000).length / sorted.length : 0,
        buckets,
      };
    })
    .sort((a, b) => b.acts - a.acts);
  return { rails, unparseable };
}

/** Criterion 2: refusals per seat, beside that seat's raises, by lease state and reason. */
export function refusalsBySeat(refused: RefusedRow[], raised: RaisedRow[]): SeatRefusals[] {
  const seats = new Map<string, SeatRefusals>();
  const get = (seat: string) => {
    let s = seats.get(seat);
    if (!s) {
      s = { seat, refusals: 0, raises: 0, byLease: {}, byReason: {} };
      seats.set(seat, s);
    }
    return s;
  };
  for (const r of refused) {
    const s = get(r.actor ?? '(none)');
    s.refusals++;
    let d: { lease?: string; reason?: string } = {};
    try {
      d = JSON.parse(r.detail ?? '{}') as typeof d;
    } catch {
      // counted in the refusal total; its shape is lost
    }
    const lease = d.lease ?? '(unrecorded)';
    const reason = d.reason ?? '(unrecorded)';
    s.byLease[lease] = (s.byLease[lease] ?? 0) + 1;
    s.byReason[reason] = (s.byReason[reason] ?? 0) + 1;
  }
  for (const r of raised) if (r.target) get(r.target).raises++;
  return [...seats.values()].sort((a, b) => b.refusals - a.refusals);
}

/** The §5 verdict, from the numbers alone. */
export function verdict(rails: RailStats[], raises: number, refusals: number): Summary['verdict'] {
  const why: string[] = [];
  if (raises > 0 && refusals / raises > 0.25)
    why.push(`refusals are ${Math.round((refusals / raises) * 100)}% of raises (limit 25%)`);
  if (raises === 0) why.push('no raises in the window — nothing to shrink against');
  for (const r of rails)
    if (r.p95Ms > 30_000 && r.under30s < 0.8)
      why.push(
        `${r.rail}: p95 ${Math.round(r.p95Ms / 1000)}s with ${Math.round(r.under30s * 100)}% under 30s`,
      );
  return { hold: why.length > 0, why };
}

/** ADR 511: a refusal whose reason is `not_joined` — the probing session had not claimed yet. */
function isNotJoined(r: RefusedRow): boolean {
  try {
    return (JSON.parse(r.detail ?? '{}') as { reason?: string }).reason === 'not_joined';
  } catch {
    return false;
  }
}

export function summarize(raised: RaisedRow[], refused: RefusedRow[]): Summary {
  const { rails, unparseable } = latencyByRail(raised);
  const acts = rails.reduce((s, r) => s + r.acts, 0);
  const notJoined = refused.filter(isNotJoined).length;
  return {
    acts,
    raises: raised.length,
    refusals: refused.length,
    notJoined,
    rails,
    seats: refusalsBySeat(refused, raised),
    unparseable,
    // ADR 511: a session that has not joined is not a deaf seat, so it does not hold the deferral.
    verdict: verdict(rails, raised.length, refused.length - notJoined),
  };
}

function read(
  dbPath: string,
  sinceMs: number | null,
): { raised: RaisedRow[]; refused: RefusedRow[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const raised = db
    .prepare(
      `SELECT a.ts, a.target, a.detail, m.created_at AS act_created_at
         FROM audit a
         LEFT JOIN messages m ON m.id = json_extract(a.detail, '$.act')
        WHERE a.action = 'interrupt.raised' AND (? IS NULL OR a.ts >= ?)
        ORDER BY a.ts`,
    )
    .all(sinceMs, sinceMs) as unknown as RaisedRow[];
  const refused = db
    .prepare(
      `SELECT ts, actor, detail FROM audit
        WHERE action = 'interrupt.refused' AND (? IS NULL OR ts >= ?)
        ORDER BY ts`,
    )
    .all(sinceMs, sinceMs) as unknown as RefusedRow[];
  db.close();
  return { raised, refused };
}

const secs = (ms: number) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}m`;

export function render(dbPath: string, days: number | null, s: Summary): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const out: string[] = [];
  out.push(
    'reach-and-boundaries §5 — delivery measurement (governs the attended-session deferral)',
  );
  out.push(`db ${dbPath}${days ? `  ·  last ${days}d` : '  ·  all time'}`);
  out.push(`baseline (${BASELINE.taken}): ${BASELINE.note}`);
  out.push('');
  out.push(
    `${s.acts} acts first-raised · ${s.raises} raise rows · ${s.refusals} refused probes` +
      (s.notJoined ? ` (${s.notJoined} not joined yet — outside the deaf ratio, ADR 511)` : ''),
  );
  out.push('');
  out.push('1+3. send → first raise, per rail (latency to the recipient’s next boundary; the');
  out.push('     >5m buckets are the idle-at-prompt wait the deferral trades against)');
  for (const r of s.rails) {
    const b = BUCKETS.map(([l]) => `${l} ${r.buckets[l] ?? 0}`).join(' · ');
    out.push(
      `  ${r.rail.padEnd(12)} ${String(r.acts).padStart(4)} acts · p50 ${secs(r.p50Ms)} · p95 ${secs(r.p95Ms)} · ` +
        `${pct(r.under30s)} under 30s   [${b}]`,
    );
  }
  out.push('');
  out.push('2.   deaf seats — refused probes (a live session whose bell is off), beside raises');
  for (const seat of s.seats.filter((x) => x.refusals > 0)) {
    const lease = Object.entries(seat.byLease)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const reason = Object.entries(seat.byReason)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    out.push(
      `  ${seat.seat.padEnd(10)} ${String(seat.refusals).padStart(4)} refused · ${String(seat.raises).padStart(4)} raised` +
        `   lease: ${lease}   reason: ${reason}`,
    );
  }
  if (s.unparseable) out.push(`  (${s.unparseable} raised rows had unparseable detail)`);
  out.push('');
  out.push(
    s.verdict.hold
      ? `VERDICT: HOLD the attended deferral at 10 min — ${s.verdict.why.join('; ')}`
      : 'VERDICT: the §5 criteria read clean — shrinking the deferral is now a lane with its own number',
  );
  return out.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 14;
  const dbPath = process.env['MUSTERD_DB'] ?? join(homedir(), '.musterd', 'musterd.db');
  const sinceMs = days > 0 ? Date.now() - days * 86_400_000 : null;
  const { raised, refused } = read(dbPath, sinceMs);
  const s = summarize(raised, refused);
  process.stdout.write(
    (json ? JSON.stringify({ db: dbPath, days, ...s }, null, 2) : render(dbPath, days, s)) + '\n',
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
