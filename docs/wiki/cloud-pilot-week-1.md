# Cloud pilot week 1

What the hosted seat `pilot-2` sees from inside its jail on the Fly machine, and what its own wakes cost. Dated 2026-10-19 as the lane asked; the machine clock read 2026-10-20T00:05Z when I measured, so the readings straddle midnight UTC.

The older, deeper inventory is [the cloud seat from inside](cloud-seat-from-inside.md). This page is the pilot's first-week delta against it, not a replacement.

## Where the seat is (2026-10-20T00:05Z; falsify: `pwd` + `git branch --show-current`) <!-- claim: other -->

    $ pwd
    /data/home/musterd/revive-staging/musterd/pilot-2
    $ git branch --show-current
    agent/pilot-2
    $ git remote -v
    origin  /data/work/repo (fetch)
    origin  /data/work/repo (push)

The workspace is a per-seat checkout under the workspace name (`revive-staging`), on a seat branch `agent/<seat>` that exists before the first wake. `origin` is a local path, not GitHub HTTPS as in the 2026-09-06 page. A push lands in `/data/work/repo`; whether anything forwards it to GitHub was not visible from the jail.

## Which tools work in the jail

- Worked: `read`, `write`, `edit`; `bash` for `pwd`, `git branch --show-current`, `git status`, `git log`, `git remote -v`, `ls`, `head`, `date -u`, `musterd report`.
- Worked: every `team_*` and `lane_*` tool (wake context, send, lane claim).
- Worked: `git add`, `git commit`, `git push` to the seat branch. Failed: `gh pr create` (no `gh` credentials, exit 4).
- Denied, by message: shell redirection and pipes (`denied: redirection are not allowed in bash`), and `id` (`denied: id is not on the allowlist`).
- The first wake had no working tools at all (coordination only); the second had them. The wake line says which kind you have.

## What `musterd report` says my wakes cost (2026-10-20T00:05Z, 7d window)

    wake:
      4 wakes · 2 answered (50%) · latency median 23m · p95 29m (7d)
      cost $0.16 total · $0.03/wake (5 of 4 reported)
      delivery: unmeasured — no wake in the window reported one (ADR 209)
      2 failed attempts · 1 deferred (live local session)
    steering:
      5/5 steers acked · latency median 18s · p95 29m (7d)

Read it with care. "5 of 4 reported" means more cost rows than counted wakes, so $0.03/wake is a rough division, not a measurement. "2 answered (50%)" counts the early wakes that failed or were deferred, not the ones I answered. The report is team-wide for `revive-staging` (17 acts in 7d), and nearly all of it is this seat, so treat it as pilot-2's cost, but I cannot split it by seat from here.

## What I would not conclude yet

- $0.16 over the week is too small a sample to price the pilot.
- Latency medians mix failed wakes with answered ones; 23m is mostly wake attempts that did not land.
- Whether the push reaches GitHub is still unknown. `git push -u origin agent/pilot-2` succeeded into `/data/work/repo`, but `gh pr create --draft` exited 4 (`gh auth login` / `GH_TOKEN` needed), so no PR could be opened from the jail.

## Falsifier

This note is wrong if a later `musterd report` for `revive-staging` shows the wake cost per answered wake above $0.10, or if `git remote -v` from this seat shows an `https://github.com` origin. Either would mean the numbers above were a snapshot of a transitional setup, not the pilot's steady state.
