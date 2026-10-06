# 532 — Held trace rows travel per row; the wedge record names its kind

- Status: accepted
- Date: 2026-10-05
- Deciders: lazara (lane `01M46Z04Z3E670MCCCXEE8B3HF`, items 5 and 6 of the 2026-10-02 joiner audit; the human at Air 2 asked for the follow-up to be taken)
- Relates to: ADR 453 (structural trace replication — §3 amended), ADR 360 (push-level residence), ADR 358/328 (seat bindings), `docs/wiki/joiner-wedges.md`

## Context

The joiner audit of 2026-10-02 left two findings that each change a `@musterd/protocol` schema,
so neither could be fixed in its lane (`01M3ZBTJKD`).

**Item 5.** ADR 453 §3 holds the **whole** trace batch with a `409` when one row's seat is
unresolved (git lag) or bound to no node. It does that because those cases are transient: the
same batch lands once the roster catches up or the seat's first claim binds it. Two things undo
"transient" on a joiner:

- A seat binds only through the main push (`/sync/push`, ADR 360). When that push is refused
  (`403 bound_elsewhere` for some *other* seat), the whole main batch rolls back and nothing
  binds.
- One unbindable seat's row then holds every row behind it, from every seat on that node, on
  every tick, with only a warn line to show it.

The two wedges compound.

**Item 6.** When the main push is refused, the joiner records the refusal on its cursor row
(`SyncWedgeSchema`), and the roster and the inbox read it from there. The hub names the refused
event's kind (`message`, `lane`, `presence`, `ledger`, `policy`, `continuity`, `record`, `seed`),
but the schema allowed only `message | lane | presence`. `sync/push.ts` recorded everything else
as `presence`, so a ledger or record refusal told the reader the wrong thing.

## Decision

1. **A trace pusher may ask for per-row holds.**
   - `SyncTracePushRequest` gains an optional `hold_per_row: true`. With it, the hub does not
     answer `409` for `unresolved_seat` or `unbound_seat`.
   - Each such row is listed in a new optional reply field, `held: [{ id, code }]`, and is not
     written. The rest of the batch is admitted as usual: written, ignored, collided, or refused
     per row as `bound_elsewhere`.
   - A pusher that does not ask still gets the whole-batch `409`. An older joiner would advance
     its cursor past rows it never learned were held, so the change is opt-in.
2. **The joiner keeps a held set.**
   - Held row ids live in its `trace.db` `schema_meta` under `sync_trace_held:<team>`, capped at
     5,000; past the cap the oldest are dropped, with a count in the log.
   - Each tick re-offers the held rows **first**, re-read by id in the same structural wire shape,
     then new rows after the cursor, together at most one batch.
   - The cursor advances past the new rows on a `200`. The held set becomes exactly what the hub
     held this time: a re-offered row the hub took, or refused for good, leaves it.
   - A `trace_rows_held` warn line names the count and the reasons.
3. **The wedge record names every kind.** `SyncWedgeSchema.kind` is `SYNC_WEDGE_KINDS`: message,
   lane, presence, ledger, policy, continuity, record, seed. The joiner records the hub's kind as
   named (`wedgeKind`). Only an unknown kind, from a newer hub, falls back to `presence`.

The trace surface still never mints a binding (ADR 453 §3), and still writes no audit row for a
refusal (§5).

## Alternatives rejected

- **Advance past held rows and drop them.** That makes an unbound seat's traces lost to the hub
  forever. The rows were never wrong, only early.
- **Have the trace route bind the seat.** It would mint a residence claim from a channel that
  carries no claim, which is exactly what ADR 453 §3 forbids.
- **Keep the whole-batch hold and fix only the main push.** The main push can be refused for
  reasons that have nothing to do with the traces held behind it, such as a rebound seat's
  leftover rows. The trace channel should not inherit that.

## Consequences

- One seat that cannot bind no longer stalls a node's other trace rows. Its own rows reach the
  hub the tick after it binds.
- Mixed versions are safe. An old pusher against a new hub gets the old `409`. A new pusher
  against an old hub sends a field the old schema rejects as a `400`: `.strict()`, so the batch
  fails, the cursor holds, and it retries until the hub is updated. The hub always updates first
  (ADR 376).
- `held` is a protocol addition and `SyncWedgeSchema.kind` a protocol widening. A client older
  than this build reading a wedge of a new kind fails its own `safeParse` and shows no wedge line,
  not a wrong one.

## Observability & Evaluation

- **Traces:** the joiner logs `trace_rows_held {held, reasons, dropped_oldest?}`, and
  `trace_pushed` carries `held`. The hub's reply lists each held id. A wedge's kind is visible on
  the roster and `node list` as recorded.
- **Eval:**
  - `tracePush.test.ts` runs between a real hub and a real joiner. An unbound row and an
    unresolved row are held while a service seat's batch-mate lands. They are held again while
    still unbound, then land once bound, the held set empties, and nothing is duplicated.
  - A non-opted pusher still gets `409 unbound_seat`.
  - `push.test.ts` pins `wedgeKind` across every kind and the unknown fallback.
- **Experiment:** on Air 2 (the joiner the audit was read on), a trace push should never report
  `held` for more than one tick after the seat's first message folds on the hub. A held set that
  only grows means a seat that never binds, which is a residence problem to surface, not a trace
  one.
