/**
 * The agent-style readout (ADR 514 Observability, spec §6) over the local daemon's database — the
 * thirty-day read as one command. Three cuts, each with its channel and denominator (ADR 294 §4),
 * no per-seat leaderboard:
 *
 *   1. length by dial — body length of `ask` / `message` / `handoff` addressed to each human, split
 *      by that human's `length` dial and by whether the act came before or after the dial was set;
 *   2. stance by style epoch — ADR 505's dispute cells (`summariseDisputes`) split by the team style
 *      epoch in force when the dispute opened, so an admin's floor change reads as a before/after;
 *   3. adoption — humans with any dial set / humans; live seats attesting their current epoch /
 *      live seats.
 *
 * What the record cannot give (and this says so rather than guessing): a sender's attested epoch AT
 * SEND TIME is not stored on the act, so cut 2 keys on the team's epoch timeline from `policy.change`
 * audit rows, and cut 1 keys on each human's dial-set time from `style.prefs_set` rows (the audit
 * row names the dial keys, never their values — the value is read from `members.style_prefs` now).
 *
 *   pnpm style:readout [--since YYYY-MM-DD] [--json]
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  type DisputeCell,
  type DisputeRow,
  type RawDisputeRow,
  type StyleDials,
  type StylePolicy,
  type StylePrefs,
  StylePolicySchema,
  StylePrefsSchema,
  fmtShare,
  resolveStyle,
  summariseDisputes,
  toDisputeRow,
} from '@musterd/protocol';

/** The acts cut 1 reads: the ones a seat composes FOR a human (spec §6), never status traffic. */
export const DIRECTED_ACTS = ['ask', 'message', 'handoff'] as const;

/** A live presence is one seen inside this window (the daemon's own presence timeout is shorter,
 *  but the roster's `out` cut-off is what a human reads; 15 minutes is the ADR 155 decay). */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

// ── Inputs (what the DB hands over; every pure function below takes these) ────────────────────

export interface HumanRow {
  name: string;
  prefs: StylePrefs;
}

export interface DirectedAct {
  ts: number;
  to: string;
  act: string;
  body_chars: number;
  /** Author kind — only agent-authored bodies are the style block's doing. */
  from_kind: string;
}

export interface PolicyChangeRow {
  ts: number;
  actor: string | null;
  /** `detail.style` of the stored doc, as written; absent = the style key was not in the doc. */
  style: unknown;
}

export interface PrefsSetRow {
  ts: number;
  actor: string | null;
  dials: string[];
}

export interface LivePresence {
  seat: string;
  kind: string;
  driver: string | null;
  style_epoch: string | null;
}

// ── Cut 2's timeline: the team epoch in force at each moment ──────────────────────────────────

export interface EpochPeriod {
  epoch: string;
  from: number;
  /** Exclusive; `null` = still in force. */
  to: number | null;
  set_by: string | null;
}

/** The shipped style's epoch — what every team ran before any admin touched `style`. */
export function shippedEpoch(): string {
  return resolveStyle(StylePolicySchema.parse({})).epoch;
}

/**
 * The team's style epoch over time, from `policy.change` rows (each carries the whole stored doc,
 * so `style` absent means the shipped style). Consecutive rows with the same epoch collapse into
 * one period — most policy writes touch other knobs.
 */
export function epochPeriods(changes: readonly PolicyChangeRow[]): EpochPeriod[] {
  const ordered = [...changes].sort((a, b) => a.ts - b.ts);
  const periods: EpochPeriod[] = [{ epoch: shippedEpoch(), from: 0, to: null, set_by: null }];
  for (const c of ordered) {
    const parsed = StylePolicySchema.safeParse(c.style ?? {});
    const epoch = resolveStyle(parsed.success ? parsed.data : StylePolicySchema.parse({})).epoch;
    const last = periods[periods.length - 1]!;
    if (epoch === last.epoch) continue;
    last.to = c.ts;
    periods.push({ epoch, from: c.ts, to: null, set_by: c.actor });
  }
  return periods;
}

