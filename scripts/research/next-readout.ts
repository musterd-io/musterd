/**
 * The up-next relevance readout (ADR 536 Observability, spec §6) over the local daemon's database —
 * does the per-member ranking get picked up more than the oldest-first order it replaced?
 *
 * WHAT IT READS. Every orientation brief read writes a `next.offer` audit row (increment 3): the
 * five lanes offered with their tier, the five the PRE-ADR-536 rule would have served from the same
 * board (`baseline`), and the two pool counts. A pickup is the existing `lane.claimed` row with
 * `kind: 'claim'` (a handoff is not a pickup — the lane was chosen for the seat, not by it). The two
 * are joined by actor: a claim counts against the actor's newest offer in the hour before it.
 *
 * THE CUTS, each with its channel and denominator (ADR 294 §4), no per-seat leaderboard:
 *   1. hit rate — claims whose lane was in the offered window / claims that had an offer in the
 *      hour before, by rank; and the same claims scored against the baseline window;
 *   2. tier yield — of the ranked hits, which tier placed the lane (the number that says whether
 *      `role` is worth nudging for — spec §2);
 *   3. window honesty — share of brief reads where the pool was deeper than the window
 *      (`total > 5`), i.e. how often the "N of M claimable" line is doing work.
 *
 * THE VERDICT RULE (spec §6.3, ADR 536 Experiment), fixed here so the read cannot be argued into
 * either answer afterwards: fourteen days after increment 1 landed on revive (2026-10-06 →
 * 2026-10-20), with n ≥ 5 claims that had an offer, ranked hit rate ABOVE baseline keeps the tiers;
 * at or below reverts decision 3 and keeps the exclusion and counts. Fewer than 5 is `insufficient`.
 *
 * READ-ONLY over `~/.musterd/musterd.db` (or `MUSTERD_DB`) plus the ADR 478 archive beside it
 * (`<db dir>/archive/audit-YYYY-MM.jsonl.gz`) — `next.offer` is churn class and leaves the live
 * store after 5 days, so a 14-day read needs both. Touches no lane, no seat, no daemon.
 *
 *   pnpm next:readout [--since YYYY-MM-DD] [--team <slug>] [--json]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** A claim counts against an offer at most this long before it (spec §6.1). */
export const PICKUP_WINDOW_MS = 60 * 60 * 1000;
/** The window size the brief serves — `up_next` is cut at five (ADR 536 §4.5). */
export const WINDOW = 5;
/** When the 14-day read is due: increment 1 landed on revive 2026-10-06 (#2160). */
export const READ_DUE = '2026-10-20';

// ── Inputs (what the DB hands over; every pure function below takes these) ────────────────────

export interface OfferRow {
  ts: number;
  actor: string;
  offered: { lane: string; tier: number }[];
  baseline: string[];
  total: number;
  blocked_total: number;
}

export interface ClaimRow {
  ts: number;
  actor: string;
  lane: string;
}

// ── Pure halves ───────────────────────────────────────────────────────────────────────────────

export interface Pickup {
  claim: ClaimRow;
  /** The actor's newest offer inside the window before the claim; null when none. */
  offer: OfferRow | null;
  /** 1-based rank in the offered window, null when not offered (or no offer). */
  ranked_rank: number | null;
  /** 1-based rank in the baseline window, null when absent. */
  baseline_rank: number | null;
  /** The tier that placed a ranked hit; null otherwise. */
  tier: number | null;
}

/** Join each claim to the actor's newest offer within {@link PICKUP_WINDOW_MS} before it. */
export function matchPickups(
  offers: readonly OfferRow[],
  claims: readonly ClaimRow[],
  windowMs = PICKUP_WINDOW_MS,
): Pickup[] {
  const byActor = new Map<string, OfferRow[]>();
  for (const o of offers) (byActor.get(o.actor) ?? byActor.set(o.actor, []).get(o.actor)!).push(o);
  for (const list of byActor.values()) list.sort((a, b) => a.ts - b.ts);
  return claims.map((claim) => {
    const candidates = byActor.get(claim.actor) ?? [];
    let offer: OfferRow | null = null;
    for (const o of candidates) {
      if (o.ts > claim.ts) break;
      if (claim.ts - o.ts <= windowMs) offer = o;
    }
    if (!offer) return { claim, offer: null, ranked_rank: null, baseline_rank: null, tier: null };
    const ri = offer.offered.findIndex((x) => x.lane === claim.lane);
    const bi = offer.baseline.indexOf(claim.lane);
    return {
      claim,
      offer,
      ranked_rank: ri >= 0 ? ri + 1 : null,
      baseline_rank: bi >= 0 ? bi + 1 : null,
      tier: ri >= 0 ? offer.offered[ri]!.tier : null,
    };
  });
}

