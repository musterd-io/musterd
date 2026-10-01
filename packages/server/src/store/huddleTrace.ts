import {
  deriveHuddles,
  HUDDLE_TRACE_MAX_EVENTS,
  HUDDLE_TRACE_MAX_WINDOW_MS,
  type Envelope,
  type HuddleTrace,
  type HuddleTraceEvent,
  type HuddleTraceSeat,
  type HuddleTraceWake,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { rowsToEnvelopes } from './hydrate.js';
import type { MessageRow } from './rows.js';

/**
 * The huddle trace (ADR 493): join a huddle's thread, the residency audit rows its acts caused, and
 * the seats' structural trace rows into one timeline. {@link assembleHuddleTrace} is the pure join
 * (everything that decides what the trace SAYS); {@link loadHuddleTrace} only fetches its inputs.
 */

/** One `audit` row, detail parsed. Only `residency.*` actions are read. */
export interface HuddleAuditRow {
  ts: number;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

/** One `trace_events` row's structural columns — never content or detail (ADR 493 §4). */
export interface HuddleTraceRow {
  ts: number;
  seat: string;
  harness: string;
  kind: string;
  tool_name: string | null;
  tool_use_id: string | null;
  outcome: string | null;
  duration_ms: number | null;
}

export interface HuddleTraceInputs {
  /** The root and its thread; rows from other threads are ignored. */
  thread: Envelope[];
  audit: HuddleAuditRow[];
  /** `wake_leases.spawned_at` by lease id. */
  spawnedAt: Map<string, number | null>;
  trace: HuddleTraceRow[];
  now: number;
}

const WAKE_ACTIONS = [
  'residency.wake_leased',
  'residency.woke',
  'residency.wake_failed',
  'residency.wake_deferred',
  'residency.wake_cost',
  'residency.session_captured',
] as const;

const TOOL_KINDS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SESSION_PHASE: Record<string, HuddleTraceEvent['phase']> = {
  SessionStart: 'started',
  UserPromptSubmit: 'prompted',
  Stop: 'stopped',
  SessionEnd: 'ended',
};
const SESSION_KINDS = new Set(Object.keys(SESSION_PHASE));

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function firstLine(body: string, max = 140): string {
  const line = body.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The window the trace covers: the open to the close, or to now while open — capped (ADR 493 §2). */
export function huddleWindow(openedAt: number, closedAt: number | undefined, now: number) {
  const cap = openedAt + HUDDLE_TRACE_MAX_WINDOW_MS;
  return { from: openedAt, to: Math.min(closedAt ?? now, cap) };
}

export function assembleHuddleTrace(inp: HuddleTraceInputs): HuddleTrace | null {
  const rootEnv = inp.thread.find((m) => m.thread === null || m.thread === undefined);
  if (!rootEnv) return null;
  const inThread = inp.thread.filter((m) => m.id === rootEnv.id || m.thread === rootEnv.id);
  const view = deriveHuddles(inThread, '').find((h) => h.id === rootEnv.id);
  if (!view) return null;

  const win = huddleWindow(view.openedAt, view.closed?.at, inp.now);
  const actIds = new Set(inThread.map((m) => m.id));
  const ordered = [...inThread].sort((a, b) =>
    a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts - b.ts,
  );

  // Seats, in the order they came into the room: opener, named at the root, steered, joined.
  const seats = new Map<
    string,
    { summoned: HuddleTraceSeat['summoned']; at: number; by: string | null }
  >();
  seats.set(view.opener, { summoned: 'opener', at: view.openedAt, by: view.id });
  for (const n of view.named)
    if (!seats.has(n)) seats.set(n, { summoned: 'named', at: view.openedAt, by: view.id });
  for (const m of ordered) {
    if (m.act === 'steer' && m.to.kind === 'member' && !seats.has(m.to.name)) {
      seats.set(m.to.name, { summoned: 'steered', at: m.ts, by: m.id });
    }
  }
  for (const t of view.turns)
    if (!seats.has(t.from)) seats.set(t.from, { summoned: 'joined', at: t.ts, by: null });

  // Wakes: a lease belongs to this huddle when the act it answers is in the thread.
  const audit = inp.audit.filter((a) => a.target !== null && seats.has(a.target));
  const leaseOf = new Map<string, string>(); // lease id → seat
  const wakes = new Map<string, HuddleTraceWake>(); // seat → wake
  for (const a of [...audit].sort((x, y) => x.ts - y.ts)) {
    if (a.action !== 'residency.wake_leased') continue;
    const lease = str(a.detail?.['lease_id']);
    const act = str(a.detail?.['act']);
    if (!lease || !act || !actIds.has(act) || wakes.has(a.target!)) continue;
    leaseOf.set(lease, a.target!);
    wakes.set(a.target!, {
      lease_id: lease,
      leased_at: a.ts,
      spawned_at: inp.spawnedAt.get(lease) ?? null,
      session: null,
      outcome: 'leased',
      duration_ms: null,
      cost_usd: null,
    });
  }

  const events: HuddleTraceEvent[] = [];
  const harnessOf = new Map<string, string>();
  for (const a of audit) {
    const lease = str(a.detail?.['lease_id']) ?? str(a.detail?.['wake_lease']);
    if (!lease || leaseOf.get(lease) !== a.target) continue;
    const seat = a.target!;
    const w = wakes.get(seat)!;
    switch (a.action) {
      case 'residency.wake_leased':
        events.push({ ts: a.ts, seat, kind: 'wake', phase: 'leased', label: 'wake leased' });
        break;
      case 'residency.woke': {
        const s = str(a.detail?.['session']);
        if (s === 'fresh' || s === 'resumed') w.session = s;
        if (w.outcome !== 'failed') w.outcome = 'woke';
        events.push({
          ts: a.ts,
          seat,
          kind: 'wake',
          phase: 'woke',
          label: s ? `woke · ${s}` : 'woke',
        });
        break;
      }
      case 'residency.wake_failed': {
        w.outcome = 'failed';
        const reason = str(a.detail?.['reason']);
        events.push({
          ts: a.ts,
          seat,
          kind: 'wake',
          phase: 'failed',
          label: reason ? `wake failed: ${reason}` : 'wake failed',
        });
        break;
      }
      case 'residency.wake_deferred':
        if (w.outcome === 'leased') w.outcome = 'deferred';
        events.push({ ts: a.ts, seat, kind: 'wake', phase: 'deferred', label: 'wake deferred' });
        break;
      case 'residency.wake_cost': {
        w.duration_ms = num(a.detail?.['duration_ms']);
        w.cost_usd = num(a.detail?.['cost_usd']);
        const parts = ['settled'];
        if (w.duration_ms !== null) parts.push(`${(w.duration_ms / 1000).toFixed(1)}s`);
        if (w.cost_usd !== null) parts.push(`$${w.cost_usd.toFixed(2)}`);
        events.push({ ts: a.ts, seat, kind: 'wake', phase: 'settled', label: parts.join(' · ') });
        break;
      }
      case 'residency.session_captured': {
        const h = str(a.detail?.['harness']);
        if (h && !harnessOf.has(seat)) harnessOf.set(seat, h);
        events.push({
          ts: a.ts,
          seat,
          kind: 'session',
          phase: 'captured',
          label: 'captured by its wake',
        });
        break;
      }
    }
  }

  // Acts: every act in the thread, the root and the close included.
  for (const m of ordered) {
    const to = m.act === 'steer' && m.to.kind === 'member' ? ` → ${m.to.name}` : '';
    events.push({
      ts: m.ts,
      seat: m.from,
      kind: 'act',
      label: `${m.act}${to}: ${firstLine(m.body)}`,
      act_id: m.id,
    });
  }

  // Structural trace rows for seats in the room, inside the window. A tool call shows once: its
  // completed row, or its PreToolUse when no completion was recorded (some harnesses tap only Pre).
  const rows = inp.trace.filter((r) => seats.has(r.seat) && r.ts >= win.from && r.ts <= win.to);
  const completed = new Set(
    rows
      .filter((r) => r.kind !== 'PreToolUse' && TOOL_KINDS.has(r.kind) && r.tool_use_id)
      .map((r) => r.tool_use_id),
  );
  for (const r of rows) {
    if (!harnessOf.has(r.seat)) harnessOf.set(r.seat, r.harness);
    if (TOOL_KINDS.has(r.kind)) {
      if (r.kind === 'PreToolUse' && r.tool_use_id && completed.has(r.tool_use_id)) continue;
      const name = r.tool_name ?? 'tool';
      events.push({
        ts: r.ts,
        seat: r.seat,
        kind: 'tool',
        label: name,
        tool_name: name,
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.duration_ms !== null ? { duration_ms: r.duration_ms } : {}),
      });
    } else if (r.kind === 'HookOutcome') {
      if (!r.outcome || r.outcome === 'ok') continue;
      events.push({
        ts: r.ts,
        seat: r.seat,
        kind: 'hook',
        label: `hook ${r.outcome}`,
        outcome: r.outcome,
        ...(r.duration_ms !== null ? { duration_ms: r.duration_ms } : {}),
      });
    } else if (SESSION_KINDS.has(r.kind)) {
      events.push({
        ts: r.ts,
        seat: r.seat,
        kind: 'session',
        phase: SESSION_PHASE[r.kind]!,
        label: r.kind,
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  const truncated = events.length > HUDDLE_TRACE_MAX_EVENTS;

  const seatRows: HuddleTraceSeat[] = [...seats].map(([seat, s]) => {
    const turn = view.turns.find((t) => t.from === seat);
    const first = seat === view.opener ? view.openedAt : (turn?.ts ?? null);
    const firstId = seat === view.opener ? view.id : (turn?.id ?? null);
    return {
      seat,
      harness: harnessOf.get(seat) ?? null,
      summoned: s.summoned,
      summoned_at: s.at,
      summoned_by: s.by,
      wake: wakes.get(seat) ?? null,
      first_turn_at: first,
      first_turn_act_id: firstId,
      time_to_turn_ms: first === null ? null : Math.max(0, first - s.at),
    };
  });

  return {
    huddle: {
      id: view.id,
      topic: view.topic,
      anchor: view.anchor,
      opener: view.opener,
      opened_at: view.openedAt,
      body: view.body,
      closed: view.closed
        ? { at: view.closed.at, by: view.closed.by, anchor_ref: view.closed.anchorRef ?? null }
        : null,
    },
    seats: seatRows,
    events: truncated ? events.slice(0, HUDDLE_TRACE_MAX_EVENTS) : events,
    truncated,
  };
}

/** Fetch {@link assembleHuddleTrace}'s inputs for one huddle. Null when the root is not a huddle. */
export async function loadHuddleTrace(
  db: Driver,
  traceDb: Driver,
  team: { id: string; slug: string },
  huddleId: string,
  now: number,
): Promise<HuddleTrace | null> {
  const rows = await db.all<MessageRow>(
    `SELECT * FROM messages WHERE team_id = ? AND (id = ? OR thread_id = ?) ORDER BY ts ASC, id ASC`,
    [team.id, huddleId, huddleId],
  );
  const root = rows.find((r) => r.id === huddleId);
  if (!root || root.thread_id !== null) return null;
  const thread = await rowsToEnvelopes(db, team.slug, rows);
  const closer = rows.find((r) => r.act === 'resolve');
  const win = huddleWindow(root.ts, closer?.ts, now);

  const placeholders = WAKE_ACTIONS.map(() => '?').join(',');
  const auditRows = await db.all<{
    ts: number;
    action: string;
    target: string | null;
    detail: string | null;
  }>(
    `SELECT ts, action, target, detail FROM audit
      WHERE team_id = ? AND ts >= ? AND ts <= ? AND action IN (${placeholders})
      ORDER BY ts ASC`,
    [team.id, win.from, win.to, ...WAKE_ACTIONS],
  );
  const audit: HuddleAuditRow[] = auditRows.map((a) => {
    let detail: Record<string, unknown> | null = null;
    try {
      detail = a.detail ? (JSON.parse(a.detail) as Record<string, unknown>) : null;
    } catch {
      detail = null;
    }
    return { ts: a.ts, action: a.action, target: a.target, detail };
  });

  const leaseIds = [
    ...new Set(
      audit
        .filter((a) => a.action === 'residency.wake_leased')
        .map((a) => str(a.detail?.['lease_id']))
        .filter((l): l is string => l !== undefined),
    ),
  ];
  const spawnedAt = new Map<string, number | null>();
  if (leaseIds.length > 0) {
    const leases = await db.all<{ id: string; spawned_at: number | null }>(
      `SELECT id, spawned_at FROM wake_leases WHERE team_id = ? AND id IN (${leaseIds.map(() => '?').join(',')})`,
      [team.id, ...leaseIds],
    );
    for (const l of leases) spawnedAt.set(l.id, l.spawned_at);
  }

  // Only the room's seats: the opener and named (the fold), anyone steered in, anyone who spoke.
  const view = deriveHuddles(thread, '').find((h) => h.id === huddleId);
  const seatNames = new Set<string>([...(view?.named ?? []), ...(view?.spoke ?? [])]);
  for (const m of thread) if (m.act === 'steer' && m.to.kind === 'member') seatNames.add(m.to.name);
  const seatList = [...seatNames];
  const trace =
    seatList.length === 0
      ? []
      : await traceDb.all<HuddleTraceRow>(
          `SELECT ts, seat, harness, kind, tool_name, tool_use_id, outcome, duration_ms
             FROM trace_events
            WHERE team_id = ? AND seat IN (${seatList.map(() => '?').join(',')}) AND ts >= ? AND ts <= ?
            ORDER BY ts ASC, seq ASC
            LIMIT ?`,
          [team.id, ...seatList, win.from, win.to, HUDDLE_TRACE_MAX_EVENTS * 4],
        );

  return assembleHuddleTrace({ thread, audit, spawnedAt, trace, now });
}