export function periodAt(periods: readonly EpochPeriod[], ts: number): EpochPeriod {
  return periods.find((p) => ts >= p.from && (p.to === null || ts < p.to)) ?? periods[0]!;
}

// ── Cut 1: length by dial ─────────────────────────────────────────────────────────────────────

export interface LengthCell {
  n: number;
  median_chars: number | null;
  p75_chars: number | null;
}

export interface HumanLengthRead {
  human: string;
  dial: StyleDials['length'];
  /** When they last set `length` (from the audit); null = never set, so every act is baseline. */
  dial_set_at: number | null;
  before: LengthCell;
  after: LengthCell;
}

export interface LengthReadout {
  /** Agent-authored directed acts to any human, by the recipient's CURRENT dial. */
  by_dial: Record<StyleDials['length'], LengthCell>;
  per_human: HumanLengthRead[];
  /** Denominator carrier: every directed act counted, and the human-authored ones left out. */
  acts_counted: number;
  acts_human_authored: number;
}

/** Nearest-rank quantile: the value at rank ⌈q·n⌉ — a real body length, never an interpolation. */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const ix = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[ix]!;
}

function lengthCell(chars: readonly number[]): LengthCell {
  const sorted = [...chars].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median_chars: quantile(sorted, 0.5),
    p75_chars: quantile(sorted, 0.75),
  };
}

/** When each human last set their `length` dial — the latest `style.prefs_set` row naming it. */
export function lengthDialSetAt(rows: readonly PrefsSetRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.actor || !r.dials.includes('length')) continue;
    out.set(r.actor, Math.max(out.get(r.actor) ?? 0, r.ts));
  }
  return out;
}

export function lengthByDial(
  acts: readonly DirectedAct[],
  humans: readonly HumanRow[],
  prefsSet: readonly PrefsSetRow[],
  policy: StylePolicy,
): LengthReadout {
  const setAt = lengthDialSetAt(prefsSet);
  const byDial: Record<StyleDials['length'], number[]> = { concise: [], normal: [], thorough: [] };
  const perHuman: HumanLengthRead[] = [];
  let counted = 0;
  let humanAuthored = 0;
  for (const h of humans) {
    const dial = h.prefs.length ?? policy.defaults.length;
    const at = setAt.get(h.name) ?? null;
    const before: number[] = [];
    const after: number[] = [];
    for (const a of acts) {
      if (a.to !== h.name) continue;
      if (a.from_kind !== 'agent') {
        humanAuthored++;
        continue;
      }
      counted++;
      byDial[dial].push(a.body_chars);
      (at !== null && a.ts >= at ? after : before).push(a.body_chars);
    }
    perHuman.push({
      human: h.name,
      dial,
      dial_set_at: at,
      before: lengthCell(before),
      after: lengthCell(after),
    });
  }
  return {
    by_dial: {
      concise: lengthCell(byDial.concise),
      normal: lengthCell(byDial.normal),
      thorough: lengthCell(byDial.thorough),
    },
    per_human: perHuman,
    acts_counted: counted,
    acts_human_authored: humanAuthored,
  };
}

// ── Cut 2: stance by epoch ────────────────────────────────────────────────────────────────────

export interface StanceByEpoch {
  period: EpochPeriod;
  /** `summariseDisputes(...).total` over the disputes opened inside the period. */
  cell: DisputeCell;
}

export function stanceByEpoch(
  rows: readonly DisputeRow[],
  periods: readonly EpochPeriod[],
  since: number,
): StanceByEpoch[] {
  return periods
    .filter((p) => p.to === null || p.to > since)
    .map((p) => {
      const inPeriod = rows.filter((r) => periodAt(periods, r.ts) === p);
      return { period: p, cell: summariseDisputes(inPeriod, Math.max(since, p.from)).total };
    });
}

// ── Cut 3: adoption ───────────────────────────────────────────────────────────────────────────