export interface Readout {
  offers: number;
  /** Brief reads whose claimable pool was deeper than the window. */
  offers_deeper_than_window: number;
  claims: number;
  claims_with_offer: number;
  ranked_hits: number;
  baseline_hits: number;
  /** Hits by 1-based rank, ranked and baseline. */
  ranked_by_rank: number[];
  baseline_by_rank: number[];
  /** Ranked hits by the tier that placed the lane (index = tier, 1–5). */
  tier_yield: number[];
  verdict: 'met' | 'not-met' | 'insufficient';
}

/** The three cuts and the verdict, from the joined pickups. `met` = the falsifier fired. */
export function summarise(offers: readonly OfferRow[], pickups: readonly Pickup[]): Readout {
  const withOffer = pickups.filter((p) => p.offer !== null);
  const ranked_by_rank = new Array<number>(WINDOW).fill(0);
  const baseline_by_rank = new Array<number>(WINDOW).fill(0);
  const tier_yield = new Array<number>(6).fill(0);
  for (const p of withOffer) {
    if (p.ranked_rank !== null && p.ranked_rank <= WINDOW) ranked_by_rank[p.ranked_rank - 1]!++;
    if (p.baseline_rank !== null && p.baseline_rank <= WINDOW)
      baseline_by_rank[p.baseline_rank - 1]!++;
    if (p.tier !== null) tier_yield[p.tier]!++;
  }
  const ranked_hits = withOffer.filter((p) => p.ranked_rank !== null).length;
  const baseline_hits = withOffer.filter((p) => p.baseline_rank !== null).length;
  const n = withOffer.length;
  const verdict: Readout['verdict'] =
    n < 5 ? 'insufficient' : ranked_hits > baseline_hits ? 'not-met' : 'met';
  return {
    offers: offers.length,
    offers_deeper_than_window: offers.filter((o) => o.total > WINDOW).length,
    claims: pickups.length,
    claims_with_offer: n,
    ranked_hits,
    baseline_hits,
    ranked_by_rank,
    baseline_by_rank,
    tier_yield,
    verdict,
  };
}

/** `k of n (p%)` — the % only at n ≥ 5 (ADR 294 §4: no bare rates on tiny denominators). */
export function share(k: number, n: number): string {
  if (n === 0) return '0 of 0';
  return n >= 5
    ? `${String(k)} of ${String(n)} (${String(Math.round((100 * k) / n))}%)`
    : `${String(k)} of ${String(n)}`;
}

// ── Loading (the only impure half) ────────────────────────────────────────────────────────────

interface RawRow {
  ts: number;
  actor: string | null;
  action: string;
  detail: string | null;
}

/** Parse one audit row into an offer or a claim; null for anything else or a malformed detail. */
export function classify(r: RawRow): { offer: OfferRow } | { claim: ClaimRow } | null {
  if (!r.actor || !r.detail) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(r.detail) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (r.action === 'next.offer') {
    const offered = Array.isArray(d['offered']) ? (d['offered'] as OfferRow['offered']) : [];
    const baseline = Array.isArray(d['baseline']) ? (d['baseline'] as string[]) : [];
    return {
      offer: {
        ts: r.ts,
        actor: r.actor,
        offered,
        baseline,
        total: typeof d['total'] === 'number' ? d['total'] : 0,
        blocked_total: typeof d['blocked_total'] === 'number' ? d['blocked_total'] : 0,
      },
    };
  }
  if (r.action === 'lane.claimed' && d['kind'] === 'claim' && typeof d['lane'] === 'string')
    return { claim: { ts: r.ts, actor: r.actor, lane: d['lane'] } };
  return null;
}

