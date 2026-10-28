import { isAwaitingAcceptance } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { isHuddleTurnAct, listRenderedActs } from './audit.js';
import { handoffNamedLaneOutOfPlay } from './delivery.js';
import type { MessageRow } from './rows.js';

/** ADR 750 follow-up (lane 01M61STFBF): a seat whose cursor has not moved in months still scans
 *  its whole unread window on every poll. Interrupts older than this are not worth a wake — the
 *  seat will catch up when it reads. Bounding the window keeps the scan to recent rows. Applied
 *  only when the caller passes `now` (and `maxLookbackMs`); callers that omit them keep the
 *  unbounded read, so the equality contract with the unnarrowed read still holds. */
export const INTERRUPT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The unread rows `pendingInterrupts` can actually use — everything else in the window is inert.
 *
 * WHY A NARROWED READ RATHER THAN A FASTER FOLD. `/inbox/interrupt-check` is the most frequently
 * served route in the system: a PostToolUse hook calls it at every tool boundary of every live agent,
 * and it is documented sub-50ms. It used to read the seat's whole unread window. After #909 removed
 * the per-row member lookups, what was left was the query itself — `SELECT *` marshalling 6000 rows
 * into JS costs 10.7ms, against 0.7ms to hydrate them and 0.4ms to fold them. The fold was never the
 * problem; the row count was. Narrowed, the same read is 1.2ms and stops scaling with how far behind
 * the seat's cursor has fallen.
 *
 * THE PREDICATE IS THE FOLD'S OWN, READ OFF IT. `pendingInterrupts` returns an act only if it is
 * `meta.urgent`, a `steer`, an obligation (`ask` carrying the daemon-set `meta.lane_review`), a
 * turn in an open huddle this seat is in (ADR 378), or — on the wake rail under the ADR 271 §4
 * knobs — the daemon's incident route/resolve notice (`meta.incident.routed_to` / `resolved_by`). It
 * can SUPPRESS one only via `resolve` (which closes a thread), `accept`/`decline` (which discharge
 * by `meta.in_reply_to`), or the seat's OWN reply — by `in_reply_to` on any act, or a later turn in
 * the steer's thread (ADR 434; fetched below, since own sends never come from the window). It can
 * REDIRECT one only via `meta.eligible`, which replaces the default
 * obligation rule. Nothing else it reads can change its answer, so admitting exactly these shapes
 * leaves the answer identical — which is what `interruptCandidates.test.ts` asserts against the
 * unnarrowed read, over a corpus built to contain every one of them.
 *
 * Own suppress acts are a second query: the inbox window is `from_member != me`, and an
 * accept/decline is a DM to the asker, so neither filter would keep the row that discharges a
 * self-answered obligation. The huddle path already fetches "mine" for the same reason.
 *
 * The `meta` predicates are `json_extract` and therefore unindexed: this still SCANS the window, it
 * just stops carrying it back. That is the whole win, and it is why the cost is now a function of the
 * window's size in SQLite rather than of its size in V8.
 *
 * THE TEXT GUARD IN FRONT. On Postgres each `json_extract` is a `meta::jsonb` parse, per row, per
 * predicate — a seat whose cursor never moves re-parsed the team's whole history at every tool
 * boundary (staging 2026-10-06: 48 ms mean under load, 0 rows ever; lane 01M49C6CHW). The first
 * block is a necessary condition, never a sufficient one: a key cannot be present unless its quoted
 * name is in the stored JSON text (`JSON.stringify` writes these ASCII keys literally), and `LIKE`'s
 * `_` wildcard and SQLite's case-folding only widen it. So it drops rows cheaply and the exact block
 * below still decides. The huddle-root lookup is pinned to the team for the same reason: inside an
 * OR, Postgres turned the EXISTS into a hashed subplan over every tenant's messages.
 *
 * Keep this in step with `pendingInterrupts`, in BOTH blocks — a new meta key goes in the text guard
 * as well as the exact predicates. A new shape admitted there and forgotten here would
 * narrow the fold's input below what it reads, and the answer would silently change.
 */