export interface AdoptionReadout {
  humans: number;
  humans_with_a_dial: number;
  live_seats: number;
  /** … attesting the epoch their driver's (or the team's) style resolves to right now. */
  live_seats_current: number;
  live_seats_unattested: number;
}

/** The epoch a seat should attest now — the `/style-block` driver rule (server `styleEnvelopeFrom`). */
export function currentEpochFor(
  policy: StylePolicy,
  humans: readonly HumanRow[],
  driver: string | null,
): string {
  const named = driver ? humans.find((h) => h.name === driver) : undefined;
  const chosen = named ?? (humans.length === 1 ? humans[0] : undefined);
  return resolveStyle(policy, chosen?.prefs).epoch;
}

export function adoption(
  humans: readonly HumanRow[],
  live: readonly LivePresence[],
  policy: StylePolicy,
): AdoptionReadout {
  const agents = live.filter((p) => p.kind === 'agent');
  let current = 0;
  let unattested = 0;
  for (const p of agents) {
    if (!p.style_epoch) unattested++;
    else if (p.style_epoch === currentEpochFor(policy, humans, p.driver)) current++;
  }
  return {
    humans: humans.length,
    humans_with_a_dial: humans.filter((h) =>
      (['pushback', 'bluntness', 'length', 'format', 'prose'] as const).some(
        (k) => h.prefs[k] !== undefined,
      ),
    ).length,
    live_seats: agents.length,
    live_seats_current: current,
    live_seats_unattested: unattested,
  };
}

// ── The falsifier (ADR 514 Observability → Experiment) ────────────────────────────────────────

export type Verdict = 'met' | 'not-met' | 'inconclusive';

export interface FalsifierRead {
  /** No human has set a dial. */
  no_dial_set: boolean;
  /** `concise` recipients' bodies are not shorter than `normal` recipients' (medians, n ≥ 5 each). */
  length_split: Verdict;
  verdict: Verdict;
}

export function falsifier(length: LengthReadout, adopt: AdoptionReadout): FalsifierRead {
  const noDial = adopt.humans_with_a_dial === 0;
  const c = length.by_dial.concise;
  const n = length.by_dial.normal;
  let split: Verdict = 'inconclusive';
  if (c.n >= 5 && n.n >= 5 && c.median_chars !== null && n.median_chars !== null) {
    split = c.median_chars < n.median_chars ? 'not-met' : 'met';
  }
  return {
    no_dial_set: noDial,
    length_split: split,
    verdict: noDial ? 'met' : split,
  };
}

// ── Loading ───────────────────────────────────────────────────────────────────────────────────

