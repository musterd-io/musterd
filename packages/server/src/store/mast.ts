import {
  MODEL_UNKNOWN,
  modelFamily,
  type CircularHandoff,
  type DiversityFlag,
  type MastBlock,
  type StalledThread,
  type TimeToUnblock,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { openDirectedLedger } from './delivery.js';

/**
 * The MAST-aware views (ADR 091; observability.md §5b) — the thread-shaped failure detectors over
 * the act log that nothing computed until now: time-to-unblock, stalled threads, circular
 * handoffs. Derived per query, never stored; windowed like coordination-density; diagnostic
 * instruments, never per-member scores (human-agent-dynamics §4). The other two §5b lenses are
 * served elsewhere and only referenced here: act-mix = coordinationDensity (ADR 050), ignored
 * request_help = the ADR 090 open directed ledger filtered by age.
 */

const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** A request_help unanswered this long is MAST's "ignored agent input". */
const IGNORED_HELP_MS = 60 * 60 * 1000;
/** A multi-act thread quiet this long with no resolve has stalled. */
const STALLED_MS = 24 * 60 * 60 * 1000;
/** Cap the lists — the report is a digest, not an export. */
const MAX_ENTRIES = 10;

/**
 * Time-to-unblock over loops *closed* in the window: an accept/decline naming a
 * request_help/handoff via meta.in_reply_to, or a resolve closing its thread root. The lived,
 * retroactive counterpart of the emitted loop_latency histogram.
 */
export async function timeToUnblock(
  db: Driver,
  teamId: string,
  now: number,
): Promise<TimeToUnblock> {
  const since = now - WINDOW_MS;
  const latencies = (
    await db.all<{ ms: number }>(
      // Three arms, not one join with an OR in its ON clause: that form made SQLite pair every closer
      // with every request in the team (~10 s of a cold /report on the Air, 23k messages). Each arm
      // seeks the opener by id or thread. A closer is accept/decline or resolve, never both, so the
      // arms never double-count; the last two arms split `COALESCE(o.thread_id, o.id)`.
      `SELECT (c.ts - o.ts) AS ms
         FROM messages c
         JOIN messages o ON o.id = c.in_reply_to AND o.team_id = c.team_id
        WHERE c.team_id = ? AND c.ts > ? AND c.act IN ('accept','decline')
          AND o.act IN ('request_help','handoff') AND c.ts >= o.ts
       UNION ALL
       SELECT (c.ts - o.ts) AS ms
         FROM messages c
         JOIN messages o ON o.thread_id = c.thread_id AND o.team_id = c.team_id
        WHERE c.team_id = ? AND c.ts > ? AND c.act = 'resolve' AND c.thread_id IS NOT NULL
          AND o.act IN ('request_help','handoff') AND c.ts >= o.ts
       UNION ALL
       SELECT (c.ts - o.ts) AS ms
         FROM messages c
         JOIN messages o ON o.id = c.thread_id AND o.thread_id IS NULL AND o.team_id = c.team_id
        WHERE c.team_id = ? AND c.ts > ? AND c.act = 'resolve' AND c.thread_id IS NOT NULL
          AND o.act IN ('request_help','handoff') AND c.ts >= o.ts`,
      [teamId, since, teamId, since, teamId, since],
    )
  )
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  const q = (p: number) =>
    latencies.length === 0
      ? null
      : latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!;
  return { closed: latencies.length, median_ms: q(0.5), p95_ms: q(0.95) };
}

/**
 * Stalled threads (MAST coordination breakdown): ≥ 2 acts on the thread, no resolve, quiet past
 * the threshold. Oldest-stall first, capped.
 */
export async function stalledThreads(
  db: Driver,
  teamId: string,
  now: number,
): Promise<StalledThread[]> {
  const rows = (
    await db.all<StalledThread & { last_ts: number }>(
      `SELECT m.thread_id AS thread,
              COUNT(*) AS acts,
              MAX(m.ts) AS last_ts,
              (SELECT m2.act FROM messages m2
                WHERE m2.team_id = m.team_id AND m2.thread_id = m.thread_id
                ORDER BY m2.ts DESC, m2.id DESC LIMIT 1) AS last_act,
              COUNT(DISTINCT m.from_member) AS participants
         FROM messages m
        WHERE m.team_id = ? AND m.thread_id IS NOT NULL AND m.ts > ?
        GROUP BY m.team_id, m.thread_id
       HAVING COUNT(*) >= 2
          AND SUM(CASE WHEN m.act = 'resolve' THEN 1 ELSE 0 END) = 0
          AND MAX(m.ts) < ?
        ORDER BY last_ts ASC`,
      [teamId, now - WINDOW_MS, now - STALLED_MS],
    )
  ).slice(0, MAX_ENTRIES);
  return rows.map((r) => ({
    thread: r.thread,
    acts: r.acts,
    last_act: r.last_act,
    participants: r.participants,
    quiet_ms: Math.max(0, now - r.last_ts),
  }));
}

/**
 * Circular handoffs (MAST step repetition): within one thread, a handoff whose recipient already
 * sent or received an earlier handoff in that thread — work going in circles (A→B→…→A).
 */
export async function circularHandoffs(
  db: Driver,
  teamId: string,
  now: number,
): Promise<CircularHandoff[]> {
  const rows = await db.all<{ thread: string; from_id: string; to_id: string | null; ts: number }>(
    `SELECT COALESCE(m.thread_id, m.id) AS thread, m.from_member AS from_id, m.to_member AS to_id, m.ts
         FROM messages m
        WHERE m.team_id = ? AND m.act = 'handoff' AND m.ts > ?
        ORDER BY thread, m.ts ASC`,
    [teamId, now - WINDOW_MS],
  );
  const out: CircularHandoff[] = [];
  let thread = '';
  let involved = new Set<string>();
  let hops = 0;
  for (const r of rows) {
    if (r.thread !== thread) {
      thread = r.thread;
      involved = new Set();
      hops = 0;
    }
    hops += 1;
    if (r.to_id && involved.has(r.to_id) && !out.some((c) => c.thread === thread)) {
      out.push({ thread, hops, ts: r.ts });
    }
    involved.add(r.from_id);
    if (r.to_id) involved.add(r.to_id);
  }
  return out.slice(0, MAX_ENTRIES);
}

/**
 * Model-diversity flags over review/approval chains (ADR 101): an accept/decline answering a
 * request_help/handoff/challenge (ADR 103) from a *different* seat is an agreement — and same-model agents agree in
 * correlated ways, so single-family agreement is weak evidence. Granularity is the model FAMILY
 * (the `claude-*` vs `gpt-*` prefix, derived server-side from the per-act stamp) — intra-family
 * variants are presumed correlated until the ADR 056 correlation research says otherwise. A chain
 * with an un-stamped act is `unverifiable` — honestly poisoned, never presumed diverse; a chain
 * whose known families all match is `flagged`; a cross-family chain is silent (the flag stays
 * scarce). Warn-never-block, watcher-not-gatekeeper.
 */
export async function diversityFlags(
  db: Driver,
  teamId: string,
  now: number,
): Promise<DiversityFlag[]> {
  const pairs = await db.all<{
    thread: string;
    kind: string;
    ts: number;
    opener: string;
    closer: string;
    opener_model: string | null;
    closer_model: string | null;
  }>(
    `SELECT COALESCE(o.thread_id, o.id) AS thread,
              o.act AS kind,
              c.ts AS ts,
              o.from_member AS opener,
              c.from_member AS closer,
              json_extract(o.meta, '$.model') AS opener_model,
              json_extract(c.meta, '$.model') AS closer_model
         FROM messages c
         JOIN messages o
           ON o.team_id = c.team_id
          AND o.act IN ('request_help','handoff','challenge')
          AND o.id = c.in_reply_to
        WHERE c.team_id = ? AND c.ts > ? AND c.act IN ('accept','decline')
          AND c.from_member != o.from_member
        ORDER BY c.ts ASC`,
    [teamId, now - WINDOW_MS],
  );

  // Aggregate per thread: one verdict per chain, over every answered pair on it.
  const chains = new Map<
    string,
    { kind: string; ts: number; members: Set<string>; families: Set<string>; unknown: boolean }
  >();
  for (const p of pairs) {
    const chain = chains.get(p.thread) ?? {
      kind: p.kind,
      ts: p.ts,
      members: new Set<string>(),
      families: new Set<string>(),
      unknown: false,
    };
    chain.ts = Math.max(chain.ts, p.ts);
    chain.members.add(p.opener).add(p.closer);
    for (const model of [p.opener_model, p.closer_model]) {
      const family = modelFamily(model);
      if (family === MODEL_UNKNOWN) chain.unknown = true;
      else chain.families.add(family);
    }
    chains.set(p.thread, chain);
  }

  const out: DiversityFlag[] = [];
  for (const [thread, chain] of chains) {
    const verdict = chain.unknown
      ? ('unverifiable' as const)
      : chain.families.size === 1
        ? ('flagged' as const)
        : null;
    if (verdict === null) continue; // cross-family agreement — diverse, silent
    const families = [...chain.families].sort();
    out.push({
      thread,
      kind: chain.kind,
      participants: chain.members.size,
      families,
      verdict,
      ts: chain.ts,
    });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
}

/**
 * Cross-team count of live diversity flags — the point-in-time value the `musterd.insight.diversity_flags`
 * gauge samples (ADR 101). A derived quantity, so it is *sampled* (a gauge), never accumulated per
 * report-derive (which would conflate scarcity with poll frequency). Cheap: teams are few and each
 * `diversityFlags` scan is windowed + capped.
 */
export async function countDiversityFlags(db: Driver, now: number = Date.now()): Promise<number> {
  const teams = await db.all<{ id: string }>('SELECT id FROM teams WHERE archived_at IS NULL');
  let n = 0;
  for (const t of teams) n += (await diversityFlags(db, t.id, now)).length;
  return n;
}

/**
 * Live diversity flags grouped by team slug (#207) — the per-team form of {@link countDiversityFlags}
 * for the `diversity_flags` observable gauge, so the gauge is queryable per team. Only teams with ≥1
 * live flag appear (a clean team is simply absent this cycle).
 */
export async function countDiversityFlagsByTeam(
  db: Driver,
  now: number = Date.now(),
): Promise<{ team: string; count: number }[]> {
  const teams = await db.all<{ id: string; slug: string }>(
    'SELECT id, slug FROM teams WHERE archived_at IS NULL',
  );
  const out: { team: string; count: number }[] = [];
  for (const t of teams) {
    const count = (await diversityFlags(db, t.id, now)).length;
    if (count > 0) out.push({ team: t.slug, count });
  }
  return out;
}

/** The whole mast block for the report (ADR 091). */
export async function deriveMast(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<MastBlock> {
  return {
    window_days: WINDOW_DAYS,
    time_to_unblock: await timeToUnblock(db, teamId, now),
    // MAST's ignored-input lens: the ADR 090 ledger filtered, not a second derivation.
    ignored_help: (await openDirectedLedger(db, teamId, now)).filter(
      (d) => d.act === 'request_help' && d.age_ms > IGNORED_HELP_MS,
    ),
    stalled_threads: await stalledThreads(db, teamId, now),
    circular_handoffs: await circularHandoffs(db, teamId, now),
    // ADR 101: single-family / unverifiable review-approval chains — agreement as weak evidence.
    diversity: await diversityFlags(db, teamId, now),
  };
}