function loadLive(dbPath: string, team: string, since: number): RawRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT a.ts, a.actor, a.action, a.detail FROM audit a
           JOIN teams t ON t.id = a.team_id
          WHERE t.slug = ? AND a.action IN ('next.offer', 'lane.claimed') AND a.ts >= ?
          ORDER BY a.ts`,
      )
      .all(team, since) as unknown as RawRow[];
  } finally {
    db.close();
  }
}

/** The ADR 478 archive beside the db: gzip members of JSON lines, one file per month. */
function loadArchive(dbPath: string, teamId: string | null, since: number): RawRow[] {
  const dir = join(dirname(dbPath), 'archive');
  if (!existsSync(dir) || teamId === null) return [];
  const out: RawRow[] = [];
  for (const f of readdirSync(dir)
    .filter((n) => /^audit-\d{4}-\d{2}\.jsonl\.gz$/.test(n))
    .sort()) {
    const text = gunzipSync(readFileSync(join(dir, f))).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as RawRow & { team_id?: string };
        if (r.team_id === teamId && r.action === 'next.offer' && r.ts >= since)
          out.push({ ts: r.ts, actor: r.actor, action: r.action, detail: r.detail });
      } catch {
        // a torn line is not evidence
      }
    }
  }
  return out;
}

function teamIdOf(dbPath: string, team: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT id FROM teams WHERE slug = ?').get(team) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

export function load(dbPath: string, team: string, since: number) {
  const rows = [
    ...loadArchive(dbPath, teamIdOf(dbPath, team), since),
    ...loadLive(dbPath, team, since),
  ];
  const offers: OfferRow[] = [];
  const claims: ClaimRow[] = [];
  for (const r of rows) {
    const c = classify(r);
    if (!c) continue;
    if ('offer' in c) offers.push(c.offer);
    else claims.push(c.claim);
  }
  return { offers, claims };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = args[args.indexOf('--since') + 1];
  const since = args.includes('--since') && sinceArg ? Date.parse(sinceArg) : 0;
  if (Number.isNaN(since)) throw new Error(`--since: not a date: ${sinceArg}`);
  const teamIx = args.indexOf('--team');
  const team = teamIx >= 0 ? (args[teamIx + 1] ?? 'revive') : 'revive';
  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');

  const { offers, claims } = load(dbPath, team, since);
  const pickups = matchPickups(offers, claims);
  const r = summarise(offers, pickups);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ db: dbPath, team, since: since || null, ...r }, null, 2));
    return;
  }
  const cut = since ? `since ${day(since)}` : 'all time';
  console.log(`=== ADR 536 up-next relevance readout (${team}, ${cut}) ===`);
  console.log(
    '  every number carries its channel and denominator (ADR 294 §4); % only at n ≥ 5; no seat is scored.',
  );
  console.log(
    `\n  1. hit rate — a claim whose lane was in the window offered to that seat within the hour before` +
      `\n     (channel: audit next.offer × lane.claimed kind=claim, same actor; ${String(r.claims)} claims, ${String(r.claims_with_offer)} had an offer):`,
  );
  console.log(
    `     ranked   ${share(r.ranked_hits, r.claims_with_offer)}  by rank ${r.ranked_by_rank.join(' / ')}`,
  );
  console.log(
    `     baseline ${share(r.baseline_hits, r.claims_with_offer)}  by rank ${r.baseline_by_rank.join(' / ')}  (oldest-first, goal-attached first, no exclusion)`,
  );
  console.log(
    `\n  2. tier yield — of the ${String(r.ranked_hits)} ranked hits, the tier that placed the lane` +
      `\n     (1 human pointer · 2 role · 3 goal motion · 4 scope familiarity · 5 rest):`,
  );
  console.log(
    `     ${[1, 2, 3, 4, 5].map((t) => `t${String(t)}=${String(r.tier_yield[t])}`).join('  ')}`,
  );
  console.log(
    `\n  3. window honesty — brief reads whose claimable pool was deeper than the window of ${String(WINDOW)}` +
      `\n     (channel: next.offer.total): ${share(r.offers_deeper_than_window, r.offers)}`,
  );
  console.log(
    `\n  Falsifier (ADR 536 Experiment, read on ${READ_DUE}): ranked hit rate at or below baseline with n ≥ 5 → ` +
      `${r.verdict === 'met' ? 'YES' : r.verdict === 'not-met' ? 'no' : 'not yet decidable'}.` +
      `\n  Verdict: ${r.verdict.toUpperCase()}` +
      (r.verdict === 'met'
        ? ' — revert the tiers (ADR 536 decision 3); keep the exclusion and the counts.'
        : r.verdict === 'not-met'
          ? ' — the ranking is picked up more than the order it replaced; it stays.'
          : ` — fewer than 5 claims had an offer in the hour before; keep collecting (${String(r.claims_with_offer)} so far).`),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