export interface Loaded {
  policy: StylePolicy;
  humans: HumanRow[];
  acts: DirectedAct[];
  disputes: DisputeRow[];
  changes: PolicyChangeRow[];
  prefs_set: PrefsSetRow[];
  live: LivePresence[];
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function load(dbPath: string, team: string, sinceMs: number, now = Date.now()): Loaded {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const teamRow = db.prepare('SELECT id, policy FROM teams WHERE slug = ?').get(team) as
      | { id: string; policy: string | null }
      | undefined;
    if (!teamRow) throw new Error(`no team "${team}" in ${dbPath}`);
    const stored = parseJson(teamRow.policy) ?? {};
    const policyParsed = StylePolicySchema.safeParse(stored['style'] ?? {});
    const policy = policyParsed.success ? policyParsed.data : StylePolicySchema.parse({});

    const humans = (
      db
        .prepare(
          `SELECT name, style_prefs FROM members
            WHERE team_id = ? AND kind = 'human' AND observer = 0 AND left_at IS NULL
            ORDER BY created_at`,
        )
        .all(teamRow.id) as { name: string; style_prefs: string | null }[]
    ).map((m) => ({
      name: m.name,
      prefs: StylePrefsSchema.safeParse(parseJson(m.style_prefs) ?? {}).data ?? {},
    }));

    const acts = (
      db
        .prepare(
          `SELECT m.ts AS ts, toM.name AS to_name, m.act AS act, length(m.body) AS body_chars,
                  fromM.kind AS from_kind
             FROM messages m
             JOIN members toM ON toM.id = m.to_member
             JOIN members fromM ON fromM.id = m.from_member
            WHERE m.team_id = ? AND m.ts >= ? AND m.to_kind = 'member' AND toM.kind = 'human'
              AND m.act IN ('ask','message','handoff')
            ORDER BY m.ts`,
        )
        .all(teamRow.id, sinceMs) as {
        ts: number;
        to_name: string;
        act: string;
        body_chars: number;
        from_kind: string;
      }[]
    ).map((r) => ({
      ts: r.ts,
      to: r.to_name,
      act: r.act,
      body_chars: r.body_chars,
      from_kind: r.from_kind,
    }));

    // The same rows ADR 505's readout reads (`sycophancy-readout.ts`), team-scoped.
    const disputes = (
      db
        .prepare(
          `SELECT r.id AS id, mem.name AS seat, mem.kind AS kind, r.act AS act, r.body AS body,
                  r.meta AS meta, r.in_reply_to AS inReplyTo, r.ts AS ts,
                  p.act AS parentAct, p.meta AS parentMeta
             FROM messages r
             JOIN members mem ON mem.id = r.from_member
             LEFT JOIN messages p ON p.id = r.in_reply_to
            WHERE r.team_id = ? AND r.ts >= ? AND r.act IN ('challenge','decline','accept','ask')
            ORDER BY r.ts, r.id`,
        )
        .all(teamRow.id, sinceMs) as unknown as RawDisputeRow[]
    ).map(toDisputeRow);

    const changes = (
      db
        .prepare(
          `SELECT ts, actor, detail FROM audit
            WHERE team_id = ? AND action = 'policy.change' AND result = 'allow' ORDER BY ts`,
        )
        .all(teamRow.id) as { ts: number; actor: string | null; detail: string | null }[]
    ).map((r) => ({ ts: r.ts, actor: r.actor, style: parseJson(r.detail)?.['style'] }));

    const prefsSet = (
      db
        .prepare(
          `SELECT ts, actor, detail FROM audit
            WHERE team_id = ? AND action = 'style.prefs_set' AND result = 'allow' ORDER BY ts`,
        )
        .all(teamRow.id) as { ts: number; actor: string | null; detail: string | null }[]
    ).map((r) => {
      const dials = parseJson(r.detail)?.['dials'];
      return {
        ts: r.ts,
        actor: r.actor,
        dials: Array.isArray(dials) ? dials.filter((d): d is string => typeof d === 'string') : [],
      };
    });

    const live = db
      .prepare(
        `SELECT mem.name AS seat, mem.kind AS kind, p.driver AS driver, p.style_epoch AS style_epoch
           FROM presence p JOIN members mem ON mem.id = p.member_id
          WHERE mem.team_id = ? AND p.held_until IS NULL AND p.last_seen_at >= ?
          ORDER BY p.last_seen_at DESC`,
      )
      .all(teamRow.id, now - LIVE_WINDOW_MS) as unknown as LivePresence[];
    // One row per seat: its newest live presence (the roster's `presences[0]`).
    const seen = new Set<string>();
    const newest = live.filter((p) => (seen.has(p.seat) ? false : (seen.add(p.seat), true)));

    return { policy, humans, acts, disputes, changes, prefs_set: prefsSet, live: newest };
  } finally {
    db.close();
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

const day = (ts: number | null, whenNull = 'now') =>
  ts === null ? whenNull : new Date(ts).toISOString().slice(0, 10);
const cellText = (c: LengthCell) =>
  c.n === 0
    ? 'n 0'
    : `n ${String(c.n).padEnd(4)} median ${String(c.median_chars).padEnd(5)} p75 ${String(c.p75_chars)}`;

function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = args[args.indexOf('--since') + 1];
  const since = args.includes('--since') && sinceArg ? Date.parse(sinceArg) : 0;
  if (Number.isNaN(since)) throw new Error(`--since: not a date: ${sinceArg}`);
  const teamIx = args.indexOf('--team');
  const team = teamIx >= 0 ? (args[teamIx + 1] ?? 'revive') : 'revive';
  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');

  const d = load(dbPath, team, since);
  const periods = epochPeriods(d.changes);
  const length = lengthByDial(d.acts, d.humans, d.prefs_set, d.policy);
  const stance = stanceByEpoch(d.disputes, periods, since);
  const adopt = adoption(d.humans, d.live, d.policy);
  const fals = falsifier(length, adopt);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          db: dbPath,
          team,
          since: since || null,
          periods,
          length,
          stance,
          adoption: adopt,
          falsifier: fals,
        },
        null,
        2,
      ),
    );
    return;
  }
  const cut = since ? `since ${day(since)}` : 'all time';
  console.log(`=== ADR 514 agent-style readout (${team}, ${cut}) ===`);
  console.log(
    '  every number carries its channel and denominator (ADR 294 §4); % only at n ≥ 5; no seat is scored.',
  );

  console.log(
    `\n  1. length by dial — agent-authored ask/message/handoff TO a human, chars of body, by the recipient's CURRENT length dial` +
      `\n     (channel: messages.to_member → humans; ${String(length.acts_counted)} acts counted, ${String(length.acts_human_authored)} human-authored left out):`,
  );
  for (const dial of ['concise', 'normal', 'thorough'] as const) {
    console.log(`     ${dial.padEnd(9)} ${cellText(length.by_dial[dial])}`);
  }
  console.log(
    '     per human — before / after the day they last set `length` (never set ⇒ all before):',
  );
  for (const h of length.per_human) {
    console.log(
      `     ${h.human.padEnd(10)} ${h.dial.padEnd(9)} set ${day(h.dial_set_at, 'never').padEnd(10)} before ${cellText(h.before).padEnd(34)} after ${cellText(h.after)}`,
    );
  }

  console.log(
    '\n  2. stance by team style epoch — ADR 505 dispute cells, by the epoch in force when the dispute opened' +
      "\n     (channel: challenge / lane-review / dependency disputes in messages; the sender's own epoch at send time is not recorded):",
  );
  for (const s of stance) {
    const c = s.cell;
    console.log(
      `     ${s.period.epoch} ${day(s.period.from)} → ${day(s.period.to).padEnd(10)} ${s.period.set_by ? `set by ${s.period.set_by}` : 'shipped'}` +
        `\n       opened ${String(c.opened).padEnd(4)} answered ${String(c.answered).padEnd(4)} conceded ${String(c.conceded).padEnd(4)} held ${String(c.held).padEnd(4)} ` +
        `named a check ${fmtShare(c.named_check, c.answered)} · declined ${fmtShare(c.held, c.answered)}`,
    );
  }

  console.log(
    `\n  3. adoption — humans with any dial set ${String(adopt.humans_with_a_dial)} / ${String(adopt.humans)}` +
      ` · live agent seats attesting their current epoch ${String(adopt.live_seats_current)} / ${String(adopt.live_seats)}` +
      ` (${String(adopt.live_seats_unattested)} attest nothing — an older adapter, not a stale one)`,
  );

  console.log(
    `\n  Falsifier (ADR 514 Experiment, read 30 days after inc 3 = 2026-11-04): no human has set a dial → ${fals.no_dial_set ? 'YES' : 'no'};` +
      ` concise median < normal median (n ≥ 5 each) → ${fals.length_split}.` +
      `\n  Verdict: ${fals.verdict.toUpperCase()}` +
      (fals.verdict === 'met'
        ? ' — the block has no standing with the models; harness-native renderers (spec §2) are the next increment.'
        : fals.verdict === 'not-met'
          ? ' — the dial moves what reaches the human.'
          : ' — not enough directed acts under a set dial to decide.'),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
