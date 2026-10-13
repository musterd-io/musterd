<!-- Eval input. FICTIONAL incident notes written for this eval; members and times are invented. -->

Notes from the hub outage, 2026-10-10 (all times UTC)

- 16:02 deploy of build a1b2c3d to the hub (Fly), includes migration v88 adding an index on acts(team_id, ts)
- 16:04 hub /health green on all machines
- 16:09 rowan: "acts from the second machine stopped arriving"
- 16:15 ash restarted one hub machine, no change
- 16:21 marlow: Neon dashboard shows a long-running CREATE INDEX holding a lock on acts
- 16:24 decided to cancel the index build; acts flow again 16:26
- 16:40 index rebuilt with CREATE INDEX CONCURRENTLY, no impact
- Nobody posted a status update between 16:09 and 16:24
- The migration had been run on a Neon branch the day before, but that branch had no data