export async function listInterruptCandidates(
  db: Driver,
  member: { id: string; team_id: string; name: string },
  /** `cursorTs` is the cursor row's `created_at` (see `cursors.ts`) — the window is in receipt order. */
  opts: {
    cursorTs?: number;
    /** ADR 558: the idle seam also admits a plain directed ask/request_help/handoff — the shapes
     *  `pendingInterrupts`' `directed` flag adds. Off, the query text and parameters are
     *  byte-identical to the boundary seam's. */
    directed?: boolean;
    /** Wall-clock now (ms). When set, together with `maxLookbackMs`, the unread window is bounded
     *  to recent rows so a stale cursor does not scan the whole table (lane 01M61STFBF). Omitted,
     *  the read stays unbounded and byte-identical to the unnarrowed read. */
    now?: number;
    /** Lookback bound (ms) paired with `now`. Defaults to `INTERRUPT_LOOKBACK_MS`. */
    maxLookbackMs?: number;
  } = {},
): Promise<MessageRow[]> {
  const directed = opts.directed
    ? `
            OR (to_member = ? AND act IN ('ask','request_help','handoff'))`
    : '';
  // The window is always bounded to the recent past: a seat whose cursor has not moved in
  // months must not re-scan its whole unread backlog on every poll (lane 01M61STFBF). `now`
  // defaults to the wall clock, so a caller that forgets it still gets the bound; a caller that
  // wants the unbounded read (the contract test) passes `now: 0`, which makes the floor the
  // cursor itself. The equality contract with interruptCandidates.test.ts is preserved that way.
  const now = opts.now ?? Date.now();
  const lookbackFloor = Math.max(
    opts.cursorTs ?? 0,
    now - (opts.maxLookbackMs ?? INTERRUPT_LOOKBACK_MS),
  );
  const windowRows = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?
          AND created_at > ?
          AND (
            act IN ('steer','resolve','accept','decline')
            OR thread_id IS NOT NULL
            OR meta LIKE '%"urgent"%'
            OR meta LIKE '%"lane_review"%'
            OR meta LIKE '%"eligible"%'
            OR meta LIKE '%"huddle"%'
            OR meta LIKE '%"incident"%'${directed}
          )
          AND (
            act IN ('steer','resolve','accept','decline')
            OR json_extract(meta, '$.urgent') = 1
            OR json_extract(meta, '$.lane_review') IS NOT NULL
            OR json_extract(meta, '$.eligible') IS NOT NULL
            OR json_extract(meta, '$.huddle') IS NOT NULL
            OR json_extract(meta, '$.incident.routed_to') IS NOT NULL
            OR json_extract(meta, '$.incident.resolved_by') IS NOT NULL${directed}
            OR (
              thread_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM messages root
                 WHERE root.team_id = ?
                   AND root.id = messages.thread_id
                   AND root.meta LIKE '%"huddle"%'
                   AND json_extract(root.meta, '$.huddle') IS NOT NULL
              )
            )
          )
        ORDER BY created_at ASC, id ASC`,
    opts.directed
      ? [member.team_id, member.id, member.id, lookbackFloor, member.id, member.id, member.team_id]
      : [member.team_id, member.id, member.id, lookbackFloor, member.team_id],
  );

  // Doorbell contract clause 7 (docs/design/daemon-doorbell-contract.md): six clauses governed
  // DELIVERY and none governed DISCHARGE, and the fold is pure over what it is handed — so the
  // shapes that discharge an act from outside the seat's window are this function's to fetch or
  // to drop. Three live falsifiers on c8e89dd8, 2026-09-14, one per shape below.
  const rows = await dischargeOutsideTheWindow(
    db,
    member,
    await buriedTurns(db, member, windowRows, opts),
  );

  // Own suppress acts never survive the filters above: `from_member != me` drops them, and an
  // accept/decline is a DM to the asker so `to_member = me` would not have kept it either.
  // pendingInterrupts can only discharge what it is handed (meta.in_reply_to / resolve.thread),
  // so without this fetch a self-answered obligation keeps ringing the live rail. Same shape as
  // the huddle "mine" fetch below — the fold needs the author's own rows, which the inbox omits.
  // Any own act carrying `in_reply_to` rides along too: a steer has no accept/decline, so the
  // addressee's reply — whatever act it rides on — is what discharges it (clause 7(iv)).
  const mineSuppress = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ?
          AND from_member = ?
          AND created_at > ?
          AND (act IN ('resolve','accept','decline')
               OR in_reply_to IS NOT NULL)`,
    [member.team_id, member.id, opts.cursorTs ?? 0],
  );

  // ADR 434 shape 4: my own turns in the threads of the steers this window carries. A steer inside
  // a thread is answered by my next turn in that thread, `in_reply_to` or not — and my own acts
  // never come from the window (`from_member != me`), so they are fetched by thread key, bounded
  // by the steers actually present. A window with no threaded steer costs nothing extra.
  const steerThreads = [
    ...new Set(rows.filter((r) => r.act === 'steer').map((r) => r.thread_id ?? r.id)),
  ];
  const mineOnSteerThreads =
    steerThreads.length === 0
      ? []
      : await db.all<MessageRow>(
          `SELECT * FROM messages
              WHERE team_id = ? AND from_member = ?
                AND thread_id IN (${steerThreads.map(() => '?').join(',')})`,
          [member.team_id, member.id, ...steerThreads],
        );
  for (const r of mineOnSteerThreads) mineSuppress.push(r);

  // ADR 378 — the context a huddle turn cannot carry. A turn is an ordinary `message` in a thread:
  // whether I am IN that huddle lives on the ROOT act, and where I last spoke lives in MY OWN turns.
  // Both are normally older than the cursor window (a huddle is opened once and then talked in) and
  // my own acts are excluded by `from_member != ?` above, so neither can come from the window. Fetch
  // them by id, bounded by the distinct huddle threads actually present in the window — the common
  // case is zero threads and zero extra queries.
  const threads = [...new Set(rows.map((r) => r.thread_id).filter((t): t is string => !!t))];
  if (threads.length === 0) {
    if (mineSuppress.length === 0) return rows;
    const byId = new Map<string, MessageRow>();
    for (const r of [...mineSuppress, ...rows]) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at - b.created_at,
    );
  }
  const marks = threads.map(() => '?').join(',');
  const roots = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ? AND id IN (${marks}) AND json_extract(meta, '$.huddle') IS NOT NULL`,
    [member.team_id, ...threads],
  );
  if (roots.length === 0) {
    if (mineSuppress.length === 0) return rows;
    const byId = new Map<string, MessageRow>();
    for (const r of [...mineSuppress, ...rows]) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at - b.created_at,
    );
  }
  const rootMarks = roots.map(() => '?').join(',');
  const mine = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ? AND thread_id IN (${rootMarks}) AND from_member = ?`,
    [member.team_id, ...roots.map((r) => r.id), member.id],
  );

  const byId = new Map<string, MessageRow>();
  for (const r of [...mineSuppress, ...roots, ...mine, ...rows]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at - b.created_at,
  );
}

