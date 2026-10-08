# A joiner's pull stops on a seat git has not delivered

A new seat is replicated over sync but its roster entry is not, so a joiner whose git roster lags stops applying the hub's log at the first event that names it.

## What happened (2026-10-08; falsify: on a joiner, `SELECT last_hub_seq FROM sync_pull_cursor` is below the hub's `sync_log` head while `~/.musterd/daemon.log` holds a `sync_fold_blocked` line naming a `seat`, and the roster repo's `.musterd/seats/<seat>.toml` is missing locally) <!-- claim: defect -->

Air 2's cursor sat at `hub_seq` 191205 (received 01:48 UTC) for about 15 hours, ~4,300 events behind. Event 191206 was
`residency.enrolled` for `alfie`, created on the hub laptop that morning. Seat files travel by
git (`.musterd/seats/*.toml` in the roster repo), not by sync, and alfie's was untracked on the hub. The fold stops
rather than skips (ADR 393), so everything behind 191206 waited, including acts addressed to Air 2's seats.

## Why it looked like something else

- Air 2's log was full of `sync_pull_failed … TimeoutError` lines. Those were the hub laptop asleep overnight (no pulls on
  the hub log between about 23:00 and 15:00 UTC). The hub answered 770 of 771 pulls in under 5 s.
- The real cause logged once, as `sync_fold_blocked` with `seat: alfie`, and never again (a stop logs once per distinct blocker).

## What to do

1. Commit and push the seat file from the machine that added the seat, then `git pull` the roster repo on the stuck machine.
   The next tick drains the backlog (the hub log shows a burst of pulls a couple of seconds apart).
2. `musterd team add` now prints the same warning at the source when the seat file is uncommitted or unpushed (lane `01M4EAQ115`), so the push happens before the seat's first event, not after.
3. Since ADR 547, `musterd status` and the MCP status/inbox warning say `sync is stopped` with the seat and event, after a 5-minute grace.

## Related

- [Joiner wedges](joiner-wedges.md) — the push-side twin: a refused event holds the whole machine.
- [Sync push](sync-push.md)