/**
 * ADR 378 amendment (2026-09-04): a huddle turn is the only interrupt class whose admission depends
 * on a SECOND row — its root — and cross-host the two arrive out of order. A turn can fold before
 * its root; an unrelated inbox read in that gap moves the cursor past the turn's `created_at`;
 * when the root finally lands, the turn is below the window and can never ring. Measured on delta:
 * turn 1 at 1788561769690, cursor moved to 1788562249698, silent through every later probe.
 *
 * A turn "arrives" when its root does. So for every huddle root that landed INSIDE the window —
 * the one row the cursor cannot swallow, because it folds last — fetch that thread's turns from
 * below the cursor and hand them to the fold with the rest. The fold still decides which ring
 * (only turns newer than my own last one in that room), and the cursor still discharges them:
 * once a read carries it past the root, the root leaves the window and its turns with it (the
 * second test on this). Keyed on root ids already in hand, skipped when there are none — a window
 * with no freshly landed root costs nothing extra.
 */
async function buriedTurns(
  db: Driver,
  member: { id: string; team_id: string },
  windowRows: MessageRow[],
  opts: { cursorTs?: number },
): Promise<MessageRow[]> {
  const cursorTs = opts.cursorTs ?? 0;
  if (cursorTs === 0) return windowRows;
  const lateRoots = windowRows.filter((r) => {
    if (!r.meta) return false;
    try {
      return (JSON.parse(r.meta) as { huddle?: unknown })['huddle'] != null;
    } catch {
      return false;
    }
  });
  if (lateRoots.length === 0) return windowRows;
  const marks = lateRoots.map(() => '?').join(',');
  const buried = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ?
          AND thread_id IN (${marks})
          AND from_member != ?
          AND created_at <= ?`,
    [member.team_id, ...lateRoots.map((r) => r.id), member.id, cursorTs],
  );
  if (buried.length === 0) return windowRows;
  const byId = new Map<string, MessageRow>();
  for (const r of [...buried, ...windowRows]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at - b.created_at,
  );
}

/**
 * Clause 7's discharge shapes that live OUTSIDE the seat's inbox window. Each is a fact the fold
 * cannot see from the rows it is handed, so it is settled here, once, in SQL:
 *
 *  (ii)  a routed acceptance whose lane has LEFT awaiting_acceptance is moot — nobody answered
 *        the ask, the lane simply closed (ryder: ask 01M1N2DDRY on lane 01M1MM1Y, done since
 *        2026-09-04, rang at every boundary of two sessions for eight days);
 *  (iii) an eligible-set act a CO-ADDRESSEE already answered — the accept is a DM to the asker,
 *        so `to_member = me OR team` never carries it; fetched by ref and handed to the fold,
 *        which already discharges by `in_reply_to`;
 *  (iv)  a steer (or urgent act) this seat has already been SHOWN by an inbox read — the
 *        `inbox.rendered` row GET /inbox writes — is discharged, and the superseded steers under
 *        the newest one are dropped with it so none rises in its place (delta: stanley's steer
 *        01M2GC25MN rang ~20 boundaries after it was read and acted on);
 *  (vi)  a huddle turn this seat has been SHOWN — by a window read or the by-id read the interrupt
 *        line itself asks for — is discharged with every older turn in its room (lane 01M5N5KGZG);
 *  (v)   a handoff whose NAMED lane has left play — submitted for acceptance or terminal — is
 *        discharged, because a handoff is discharged by DOING THE WORK, never by a reply (#745).
 *        The idle seam (ADR 558) admits handoffs and the fold could only ever drop one on an
 *        accept/decline or the seat's own reply, so a settled handoff rang as urgent at every idle
 *        boundary (ryder's handoff 01M4YYV60Q of lane 01M4S53AV4, done 2026-10-15, re-raised to
 *        sloane twice after the close). Same predicate the inbox route and the orientation `why`
 *        use (`handoffNamedLaneOutOfPlay`), same narrowness: a bare handoff or one naming an
 *        unknown lane keeps ringing — a handoff that stops asking is work dropped on the floor.
 *
 * Every query here is keyed on ids already in hand and skipped when there are none, so the common
 * case — a window with no obligation, no eligible set, no handoff and no steer — costs nothing extra.
 */
async function dischargeOutsideTheWindow(
  db: Driver,
  member: { id: string; team_id: string; name: string },
  rows: MessageRow[],
): Promise<MessageRow[]> {
  const metaOf = (r: MessageRow): Record<string, unknown> => {
    if (!r.meta) return {};
    try {
      return JSON.parse(r.meta) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  let out = rows;

  // (ii) obligations on lanes no longer awaiting acceptance.
  const laneOf = new Map<string, string>();
  for (const r of rows) {
    if (r.act !== 'ask') continue;
    const review = metaOf(r)['lane_review'] as { lane?: unknown; advisory?: unknown } | undefined;
    // ADR 667: an advisory ask stays owed after its lane closes (see laneSettledSql).
    if (review && review.advisory !== true && typeof review.lane === 'string')
      laneOf.set(r.id, review.lane);
  }
  if (laneOf.size > 0) {
    const laneIds = [...new Set(laneOf.values())];
    const states = new Map(
      (
        await db.all<{ id: string; state: string }>(
          `SELECT id, state FROM lanes WHERE team_id = ? AND id IN (${laneIds.map(() => '?').join(',')})`,
          [member.team_id, ...laneIds],
        )
      ).map((l) => [l.id, l.state]),
    );
    out = out.filter((r) => {
      const lane = laneOf.get(r.id);
      if (lane === undefined) return true;
      const state = states.get(lane);
      // An unknown lane (replicated ask, local lane not yet folded) keeps ringing: dropping on
      // absence would silence a real obligation, which is the one direction this must never err.
      return state === undefined || isAwaitingAcceptance(state);
    });
  }

  // (v) handoffs whose named lane has left play — derived from the lane row, never stored, so a
  // lane that acceptance sends back to active makes the handoff owed again on the next read.
  const handoffs = out.filter((r) => r.act === 'handoff');
  if (handoffs.length > 0) {
    const settled = new Set<string>();
    for (const r of handoffs)
      if (await handoffNamedLaneOutOfPlay(db, member.team_id, r.meta, r.body)) settled.add(r.id);
    if (settled.size > 0) out = out.filter((r) => !settled.has(r.id));
  }

  // (iii) eligible-set acts a co-addressee answered — fetch the answer by ref.
  const shared = out.filter((r) => metaOf(r)['eligible'] != null).map((r) => r.id);
  const answers =
    shared.length === 0
      ? []
      : await db.all<MessageRow>(
          `SELECT * FROM messages
              WHERE team_id = ?
                AND act IN ('accept','decline')
                AND in_reply_to IN (${shared.map(() => '?').join(',')})`,
          [member.team_id, ...shared],
        );

  // (iv) steers and urgent acts this seat was already shown.
  const shown = out.filter((r) => r.act === 'steer' || metaOf(r)['urgent'] === true);
  if (shown.length > 0) {
    const rendered = await listRenderedActs(
      db,
      member.team_id,
      member.name,
      shown.map((r) => r.id),
    );
    if (rendered.size > 0) {
      // Newest by the fold's own key — the envelope `ts`, id-desc on a tie (ADR 103) — never
      // `created_at`, which is receipt order and ties across a burst.
      const steers = shown
        .filter((r) => r.act === 'steer')
        .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : b.ts - a.ts));
      // The newest steer is the only one the fold would ever raise (ADR 103); if it has been
      // shown, every steer goes — an older one rising in its place would be a superseded
      // direction ringing as if it were current.
      const dropAllSteers = steers.length > 0 && rendered.has(steers[0]!.id);
      out = out.filter((r) => !(r.act === 'steer' ? dropAllSteers : rendered.has(r.id)));
    }
  }

  // (vi) huddle turns this seat was already shown (lane 01M5N5KGZG). A turn has no answering move
  // either, and the fold rings a room for everything newer than the seat's own last turn in it —
  // so a seat that read a room and moved on, never speaking again, rang at every boundary for as
  // long as its cursor stayed behind the turn (lazara, 18 days, 2026-10-05 → 10-23). GET /inbox
  // records the newest turn per room it renders (`renderableOnRead`); here the newest RENDERED turn
  // in each thread discharges itself and every turn before it in that thread, the same shape as
  // the steer rule above. A turn newer than anything shown still rings. Threads are keyed without
  // their root: a rendered row on a non-huddle thread drops rows the fold would never have raised.
  const turns = out.filter((r) => r.thread_id !== null && isHuddleTurnAct(r.act));
  if (turns.length > 0) {
    const rendered = await listRenderedActs(
      db,
      member.team_id,
      member.name,
      turns.map((r) => r.id),
    );
    if (rendered.size > 0) {
      const shownUpTo = new Map<string, { ts: number; id: string }>();
      for (const r of turns) {
        if (!rendered.has(r.id)) continue;
        const cur = shownUpTo.get(r.thread_id!);
        if (!cur || r.ts > cur.ts || (r.ts === cur.ts && r.id > cur.id))
          shownUpTo.set(r.thread_id!, { ts: r.ts, id: r.id });
      }
      out = out.filter((r) => {
        if (r.thread_id === null || !isHuddleTurnAct(r.act)) return true;
        const upTo = shownUpTo.get(r.thread_id);
        if (!upTo) return true;
        return r.ts > upTo.ts || (r.ts === upTo.ts && r.id > upTo.id);
      });
    }
  }

  if (answers.length === 0) return out;
  const byId = new Map<string, MessageRow>();
  for (const r of [...answers, ...out]) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) =>
    a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at - b.created_at,
  );
}
