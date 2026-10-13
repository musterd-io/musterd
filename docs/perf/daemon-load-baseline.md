# Daemon load — measurement log

Probe: `node scripts/perf/health-under-burst.mjs` (`SEATS`, `ROUNDS`, `CLAIMS=0|1`) — a real server on
a seeded in-memory DB, the production request mix, and a `/health` prober whose p99 is what the
guardian experiences. Plus, when a live number is needed, the daemon's own `http_request` log lines
(`~/.musterd/daemon.log`, JSON, `ms` per request). Append a section per measurement; never rewrite
an old one. Lane `01M3AGPSCD125CTJA3RE7XX6VY`.

## 2026-09-24 — the ~95% CPU saturation was one query, not the write path

**The lane's window, from the daemon log (12:50–13:15 PDT, build 87a3645, ~12 seats, before v71).**
3221 requests. Three endpoints held the event loop for ~1135 s of the 1500 s window:

| endpoint | calls | avg | max | >1 s |
| --- | --- | --- | --- | --- |
| `POST /residency/wake-leases` | 98 | 7.6 s | 22.7 s | 98 |
| `GET /lanes` | 39 | 5.9 s | 29.1 s | 16 |
| `GET /report` | 10 | 16.4 s | 21.9 s | 10 |
| `GET /inbox` | 1669 | 48 ms | 5.1 s | 15 |

`/inbox` was 52% of requests and cheap; its 5 s max is queueing behind the three above. All three run
`openDirectedLedger`, whose discharge clause could not use an index — fixed by migration v71 (#1688,
[wiki](../wiki/sqlite-expression-index-affinity.md)). The guardian's stack sample
(`Statement::JS_run → vdbeCommit → pagerWalFrames`) was misleading as a diagnosis: a WAL commit is
where a write *lands* while a long read holds the checkpoint off, not what was slow.

**The same daemon after v71 (30 min ending 14:20 PDT, build 30f03da, 2004 requests, ~10% CPU):**
p50 19 ms · p90 39 ms · p99 499 ms · max 1.17 s · 5 requests over 1 s. `/health` answers in
8–22 ms. By endpoint: `/inbox` 1218 calls avg 26 ms; `wake-leases` 64 avg 157 ms; `/lanes` 11 avg
643 ms; `/sync/pull` 8 avg 823 ms; `PATCH /lanes/:id` 4 avg 871 ms.

**The write path is not the cost.** On a copy of the live DB (232 MB, `audit` 228k rows), one
single-row `audit` insert in its own transaction commits in **0.026 ms** under `synchronous=NORMAL`
— which is what the daemon already runs (SQLite reports `1`; nothing in `open.ts` sets it, the
build's default is NORMAL for WAL) — 0.080 ms under FULL, 0.004 ms/row when 300 share a
transaction. The live write rate is ~4200 `audit` rows/h and ~130 messages/h: under a second of
commit time per hour. The rows are dominated by CLI re-claims (`claim.occupied` ~500/h, bursts of
109/min at 14:12, 344/h from one Cursor seat's hooks), each ~6 audit rows plus a presence
attach/detach. That churn is a roster-noise question, not a latency one.

**The harness, repaired and extended.** It had been sending the retired `x-musterd-seat` +
agent-key identity (the wall 1d, 2026-09-23) and every request 401'd — its "p99 100 ms FAIL" was 60
rounds of auth refusals. It now mints a seat credential, a Presence and a session lease per
synthetic seat, as `/claim` would, and `CLAIMS=1` (default) re-claims a seat every third round with
the lease refreshed from the response (a re-claim supersedes the old one, as a CLI hook does to a
session in production).

| seats | mix | load / round | `/health` p50 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 12 | read + probe + wake poll | 321 ms | 3.0 ms | 12.7 ms | 12.7 ms |
| 100 | read + probe + wake poll | 473 ms | 4.9 ms | 17.3 ms | 17.3 ms |
| 12 | + CLI re-claims | 659 ms | 4.2 ms | 24.3 ms | 25.9 ms |
| 100 | + CLI re-claims | 1046 ms | 8.6 ms | 42.1 ms | 42.1 ms |

Budget 100 ms, all green. "Will not survive 100 agents" is not supported for this mix on this build;
the harness is sequential (one request in flight), so it measures loop hold per request, not
throughput under concurrency — a concurrent variant is the next instrument if that claim needs
testing.

**Per-request cost on the live copy (quiet machine, second request after warm-up):**

| endpoint | wall | SQL | statements | the cost |
| --- | --- | --- | --- | --- |
| `GET /lanes` | 267 ms | 131 ms | 156 | `SELECT * FROM lanes … ORDER BY created_at` runs **16×** per request (116 ms); 2.5 MB response |
| `GET /report` | 239 ms | 160 ms | 2899 | per-lane / per-act fan-out: 342 `interrupt.raised` counts, 341 `answerBy` |
| `GET /inbox?unread=1` | 22 ms | 17 ms | 19 | fine |
| `GET /next/summary` | 5 ms | 1 ms | 12 | fine |

**Levers, ranked by measured value.** (1) Done: v71. (2) `/lanes`: read the table once per request
— `listLanes` is called from the handler and again inside `staleness`, contention (`lanes.ts:938`,
per lane), `goals`, `incidents`; a request-scoped memo removes ~110 ms and the 2.5 MB body wants
`detail` trimmed or paged. (3) `/report`: the 2899-statement fan-out. (4) Not worth doing on this
evidence: `synchronous`, batching writes, a worker thread for SQLite — the write path costs under a
second an hour. (5) The CLI re-claim churn is a roster/attestation-noise problem (every hook
invocation records `claim.occupied` + `superseded`), to be judged there, not here.

Falsify the headline: rerun the lane window's request mix against build 30f03da and find any
endpoint over 1 s that is not `/lanes`, `/sync/pull` or `PATCH /lanes/:id`.

## 2026-09-24 — `GET /lanes` reads the board once (lane 01M3ANEQVR)

`listLanes` was reached from the handler, then again from `boardWarnings` → `laneWarnings` for
**every** lane with a scope (the contention pass), and again from `staleLaneWarnings`. The handler
now reads the board once and passes it down; `filterLanes` derives the `?mine=1` / `?state=` view
in memory; `laneWarnings` takes the board as an optional last argument (the single-lane callers on
open/claim/update still read for themselves).

Same profiler, same live copy, median of 5:

| endpoint | before | after |
| --- | --- | --- |
| `GET /lanes` — table reads | 16 | 2 |
| `GET /lanes` — SQL | 131 ms / 156 stmts | 32 ms / 16 stmts |
| `GET /lanes` — wall | 267 ms | 210 ms |
| `GET /lanes?mine=1` — wall | — | 80 ms |

What is left of the 210 ms is not SQLite: `rowToLane` over 1218 rows (JSON-parsing `scope` and
`detail` per row) and serialising a 2.5 MB body. That is the body-size call the lane defers — page
the list, or drop `detail` from it (the CLI and /board read it) — and it is where the next 150 ms
are. One more read of the table remains on the path (8 ms), from a helper that was not traced to
its caller; not worth chasing at that size.

## 2026-09-25 — demo audience, concurrent: the /live roster fan-out, and a ceiling of ~75 (lane 01M3D4069F)

The Oct 7 demo (goal `demo`) puts the audience on the team: attendees sign in as human members
over OAuth remote MCP from phones, may add an agent seat, and watch `/live`. `health-under-burst`
is sequential, so it cannot say what a room does to the daemon; the new instrument is
`scripts/perf/demo-audience-load.mjs`. It drives three concurrent populations (humans with
bearer-only tool calls every ~20 s, agents on the hook rail, `/live` viewers modelled on
`packages/web/src/live` — backfill, WS `team-all`, a roster refetch per presence frame, a `/report`
refetch per lane act), and it runs the daemon in a child process that reports its own event-loop
delay and CPU. Synthetic board: 1200 lanes with 1.8 KB `detail` each (`GET /lanes` 2.5 MB, as on
revive).

**Not on a laptop.** The first run was on the presenter-class laptop (M3, 8 GB, 8 cores, with the
live daemon and a dozen seats running). The load average reached 105. The daemon used 29 % CPU yet
stalled 7 s: it was starved by the machine, not saturated by its work, so that run measures nothing.
Every number below is from a throwaway Fly `performance-8x` (`scripts/perf/loadbench.fly.toml`,
sjc), with the daemon pinned to core 0 (`DAEMON_CPUS=0`) and the audience on cores 1-7. One core is
the budget, because Node serves the daemon on one thread. Each run is 120 s with arrivals ramped
over 30 s. The server was built from main at a02c2eb (#1711). The remote `/mcp` endpoint (ADR 446) has not
landed, so humans are modelled as the HTTP routes their tools call.

| N humans = agents = viewers | viewer roster rule | req/s | daemon CPU | loop p99 | all p95 | roster (viewer) p95 | roster body |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | every frame | 5.3 | 5 % | 15 ms | 61 ms | 70 ms | 19 KB |
| 25 | every frame | 20.5 | 14 % | 26 ms | 178 ms | 209 ms | 47 KB |
| 50 | every frame | 53.8 | 44 % | 122 ms | **7564 ms** | 7896 ms | 94 KB |
| 50 | coalesced | 32.6 | 27 % | 41 ms | **349 ms** | 412 ms | 94 KB |
| 75 | coalesced | 57.3 | 54 % | 172 ms | 801 ms | 884 ms | 140 KB |
| 100 | coalesced | 73.0 | 80 % | 500 ms | 1838 ms | 4948 ms | 186 KB |

**The bottleneck was the viewers, not the seats.** Every `/live` page refetched the full roster
(`GET /teams/:slug`) on every presence frame, and every viewer receives every frame. The cost was
viewers × presence events: at N=50 that was 4116 frames, 4166 roster fetches of 94 KB in two
minutes, and 64 % of all requests. It grows with the square of the room. The seats' own traffic
(interrupt-check, inbox, sends) stayed in single-digit milliseconds at p50 throughout.

**The fix** (`packages/web/src/live/coalesce.ts`): the first presence frame still refetches at
once, and frames arriving during that fetch, or within 1 s of its start, fold into one trailing
fetch. At N=50 roster fetches fall from 4166 to 1606 and p95 from 7.6 s to 349 ms. It is a
web-only change, so it reaches `/live` through the build-publisher without a daemon restart.

**Go/no-go for Rehearsal A: about 75 of each** (75 humans, 75 agents, 75 viewers) on one
dedicated performance core, with p95 under 1 s. At 100 of each, p95 is 1.8 s. The roster is still
the top cost there (186 KB per fetch, and the body grows with the room). The next levers, in
order: (1) apply presence frames to the roster in place and refetch only for a member the page has
not seen, which removes the fan-out rather than rate-limiting it; (2) a short server-side memo of
the roster response; (3) the 2.5 MB `/lanes` body (p95 1 s at N=100). The demo host is a separate
question, because a laptop running the presentation cannot give the daemon a quiet core — see the
lane's note to the public-route lane (`01M3AKNAW6`).

Falsify the fix: rerun N=50 with `ROSTER=every` on the same box and find p95 under 1 s.

## 2026-09-25 — the human rail moves to the released OAuth + `/mcp` path (harness change, numbers pending)

The table above modelled humans as the plain REST routes their tools call, because the remote
`/mcp` endpoint had not landed. It has now (ADR 446, #1694: Streamable HTTP at `/mcp/:team`,
per-seat OAuth), and the review hold on this lane is exactly that gap: benchmark evidence must
exercise the released path, not a model of it.

`demo-audience-load.mjs` now drives humans over the released rail by default (`HUMAN_RAIL=mcp`):
the OAuth leg on arrival — dynamic client registration → authorize (PKCE) → token, the phone's
sign-in, so the arrival burst now carries the OAuth write path — then MCP `tools/call` frames
(`team_inbox_check` / `team_send` / `team_join`) with the `msat_` bearer per call. The child
daemon runs `trustProxy` (the demo posture), and each loopback human presents what the Cloudflare
edge would: `x-forwarded-proto: https` and a distinct `cf-connecting-ip`, which is also the OAuth
rate-limit key — so the per-IP buckets behave as they would for a room of real phones.
`HUMAN_RAIL=rest` keeps the modelled shape for A/B against the table above.

The tunnel leg is `REMOTE_URL=https://<hostname>`: humans go loopback → cloudflared → the
Cloudflare edge → back while agents/viewers stay loopback (the demo tunnel's ingress only exposes
`/mcp` and OAuth paths — `docs/operations/public-demo-tunnel.md`). The loadbench image now carries
`cloudflared`; the run recipe is in `loadbench.fly.toml`. Caveat recorded there: through a real
tunnel the edge collapses every driven human onto the box's one IP, so tunnel runs measure
steady-state tool-call latency (arrivals stretched under the per-IP OAuth limits), and the
arrival burst is read from loopback runs, where the per-attendee rate key is faithful.

**Numbers (2026-09-25, loadbench `performance-8x` sjc, `DAEMON_CPUS=0`, 50/50/50, 90 s, ramp
30 s, synthetic board of 1200 lanes).** The released `mcp` rail costs the daemon *less* than the
modelled `rest` shape, not more:

| rail | all-req p50 | p95 | p99 | daemon CPU | rss | loop delay p99/max | errors |
| ---- | ----------- | --- | --- | ---------- | --- | ------------------ | ------ |
| `mcp` (released, OAuth arrival + tools/call) | 22 ms | 557 ms | 837 ms | 43 % | 211 MB | 81 / 754 ms | 0 |
| `rest` (modelled A/B) | 26 ms | 614 ms | 1776 ms | 46 % | 225 MB | 92 / 764 ms | 0 |

The OAuth arrival burst is absorbed cleanly at N=50 (register p95 79 ms, authorize p95 163 ms,
token p95 109 ms, per-attendee `cf-connecting-ip` rate keys under `trustProxy`). The `rest`
rail's worse tail comes from humans hitting `GET /lanes` (2.5 MB bodies) and `GET /teams/:slug`,
which the MCP tool surface never fetches — the released rail replaces big-body reads with small
`tools/call` frames. Both runs stay inside the p95 1000 ms budget; the dominant cost at N=50
remains the viewer roster fan-out (`GET /teams/:slug` p95 ~726-772 ms), unchanged from the
2026-09-25 section above, so the **go/no-go ceiling stays ~75 concurrent attendees** — the
released rail does not move it down.

**Tunnel steady-state (2026-09-26, quick tunnel, same box, 50/50/50, 90 s measure, RAMP=650).**
Humans loopback → cloudflared → Cloudflare edge → back; agents/viewers loopback. All-request
p50 4 / p95 127 / p99 175 ms, daemon 5 % CPU, loop delay p99 14.6 ms — the edge round-trip adds
no daemon cost — but **no human reached the daemon**, so this run measured agents and viewers
only. `POST /oauth/register` failed for every arrival (6 attempts, 6× 403, 1 net error), and the
90 s sample caught only the first ~7 of 50 arrivals.

*Corrected 2026-09-26 (izzo, lane 01M3D4069F):* this section first attributed those 403s to the
per-IP rate limit. That was wrong — the rate limit answers **429**, not 403. The 403 was the
Cloudflare edge itself (`error code: 1000`): the harness sent its loopback-only
`cf-connecting-ip` header through the real tunnel too, and Cloudflare refuses any client request
carrying that header. Reproduce: `curl -H 'cf-connecting-ip: 198.51.100.7' https://musterd.io`
→ 403, without the header → 200. It is a harness bug, not a demo risk (phones never send that
header); the harness now sends the edge headers on loopback only, and refuses `DURATION ≤ RAMP`
so a run cannot silently drop late arrivals. The 2026-09-25 re-run (RAMP=1000, DURATION=300)
repeated both faults: 16 of 50 arrivals, 16× 403, zero humans signed in. Falsifier: a tunnel
run on the fixed harness still returning 403 on register.

The first tunnel run that got every human in (2026-09-26, after the fix above and the
`MUSTERD_ALLOWED_HOSTS` fix in #1739) also exposed a second 403: the daemon's Host/Origin gate
refuses a Host that is not loopback, the bound host, or on `MUSTERD_ALLOWED_HOSTS`, and the demo
runbook never set it — every phone would have been refused. Fixed in the runbook (#1739).

**Sustained tunnel run (2026-09-26, quick tunnel, same box, 50/50/50, RAMP=1000, DURATION=1300,
build 55f1ab2e).** All 50 humans signed in through the edge (register / authorize / token /
initialize / `team_join` 50 each, 0 errors). **The daemon failed the budget:**

| measure | value |
| ------- | ----- |
| all-request p50 / p95 / p99 | 225 ms / **10 250 ms** / 47 178 ms |
| daemon CPU, rss | 51 %, 238 MB |
| loop delay p99 / max | 137 / **4 698 ms** |
| `GET /report` (viewer, 4 609 calls) p50 / p95 | 1 797 / **48 925 ms** |
| human `/mcp` send · inbox · inbox-full p95 | 24.0 · 23.1 · 23.6 s (13× 502 at the edge) |
| `GET /teams/:slug` (viewer, 10 760 calls) p95 | 4 118 ms |
| errors | 85 (13× 502 human MCP, ~71× 401 on agent inbox/messages/lanes — not yet explained) |

A same-length run with no humans through (the Host-gate fault) already sat at p95 5.9 s. So the
failure is sustained load, not the tunnel — and the 90 s runs above could not see it: an agent
opens a lane every 300 s and re-claims every 120 s, so a 90 s window holds no lane acts at all.

*Root cause.* `/live` and `/board` refetch `GET /report` on **every** lane act
(`packages/web/src/live/useReport.ts`), so each lane act costs one `deriveReport` per open viewer,
synchronously, on the one event loop. `deriveReport` hydrated the whole lane board (detail
bodies, JSON columns) **twice** — once for the blocked list, once inside `listGoals` for goal
status — to read two columns: 52 ms at a 1200-lane board, so 50 viewers × one lane act ≈ 2.6 s
of blocked loop, with every other request (phone tool calls, `/health`) queued behind it. Both
reads are now narrow SQL (`listBlockedLanes`, `laneStatesByGoal`): **52 → 5.4 ms** per report at
1200 lanes (7.4 ms at 2400), measured in-process on a laptop. The per-viewer fan-out itself stays
(≈ 0.27 s of loop per lane act at 50 viewers); the roster read costs ~6–12 ms per call at 101
members, spread over many `prepare` calls, and is the next suspect if a re-run still misses.

*Corrected 2026-09-26 (izzo):* the "go/no-go ceiling ~75 concurrent attendees" above came from
90 s runs and does not hold under sustained load — at 50 the build before this fix fails. Re-read
the ceiling from a sustained run on the fixed build. Falsifier for the root cause: a sustained
tunnel run on the fixed build whose loop-delay max is still multi-second.

## 2026-09-28 — sustained 50/50/50 through the tunnel passes the budget (lane 01M3D4069F)

Same rig and shape as the 2026-09-26 sustained run: a Fly box, quick tunnel, 50 humans, 50 agents and
50 viewers, RAMP=1000, DURATION=1300, daemon pinned to one core (`DAEMON_CPUS=0`).

| build | all-request p95 | loop max | `GET /report` p95 | `GET /teams/:slug` p95 | errors | verdict |
| ----- | --------------- | -------- | ----------------- | ---------------------- | ------ | ------- |
| 3ce5aed3 (#1762: agent re-claim race) | 2 539 ms | 2.7 s | 13.2 s | 2.2 s | — | fail |
| 659a17bc (+#1777: `/report` on a worker) | 5 547 ms | 2.6 s | 13.7 s | 5.4 s | 23 | **invalid** |
| **c278dfb8** (+#1781: roster index, bench on a file DB) | **760 ms** | 1.0 s | 552 ms | 860 ms | 3 | **pass** |

On c278dfb8: 36 358 requests (28/s), daemon CPU 35 %, rss 253 MB, loop delay p99 83 ms. All 50
humans signed in through the edge. The 3 errors were 2× 502 on human `/mcp inbox` at the edge and
1× 401 on `interrupt-check`. #1762 took the agent 401s from ~71 to single digits.

*The 659a17bc run is invalid for `/report`.* The bench's synthetic daemon opened `:memory:`, and
`store/reportCache.ts` derives inline and uncached for an in-memory store because a worker cannot
share it. The run measured the path the production daemon no longer takes. The bench now seeds its
synthetic board into a temp file (#1781).

*What fixed it.* (1) `GET /report` derives on a worker thread with its own read-only connection,
behind a per-team single-flight cache with a 5 s TTL (#1777). 50 viewers now share one derivation,
off the event loop. (2) The roster's per-member `latestStatusUpdate` had no usable index: it sorted in a
temp B-tree, ~100 ms of a ~118 ms roster read on the live copy. Migration v77 adds
`idx_messages_from_act_ts`, which takes it to 1.7 ms (#1781).

*What is left.* `GET /teams/:slug` is now the slowest route (p95 860 ms over 14 034 calls), and the
next cost inside it is `seatWakeabilityFacts` (~14 ms, per-member audit lookups). The `/report`
worker inherits the daemon's single-core pin in this rig, so the pass is conservative for a
multi-core host. Falsifier: a sustained run at 50/50/50 on this build or later with all-request
p95 over 1 000 ms.

## 2026-10-02 — musterd Cloud through Cloudflare → Fly → Neon at 75/75/75: invalid as acceptance, two defects found (lane 01M3Z44C56)

Cloud spec §8.1 asks for ADR 451's population — 75 humans, 75 agents and 75 viewers — through the
Cloudflare edge to the Fly app tier on Neon, with all-request p95 under 1 s. The harness gained
`TARGET=<origin>`: no child daemon. It seeds a fresh team over the admin API (the same 1200-lane board,
then each human seat with its credential and each agent seat through the admin seat-credential
rotate), and every population and the `/health` prober go through the edge. Seeding took 69 s.

| piece | what ran |
| --- | --- |
| driver | Fly `performance-4x`, iad, one-shot (`scripts/cloud/bench-run.mjs` from lane 01M3Z429Q3's branch at 3329764d), image from 4b29bfc0 |
| target | team `lb-run1` on staging: app `musterd-cloud`, ONE `shared-cpu-1x` 512 MB machine in iad, image `git-de08ada65523` (#1969's branch tip), pg pool of 10 through Neon's pooler |
| database | Neon `musterd-cloud`, aws-us-east-1, 1 CU fixed |
| shape | RAMP=1000, DURATION=1300, as on 2026-09-28: one driver is one address, so arrivals stay under the per-IP OAuth register limit (5/min) |

| run | requests | errors | all-request p50 | all-request p95 | `/health` p95 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-28, tunnel, SQLite, one performance core, 50/50/50 | 36 358 (28/s) | 3 | — | 760 ms | — |
| **2026-10-02, Cloud, shared-cpu-1x, 75/75/75** | 8 318 (6.4/s) | **6 241** | 11 899 ms | **42 392 ms** | 1 190 ms |

The errors: 3 565 × 503 `database unreachable: timeout exceeded when trying to connect` (pool
acquire timeouts), 2 385 × 401 on agent calls (no lease after a refused claim), 181 × 502/520/524 at
the edge, 76 WebSocket closes, 34 × 500 on `/mcp`. The slowest routes by p95 were `GET /report`
99.8 s, `POST /lanes` 84 s, agent `POST /messages` 82 s and `POST /claim` 60.5 s.

**Why it is invalid as acceptance.** The shared vCPU was throttled. Per Fly's own metrics for the
window, the machine ran 55–77 % busy from 22:07 to 22:13 UTC, then from 22:14 it showed 72–93 %
steal and about 7 % busy until the end: Fly holds a shared CPU to its baseline share once its burst
balance runs out. From then on every request queued behind a starved event loop, the pool's acquire
timed out, and heartbeats arrived late enough for the server to reap sockets (close 4410). This
measures the VM class, not the architecture. The staging size is `shared-cpu-1x` (#1969); a
dedicated core is nick's call (2026-10-02).

**Defect 1 — the server crashed under it** (lane `01M3ZC3EXN`). At 22:24:05 the process exited 1,
not OOM. A viewer's WebSocket closed while the pool was exhausted, `release()` in the close handler
threw `DriverError: database unreachable`, nothing caught the rejection, and Node exited. Fly
restarted it in 3 s, and every socket and in-flight request on the machine dropped (the edge 502s).
The presence reaper's tick and the same-workspace eviction timer have the same shape. On SQLite
these never reject; on Postgres a pool timeout or an outage does, so a database blip takes down every
team on the machine instead of answering 503 (spec §7).

**Defect 2 — the 503 names the wrong cause** (lane `01M3ZC3G35`). Neon was reachable throughout; the
pool queue timed out because the app was starved. An operator reading `database unreachable` would
chase an outage that was not there, and `/mcp` answered the same cause with a bare 500.

**What the burst minutes suggest (an estimate, not a measurement).** Before the throttle, about the
first 30 of each population had arrived, and the vCPU was 55–77 % busy, up to a third of it in
softirq — network packet processing. That fits the Neon pass's finding that every bare statement is
its own five-round-trip transaction. The 2026-09-28 SQLite daemon used 35 % of a performance core at
50 of each. So a dedicated core alone is unlikely to carry 75 of each at today's per-request cost.
The levers: one transaction per request on the pg driver (lane `01M3Z455NE`), and a cache for
`GET /report` on Postgres, which derives inline and uncached on every request (the worker and its
5 s single-flight cache in `store/reportCache.ts` are SQLite-only).

Falsifier: a sustained 75/75/75 run against a dedicated-core Cloud machine, on a build with the
crash fix, with all-request p95 under 1 000 ms and no process exit.

## 2026-10-03 — Cloud run 2 on a dedicated core: the database pool is the limit, not the CPU (lane 01M3Z44C56)

Same shape as run 1: 75/75/75 through the edge, RAMP=1000, DURATION=1300, a `performance-4x`
driver in iad, a fresh team (`lb-run2`). Two things changed on the target. The staging machine is
now `performance-1x` with 2 GB (nick, 2026-10-02; #1987), and it runs 6eea5446, which carries the
crash fix (#1984).

| run | target | requests | errors | all-request p50 | all-request p95 | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 (2026-10-02) | `shared-cpu-1x`, throttled | 8 318 | 6 241 | 11 899 ms | 42 392 ms | 1 190 ms |
| **2 (2026-10-03)** | `performance-1x` | 11 241 | **5 632** | 13 888 ms | **125 020 ms** | 92 ms |

| route (run 2) | calls | p50 | p95 | errors |
| --- | --- | --- | --- | --- |
| `GET /report` (viewer) | 1 346 | 125 012 ms | 125 044 ms | 709 × 524 at the edge, 578 × 503 |
| `GET /teams/:slug` (viewer) | 3 228 | 13 835 ms | 36 404 ms | 1 234 × 503 |
| `GET /inbox/interrupt-check` | 3 185 | 10 428 ms | 32 828 ms | 849 × 503, 792 × 401 |
| `POST /claim` (agent) | 433 | 25 177 ms | 75 390 ms | 147 × 503 |

**The machine was not the limit.** The core ran 56–60 % busy from minute four to the end, with
0.2–0.3 % steal: no throttle, and never saturated. `/health` answered in 92 ms at p95, so the event
loop was free. Memory peaked at 512 MB of 2 GB. The process never exited; the #1984 paths logged
their pool timeouts and carried on.

**The database pool was.** Requests waited for one of the pool's 10 connections, and after the
acquire timeout got 503 `database unreachable: timeout exceeded when trying to connect` — 3 465 of
them. Neon's own load was not measured. The biggest consumer is `GET /report`. On Postgres it derives
the whole report inline and uncached on every request (lane `01M3ZCTQ77`), and each lane act fans a
refetch out to every viewer: 1 271 lane frames became 1 346 full derivations of a 1 200-lane board,
every statement its own five-round-trip transaction. Almost all of them ran into the edge's timeout.
The roster read is second (N+1, lane `01M3ZCTQK9`). The 401s are agents left without a lease after a
refused claim.

**What it changes.** Run 1's estimate that a dedicated core would be the limit did not hold: the core
idled at 60 % while the pool queue grew. The next lever is the cache for `GET /report` on Postgres —
single-flight per team with the 5 s TTL the SQLite worker already has, which bounds 1 271 lane
frames to about one derivation per team every 5 s. Then run 3, and per-request transactions (lane
`01M3Z455NE`) and the roster by what run 3 measures.

Falsifier: run 3 with `GET /report` served through the cache shows a similar count of pool-timeout
503s.

## 2026-10-03 — Cloud run 3: the `/report` cache cuts its median by two thirds; the pool still saturates (lanes 01M3Z44C56, 01M3ZCTQ77)

Same shape as run 2, a fresh team (`lb-run3`), staging still on `performance-1x`, now running
3fe34f3c: `GET /report` served from a per-team cache keyed by the root store (#1996).

| run | build | requests | errors | p50 | p95 | `/report` calls | `/report` p50 | `/report` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 6eea5446 | 11 241 | 5 632 | 13 888 ms | 125 020 ms | 1 346 | 125 012 ms | 125 044 ms |
| **3** | **3fe34f3c** | 12 130 | **4 130** | 18 302 ms | 125 016 ms | 2 803 | **44 925 ms** | 125 039 ms |

The machine again had room: the core ran a median 55 % busy (max 59 %), steal at most 0.7 %, memory
at most 424 MB of 2 GB, no restart, `/health` p95 76 ms.

- **The cache works, and is not enough.** `/report` served twice the calls — more lane opens got
  through, so 2 729 lane frames fanned out to the viewers — with its median down from 125 s to 45 s.
  A reader still waits whenever the cached report is older than 60 s, and with the pool saturated a
  single derivation takes longer than that.
- **The pool still saturates:** 2 335 pool-timeout 503s (run 2: 3 465). The roster read is now the
  likely largest consumer: 3 134 reads, each running one `latestStatusUpdate` per present member —
  about 150 statements, every one its own five-round-trip transaction — through a pool of 10
  (lane `01M3ZCTQK9`).
- **New: 261 × 500**, mostly agent `POST /messages` answered after 19–31 s; the edge's 520s rose too
  (480, run 2: 93). The server logs no cause for a 500 — `sendError` maps an unknown error to
  `server_error` without recording it — so this run cannot say what they were. Writes that SQLite
  serializes can deadlock on Postgres; that is a hypothesis, not a finding.

**Next:** log the cause of every 500, make the roster read a constant number of statements, then
one transaction per request (lane `01M3Z455NE`). Falsifier for the roster claim: run 4 with a
constant-statement roster shows a similar pool-timeout count.

## 2026-10-03 — Cloud run 4: a constant-cost roster triples throughput; the pool timeouts are gone (lanes 01M3Z44C56, 01M3ZCTQK9, 01M3ZPM3FE)

Same shape as runs 2–3 (75/75/75, `performance-1x`, fresh team `lb-run4`), now on e088a57e: the roster
read runs a constant number of statements (#2001) and every 5xx logs its cause (#2000).

| run | build | requests | errors | p50 | p95 | roster p50 | `/report` p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 3fe34f3c | 12 130 (9.3/s) | 4 130 | 18 302 ms | 125 016 ms | 14 995 ms | 44 925 ms |
| **4** | **e088a57e** | **39 696 (30.5/s)** | **113** | **2 770 ms** | **24 340 ms** | **2 472 ms** | **9 400 ms** |

- **The roster was the hog.** With it constant, the server served 3.3× the requests — 15 425 roster
  reads, 10 286 interrupt-checks — and the pool-timeout 503s went from 2 335 to none. No 500s either,
  so the cause logging had nothing to explain this time. The 113 errors are 84 agent 401s, 24 edge 520s
  and a handful of socket closes.
- **Still a fail.** Writes are now the slowest: `POST /lanes` and agent `POST /messages` p50 about
  30 s, human `/mcp send` 26 s. `/report` p50 9.4 s over 8 710 calls (8 743 lane frames). The core ran a
  median 60 % busy (max 63 %, steal ≤ 0.4 %): still not the limit.
- **Next lever:** one transaction per request (lane `01M3Z455NE`). Every statement still acquires its
  own pooled connection — five round trips and a fresh place in the queue each — and a write runs many
  statements. Falsifier: run 5 with per-request transactions shows the same write latency.

## 2026-10-03 — Cloud run 5: a one-trip transaction start, then a pool of 40 — p95 2.8 s, and a new wall at ~30 s on writes (lanes 01M3Z44C56, 01M3Z455NE)

Same shape as run 4 (75/75/75, `performance-1x`, fresh teams `lb-run5` and `lb-run5b`) on main with
#2026: `BEGIN`, `SET LOCAL ROLE` and the tenant `set_config` go down as one query, so a bare statement
is three round trips, not five; and `MUSTERD_PG_POOL_SIZE` sets the pool (default 10). 5a ran at the
default; 5b with `MUSTERD_PG_POOL_SIZE=40` (set by nick, blue-green restart).

| run | pool | requests | errors | p50 | p95 | p99 | roster p95 | `/report` p50 | `POST /lanes` p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 10 | 39 696 (30.5/s) | 113 | 2 770 ms | 24 340 ms | — | 5 500 ms | 9 400 ms | ~30 000 ms |
| 5a | 10 | 47 670 (36.7/s) | 65 | 1 981 ms | 14 123 ms | 31 062 ms | 3 769 ms | 4 142 ms | 25 639 ms |
| **5b** | **40** | **57 726 (44.4/s)** | **436** | **1 042 ms** | **2 784 ms** | **15 122 ms** | **2 420 ms** | **628 ms** | **14 357 ms** |

- **The one-trip start helped; the pool was the bigger limit.** 5a cut p95 by 42 % on the same pool.
  5b quadrupled the pool and cut p95 by another 80 %; reads now sit at 0.6–2.4 s.
- **Still a fail, and the failure moved to writes.** `POST /lanes` p50 14.4 s, human `/mcp send` 9.1 s,
  and every write route tops out at 29–30 s (5b max: lanes 30 265 ms, agent messages 29 193 ms, send
  29 281 ms).
- **New: agent `POST /messages` 500s** — 52 in 5a, 434 in 5b (run 4: none). Their cause was not
  captured: Fly keeps ~100 log lines and both runs had rolled past them before they were read. Nothing
  in the server sets a 30 s timeout, so the ceiling is likely upstream (Neon's pooler or the proxy) —
  unconfirmed.
- **Next:** run 5c with `fly logs` streamed to a file for the whole run, to name the 500 and the 30 s
  wall before changing anything else. Lane `01M3Z455NE` stays open: its condition (p95 < 1 s) is unmet.
  Falsifier: 5c's captured 500s are not timeouts, or writes no longer cluster at ~30 s.

## 2026-10-04/05 — Cloud runs 6–11: the queue was the pool, one checkout per statement; then the send fan-out (lanes 01M3Z455NE, 01M4563RDY)

Same shape as run 5 (75/75/75, `performance-1x`, a fresh team per run). Each run changed one thing.

| run | build / change | pool | p50 | p95 | summed pool wait | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | ADR 504 (seq at commit) | 40 | 1.4 s | 7.0 s | — | no gain; reverted (#2053) |
| 7 | revert + Postgres lock sampler | 40 | 1.5 s | 9.3 s | — | no transaction past 0.18 s; sessions mostly idle in transaction |
| 8 | live CPU profile (distorts the run) | 40 | 3.2 s | 28.4 s | — | the main thread ~50 % idle: not CPU-bound JS |
| 9 | per-request timing (#2063) | 40 | 2.0 s | 10.9 s | ~67 000 s | ~870 000 pool checkouts; a send = 165 transactions |
| 10 | ADR 507: a request leases a client (#2069) | 40 | 1.6 s | 11.3 s | 47 700 s | the queue moved to leases (225 simulated users, 40 connections) |
| 11 | `MUSTERD_PG_POOL_SIZE=150` | 150 | 2.2 s | 12.0 s | 4 456 s | pool queue gone; slow writes hold a client 22 s over 165 transactions, CPU 92–94 % |

- **Run 6 was misread at the time.** Its p95 rose from 5c's 2.6 s, but run 7 on the revert was slower
  still: `main` moved between the runs. ADR 504's Consequences records "no effect".
- **The pool was the queue for reads, and is solved.** Run 9's per-request fields (`db_tx`,
  `db_wait_ms`, `db_hold_ms`, `db_query_ms`) found every statement checking a client out on its own;
  ADR 507 plus a pool of 150 took summed pool wait from ~67 000 s to 4 456 s.
- **What is left is the cost of a write.** In run 11 the 537 writes over 5 s held their client a
  median 22.2 s across 165 transactions (7.8 s of it in Postgres) with the one core at 92–94 %. The
  165 is one `getMemberById` per recipient in live delivery (`protocol/route.ts`) — fixed in lane
  `01M4563RDY`: a team send is now a constant 26 statements at any team size.
- **Next:** run 12 with the send fix at pool 150. Falsifier: writes still hold a client for
  seconds over a handful of transactions — then the cost is elsewhere in the write path.

## 2026-10-05 — Cloud run 12: the send fix lands; `/report` is now the tail, and it waits on a derivation, not the database (lanes 01M3Z44C56, 01M4563RDY, 01M46RPQ94)

Run 11's shape (75/75/75, `performance-1x`, pool 150) on #2086, the constant-cost send.

| run | build / change | pool | p50 | p95 | what it showed |
| --- | --- | --- | --- | --- | --- |
| 12 | team send in constant statements (#2086) | 150 | 1.9 s | 8.7 s | writes at 15 transactions, p50 2–4 s; CPU 72–87 %; `/report` p95 20.5 s |

- **The send fix held.** Agent `POST /messages` dropped from 165 transactions to 15, and the run's
  p95 from 12.0 s to 8.7 s with the core no longer pinned.
- **`/report` is the worst route, and its time is not in the database.** Over 9 558 calls its cache
  worked (two foreground derivations), and a cache hit holds a client for 1.5 s at p95. Yet the
  route's p95 is 20.5 s. Every other route spends ~5 ms outside the database; `/report` spends 19 s
  at p95. The slow calls arrive in bursts from minute 14, which is readers queueing on an in-flight
  refresh once the cached report has aged past `REPORT_MAX_STALE_MS` (60 s).
- **Why a refresh took over a minute.** A derivation was 202 transactions on a 150-member team: the
  message hydration and the family-posture snapshot each asked one question per member, and under
  load a transaction cost ~250 ms. Lane `01M46RPQ94` makes the derivation a constant number of
  statements at any team size (`report-statements.test.ts`, both drivers) and runs Cloud's
  derivation in one transaction.
- **Next:** run 13 with that fix. Falsifier: `/report` still shows a non-database gap of seconds at
  p95 — then the refresh is slow for a reason other than its statement count.

## 2026-10-05 — Cloud runs 13–14: `/report` is fixed; Neon's 1 CU was the next wall, then the app core (lanes 01M3Z44C56, 01M46RPQ94)

Run 12's shape (75/75/75, `performance-1x`, pool 150) on 61a79f9a (#2097, the constant-statement
`/report` derivation). Run 14 changes one thing: the Neon compute is fixed at 4 CU instead of 1.

| run | build / change | Neon | p50 | p95 | req/s | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 13 | `/report` in constant statements (#2097) | 1 CU | 1.9 s | 5.6 s | 34 | `/report` p95 2.6 s; writes 10–18 s at p95; Neon-bound |
| 14 | same build | 4 CU | 1.3 s | 3.0 s | 43 | every route 2.5–4.1 s at p95; app core at 0 % idle from minute ~15 |

- **The `/report` fix held.** Its p95 fell from 20.5 s to 2.6 s. The time it spends outside the
  database at p95 is now ~2 ms, the same as every other route. Run 12's falsifier did not fire.
- **Run 13 was bound by Neon, not by the pool or the app.** Throughput stopped rising at ~48
  req/s from minute 10 while the ramp kept adding members. Median query time per transaction grew
  from 3.6 ms to 95 ms with load, yet pool wait stayed at 0 until minute 16. The app machine kept
  ~26 % CPU idle throughout. Writes were the worst routes: `claim` p95 17.9 s, `POST /lanes` 16.7 s,
  `POST /messages` 10.6 s.
- **Run 14 confirms it: 4 CU halves p95** (5.6 s → 3.0 s), and `claim` falls from 17.9 s to 4.1 s.
  Query time per transaction still grows from 3.3 ms to 28 ms, but now the app machine's idle CPU
  reaches 0 % from minute ~15. Query time measured in the app includes event-loop delay, so the app
  core is the next wall.
- **Where Neon's time goes (`pg_stat_statements`, run 14).**
  - `latestStatusUpdates` (the roster's status column) is ~65 % of all database execution time:
    785 s over 24 523 calls, a mean of 32 ms and ~14 500 buffers per call. Run by hand after the
    run, the same statement on the same team takes 1.3 ms and 1 416 buffers. Something makes it
    ~25× costlier under load, and that is not explained yet.
  - `UPDATE nodes SET next_seq = next_seq + $2` is a single-row counter on the write path: a mean
    of 19.7 ms and a max of 2.57 s over 5 414 calls. Concurrent writes serialize on that row lock.
- **Where the app core goes.** `GET /teams/:slug` serves a 145 KB body 24 523 times in the run,
  ~3.5 GB of JSON. It is the leading suspect for the saturated core; not yet profiled.
- **Next:** three lanes, one for each finding: the roster statement under load, the `next_seq`
  hotspot, and the roster body's CPU cost. Falsifier for the roster lane: the per-call buffer count
  stays ~10× the hand-run cost after the fix.

## 2026-10-06 — Cloud run 15: v89 fixes the roster statement; `next_seq` and the inbox read lead now (lanes 01M3Z44C56, 01M477RQGV)

Run 13's shape (Neon 1 CU) on bab4d429 (#2127, schema v89: `messages` re-analyzes after ~1 % churn).

| run | build / change | Neon | p50 | p95 | req/s | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | `messages` analyze threshold 1 % (#2127) | 1 CU | 1.6 s | 3.7 s | 40 | roster statement 14.5k → 1.9k buffers per call; `claim` p95 7.7 s |

- **The roster fix held.** `latestStatusUpdates` went from ~14 500 to 1 927 buffers per call,
  within 1.4× of the hand-run cost, so the lane's falsifier did not fire. Its share of database time
  fell from ~65 % to 17 %. `messages` auto-analyzed twice during the run.
- **Same 1 CU as run 13, p95 5.6 s → 3.7 s.** `claim` fell from 17.9 s to 7.7 s, and `POST /lanes`
  from 16.7 s to 7.1 s.
- **Where Neon's time goes now (`pg_stat_statements`, run 15).** Four statements take ~90 % of it:
  the `/report` audit fold (`SELECT CASE WHEN a.action IN …`) 25 %, 31 ms mean;
  `UPDATE nodes SET next_seq` 24 %, a **123 ms** mean over 5 417 calls (lock wait, at 14 buffers);
  the inbox read (`SELECT * FROM messages WHERE team_id = $1 AND (to_member = $2 OR …`) 23 %, 49 ms
  and 1 086 buffers; and the roster statement 17 %.
- **Next:** the `next_seq` lane (`01M477RVRV`) is now the clearest single target. The inbox read and
  the audit fold are new candidates.

## 2026-10-06 — Cloud run 16: the counter lock is off the write path; 13 unexplained edge errors (lanes 01M3Z44C56, 01M477RVRV)

Run 15's shape (Neon 1 CU) on 0dcd8201 (#2141, ADR 531 + schema v90: `origin_seq` stamped at commit).

| run | build / change | Neon | p50 | p95 | req/s | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | `origin_seq` stamped at commit (#2141) | 1 CU | 1.4 s | 3.0 s | 39 | counter `UPDATE` mean 123 → 12 ms; `claim` p95 7.7 → 5.3 s; 13 errors |

- **ADR 531 held, mostly as predicted.** These are `pg_stat_statements` deltas over the run. The counter
  `UPDATE` made 5 473 calls at a **12.2 ms** mean, down from 123 ms. The prediction was single-digit ms
  and the falsifier was > 20 ms, so the change landed between them: the lock no longer spans the
  request, but the stamp still waits on the busy 1 CU compute. The max was 5.1 s.
- **Write routes, p95:** `claim` 7.7 → 5.3 s, `POST /lanes` 7.1 → 4.3 s, agent `POST /messages`
  4.7 → 3.1 s. Overall p95 went from 3.7 s to 3.0 s.
- **Where Neon's time goes now:** the `/report` audit fold made 20 898 calls at a 42 ms mean, the inbox
  read 14 201 at 48 ms, and the roster statement 20 764 at 32 ms (2.1k buffers a call, so the plan is
  still right). With the counter off the critical path, these three reads share the 1 CU compute.
- **13 errors, the first since run 12:** 11 viewer WebSockets closed with 1006 and 2 `GET /teams/:slug`
  network errors, out of 50 368 requests. The server logged no warning or error during the run, and its
  only health-check failure was the deploy's own boot, 5 minutes before the seed. So the drops happened
  outside the app, at Fly's proxy or Cloudflare. Unexplained; the falsifier is that they recur at a
  higher count on the next run.
- **Idle load:** between runs 15 and 16, with no traffic, `SELECT * FROM lanes WHERE team_id = $1`
  ran ~130 000 times (~11 min of database time). Only 3 763 of those calls fell inside run 16 itself,
  so the source was something periodic between runs. It is not yet traced.
- **Next:** the three read hotspots above, and tracing the idle `lanes` reader.

## 2026-10-06 — Cloud run 17: the database does half the read work, but p95 rises to 4.2 s (lane 01M3Z44C56)

Run 16's shape (Neon 1 CU, one `performance-1x` app machine) on c4df5b9a. Since run 16, three
read fixes have landed: #2159 (the reaper's lanes reads), #2163 (interrupt-check) and #2165 (observer
reaping).

| run | build / change | Neon | p50 | p95 | req/s | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | three read fixes (#2159, #2163, #2165) | 1 CU | 2.0 s | 4.2 s | 37 | read DB time about halved; write p95 up about 1.5 s; 6 errors |

- **The reads got cheaper.** These are `pg_stat_statements` deltas over the run:

  | statement | run 16 | run 17 |
  | --- | --- | --- |
  | interrupt-check window | 14 201 calls × 48 ms (682 s) | 12 655 × 27.6 ms (349 s) |
  | `/report` audit fold | 20 898 × 42 ms (878 s) | 19 544 × 30.1 ms (587 s) |
  | roster statement | 20 764 × 32 ms (664 s) | 19 401 × 23.2 ms (450 s) |

  The idle `SELECT * FROM lanes WHERE team_id = $1` reader and the old observer-reap statements made
  0 calls. Their replacements return 0 rows.
- **The writes got slower.** Write p95: `claim` 5.3 → 7.3 s, `POST /lanes` 4.3 → 6.9 s, agent
  `POST /messages` 3.1 → 4.7 s. The counter `UPDATE` went from a 12.2 ms mean to 32.1 ms (5 388 calls,
  max 5.1 s). `UPDATE members SET last_offline_reason` averaged 20 ms, with a max of 2.8 s.
- **Reading.** Database time fell, yet every route's latency rose, so the database is no longer the
  first bottleneck. The leading suspect is the single app vCPU. `GET /teams/:slug` alone serialized
  19 339 bodies of up to 148 KB, about 2 MB/s of JSON. That suspicion is unproven: app CPU was not
  measured this run. Six server commits that are not perf work also landed between the two builds
  (ADR 533, 534 and 536, holds increment 4, #2158).
- **Errors:** 6 of 47 884 requests: 3 viewer WebSockets closed with 1006, and 3 network errors. That
  is down from 13. The server logged no warning during the run. Its `musterd_operator` login failures
  at 20:29Z came from the planned password rotation before the deploy, and ended with it.
- **Falsifier:** if app CPU is the bottleneck, a `performance-2x` app machine on the same build and
  database should bring p95 down. If p95 does not move, the cause is on the write path, and the next
  step is a bisect across those six commits.
- **Next:** measure app CPU during a run (lane 01M477S003, `GET /teams` CPU), then try the 2x machine.

## 2026-10-06 — Cloud run 18: a 2-vCPU app machine brings p95 to 3.3 s; the 1 CU database is still saturated (lane 01M3Z44C56)

This is run 17 again, on the same build (c4df5b9a) and the same Neon 1 CU, with one change: the app
machine is `performance-2x` (2 vCPU, 4 GB) instead of `performance-1x`. It tests run 17's falsifier.

| run | build / change | Neon | p50 | p95 | req/s | what it showed |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | run 17 on a `performance-2x` app machine | 1 CU | 1.5 s | 3.3 s | 41 | app CPU was part of it; still 3× the budget; 2 errors |

- **App CPU was part of it, not all of it.** p95 fell 4.2 → 3.3 s and p50 2.0 → 1.5 s, while
  throughput rose 36.8 → 41.3 req/s. Write p95: `claim` 7.3 → 5.4 s, `POST /lanes` 6.9 → 5.2 s,
  agent `POST /messages` 4.7 → 3.4 s. Errors fell to 2, both viewer WebSockets closing with 1006.
- **The database did not get faster per call.** Means over the run: roster 29.1 ms, `/report` fold
  30.6 ms, interrupt-check 31.1 ms, counter `UPDATE` 11.3 ms (32.1 ms in run 17). Summed execution
  time for the top statements was about 1 960 s in a 1 300 s run. Run 17's was about 1 630 s. On a
  1 CU compute that means queries wait for CPU, so the database is still saturated.
- **Reading.** Run 17's regression was mostly the app machine: the counter's 32 ms mean came back to
  11 ms once the app stopped queueing its own transactions. Neither machine size gets near the 1 s
  budget while three reads (roster, `/report` fold, interrupt-check) take about 1.8k s of 1 CU's
  time.
- **Next:** either take those three reads down, or measure Neon at 2 CU to price the alternative.
  Keep the app machine at `performance-2x` as a separate decision; staging returns to `performance-1x`
  until `fly.toml` says otherwise.

## 2026-10-09 — Cloud runs 22–27: p95 sits at 2.1 s on one core; a second core buys 23%, not the budget (lanes 01M477S003, 01M4F0W1SG)

Runs 22–27 use one shape: 75 humans, 75 agents and 75 viewers, `RAMP=1000 DURATION=1300`, a
`performance-4x` bench machine, Neon 1 CU, staging on main `1831ecf5`. Runs 19–21 are not on this
page. Runs 22–26 use a `performance-1x` app machine; run 27 uses `performance-2x`.

| run | app machine | p50 | p95 | p99 | requests (req/s) | errors | what it showed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 22 | 1x | 912 ms | 1 862 ms | 2 327 ms | — | — | after the `GET /teams` slices |
| 23 | 1x | 1 065 ms | 2 155 ms | 2 656 ms | 61 039 (47.0) | 1 | same build as 22; ~15% run-to-run spread |
| 25 | 1x | 1 100 ms | 2 202 ms | 2 870 ms | 61 137 (47.0) | 1 | repeat; no CPU profile (see below) |
| 26 | 1x | 1 010 ms | 2 077 ms | 2 609 ms | 60 676 (46.7) | 5 | repeat; no CPU profile |
| 27 | 2x | 757 ms | 1 604 ms | 2 009 ms | 64 845 (49.9) | 3 | the falsifier below |

- **Run-to-run spread is about ±8% of p95.** Four 1x runs on one build span 1 862–2 202 ms (mean
  2 074). A single run cannot show a change smaller than that.
- **The app core is saturated, and Neon is not.** On 1x, app CPU in run 23 climbed 9, 14, 29, 41, 62,
  84, 92, 95% at 3-minute steps (user 74, sys 9, softirq 12, steal 0.5). The `pg_stat_statements`
  delta for run 23 shows about 264 s of total database execution time over a 1 300 s run, so Neon
  spent most of the run waiting for the app. The largest statements: the presence-and-wake roster
  (28 301 calls × 4.1 ms = 117 s, one per `GET /teams`), the inbox read (15 567 × 2.4 ms), the node
  `next_seq` update (5 487 × 6.0 ms).
- **Falsifier (run 23's reading: "the app core is the limit"):** a `performance-2x` machine should
  lower p95 if so. It did: 2 077 → 1 604 ms against run 26, and 2 074 → 1 604 ms (−23%) against the
  four-run mean; throughput rose 6%. App CPU on 2x peaked at about 47% of both cores (8, 7, 12, 19,
  27, 41, 47, 44% at 3-minute steps), which is about 0.94 of one core. One Node event loop is
  still full, and the second core only takes GC and I/O. Run 27 is one run, but its p95 sits 458 ms
  under the fastest 1x run, more than the 340 ms spread across the four 1x runs.
- **Neither size meets the budget** (p95 under 1 000 ms). More vCPUs on one process do not get
  there. The remaining levers are CPU per request, and a second machine, which waits on lane
  01M3Z4EMH3 (nick, 2026-10-02: one machine for now).
- **Cost per request is mostly transaction overhead (unproven).** Run 23 made about 873 000
  transactions for 61 000 requests, about 14 per request. Each is `BEGIN`, `SET LOCAL ROLE`,
  `set_config`, `COMMIT`. If per-transaction driver work, not query time, fills the app core, then
  batching bare reads would help; lane 01M3Z455NE already batched a request's bare reads once. The CPU profile that
  would show where the time goes was not captured: the `auto` classifier blocks `fly ssh` from my seat
  and the two attempts (runs 25 and 26) missed the 22-minute plateau window.
- **Errors:** 1, 1, 5 and 3 of about 61 000 requests (0.002–0.008%): viewer WebSockets closed with
  1006, and three 502s from the edge (one each on `POST /mcp inbox`, `GET /teams/:slug`, `GET
  /report`). The server logged no warning.
- **Next:** capture a plateau CPU profile with a script the operator starts before minute 15, then
  decide between cutting transactions per request and a second machine. Staging was returned to
  `performance-1x` / 2 GB after run 27, matching `deploy/cloud/fly.toml`.

## 2026-10-09 — Cloud run 28: the plateau CPU profile — no single hot spot; the roster's style epoch is the cheap win (lane 01M4FGJAEEA9K2D0Z561RRCW34)

Run 22's shape on `performance-1x`, main `1831ecf5`, team `lb-run28`. The operator started
`profile28.sh` before the bench. It waited until 1 020 s after the seeded line, sent SIGUSR1, and
profiled the app's Node thread for 120 s (16:06:27–16:08:27Z, 17–19 minutes in). Fly's CPU gauge read
86, 97 and 98% busy at the last three 3-minute steps. 95 756 samples.

| share of samples | where |
| --- | --- |
| 13% | decoding Postgres rows (`parseRow`, `addFields`, packet parser) |
| 11% | garbage collection |
| 11% | event loop idle (the Fly gauge also counts kernel network time the JS profile does not) |
| 8.9% | `sendJson`, of which 4.1% is synchronous gzip/brotli of the 151 KB `GET /teams/:slug` body |
| 7.6% | sending transactions to Postgres (`inTransaction`) |
| 6.9% | `summarize`, the roster builder; 4.8 points of it is style epochs |

- **No single hot spot.** The costs are spread across row decoding, GC, compression and transaction
  traffic, which is why a second core helped by 23% and not by half (run 27). Row decoding plus GC is
  about 24%, so fewer or smaller roster reads are the larger lever.
- **The cheap win is the style epoch.** `currentStyleEpochFor` hashes (`JSON.stringify` + SHA-256) once
  per roster row, and the human rows resolve their style a second time for `dials`. Agent rows nearly
  all resolve to the same value. That ran about 4.8 points of the core at 28 000+ `GET /teams` calls
  per run. A per-call memo keeps the wire unchanged.
- **Run 28's latency is not a baseline.** p50 1 208 ms, p95 2 912 ms, p99 3 694 ms, 57 823 requests
  (44.5/s), 0 errors. The inspector and a 120 s profile ran on a core that was already full, and p95
  sits above the four unprofiled 1x runs (1 862–2 202 ms). Do not use it in the spread.
- **Next:** one lane for the style-epoch memo, one for trimming the roster's reads. Re-measure each
  with an unprofiled run, since a single run cannot show less than the ±8% spread.
- **2026-10-12 — the memo landed (lane 01M4GQ2G7BDNJVDQ9DM1Q6T53T).** `styleResolver` in
  `packages/server/src/store/style.ts` resolves each distinct `(kind, style_prefs)` once per roster
  build: one hash for the team defaults plus one per human with their own prefs, where it was one per
  row plus one per human row. The wire is unchanged. It is unmeasured until the next unprofiled
  75/75/75 run; falsified if `summarize` stays above ~5% of plateau samples in a fresh profile.

## 2026-10-12 — Cloud runs 29–31: the style-epoch memo is inside the noise at the roster's p95 (lane 01M4GQ2G7BDNJVDQ9DM1Q6T53T)

Staging redeployed on main `daeb0a3` (#2413, the memo), `performance-1x` / 2 GB app machine, Neon
1 CU, `performance-4x` bench machine, 75/75/75, no profiler. This build carries everything merged
since runs 22–26's `1831ecf5`, not the memo alone.

| run | p50 | p95 | p99 | requests (req/s) | errors | `GET /teams` p95 | what it showed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 29 | 691 ms | 1 613 ms | 2 012 ms | 56 450 (43.4) | 39 | 1 623 ms | light load: viewers dropped (23 WS 1006) |
| 30 | — | — | — | — | — | — | seed failed: `ECONNRESET` 28 s in; app machine did not restart |
| 31 | 840 ms | 1 872 ms | 2 337 ms | 58 511 (45.0) | 19 | 1 864 ms | the clean repeat |

- **Run 31 sits at the bottom of the old 1x spread** (1 862–2 202 ms, mean 2 074). A ~10% drop from
  the mean is about the ±8% spread, so the memo is not shown to move p95 on its own. Run 29's 1 613 ms
  ran about 8% fewer requests than runs 23–26, so it measured the lighter load, not the change.
- **Both runs carried less load than the baseline** (43–45 req/s against 47) and more errors (19–39
  against 1–5), all viewer WebSocket 1006 closes and network errors at the edge. The server logged no
  restart. Read each run against its own request count, not only its p95.
- **The memo stays in.** It removes per-row work and changes nothing on the wire. A fresh plateau
  profile, not a p95, is the test of its 4.8 points: falsified if `summarize` stays above ~5% of
  samples.
- **The bench log stream can drop the summary.** Run 31's streamed log stopped after the seed. The
  summary came back from `fly logs -a musterd-loadbench --no-tail`, which keeps only the last ~100
  lines, so read it before the next run.

## 2026-10-12 — Cloud run 32: the shared roster base meets the budget on one machine (lane 01M4S94RMJY1ZSG1FHVMD8MFMW)

Staging redeployed on main `dc09c35` ([ADR 573](../decisions/573-roster-base-shared-reads.md), #2434),
the same shape as runs 29–31: `performance-1x` / 2 GB app machine, Neon 1 CU, `performance-4x` bench
machine, 75/75/75, no profiler, team `lb-run32`.

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `GET /teams` p95 | `GET /report` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 31 | `daeb0a3` | 840 ms | 1 872 ms | 2 337 ms | 58 511 (45.0) | 19 | 1 864 ms | 1 650 ms |
| 32 | `dc09c35` | 355 ms | **791 ms** | 1 203 ms | 66 306 (51.0) | 1 | 794 ms | 880 ms |

- **All-request p95 is under the 1 000 ms budget for the first time on Cloud.** It fell 58% from
  run 31, far outside the ±8% spread, and every route fell, not only the roster: `POST /claim` 3 334 →
  1 055 ms, `GET /inbox` 2 540 → 928 ms, `interrupt-check` 1 790 → 672 ms. The roster was half the
  requests and about nine transactions each, so sharing it freed the one app core for everything else.
- **More work, not less.** The bench is closed-loop: faster answers drew 13% more requests (51 req/s
  against 45), with 30 481 roster reads, and errors fell from 19 to 1. This is not the light-load
  effect that made run 29 look better than it was.
- **ADR 573's falsifier did not fire.** Roster p95 fell from 1 864 to 794 ms, not merely past the
  spread.
- **One run.** The margin is large, but the budget holds with about 200 ms to spare. A repeat run, or a
  run at a larger audience, is what says how much headroom there is.
- **The second machine (lane 01M3Z4EMH3) is not needed to meet this budget at this audience.** It
  stays a capacity decision for a larger demo, not a latency fix. Nick decides that lane.

## 2026-10-13 — Cloud runs 33–34: two repeats of run 32 miss the budget, on a half-size bench machine (lane 01M4SEH1NYRVQH1T3G91DKPDYH)

Same staging build as run 32 (`dc09c35`, [ADR 573](../decisions/573-roster-base-shared-reads.md)),
same app machine, Neon 1 CU, 75/75/75, no profiler, teams `lb-run33` and `lb-run34`. One difference
the launcher did not flag: both runs drove the load from a `performance-2x` bench machine, where run 32
used `performance-4x`.

| run | bench machine | seed | p50 | p95 | p99 | requests (req/s) | errors | `GET /teams` p95 | `GET /teams` max | `/health` p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | `performance-4x` | 37 s | 355 ms | **791 ms** | 1 203 ms | 66 306 (51.0) | 1 | 794 ms | 2.5 s | 231 ms / 983 ms |
| 33 | `performance-2x` | 151 s | 175 ms | 1 341 ms | 7 081 ms | 54 594 (42.0) | 55 | 2 883 ms | 159 s | 199 ms / 14.8 s |
| 34 | `performance-2x` | 37 s | 212 ms | 2 861 ms | 9 443 ms | 57 556 (44.3) | 45 | 4 778 ms | 115 s | 192 ms / 29.4 s |

- **Headroom is not measured; the repeats are not comparable to run 32.** p50 fell (355 → 175 / 212 ms)
  while p95 and p99 rose several times over and the maxima reached minutes. A saturated server raises
  the median with the tail; a median that drops while the tail explodes is a client or path that
  stalls between bursts. The halved bench machine is the one known change, and the ~45 errors per run
  are mostly `net` and WS `1006` closes on the viewer rail, with a handful of edge `520`s — none are
  app errors, and the app machine never restarted.
- **`/health` max 14.8 s and 29.4 s with p95 under 200 ms.** The prober is the smallest request on
  the path; a 30 s outlier on it with a flat p95 is a stall somewhere on the path, not a slow query.
  Neon's logs for the window are empty and `pg_stat_statements` is not enabled, so the database side
  cannot be ruled in or out from here.
- **Run 33's seed took 151 s against 37 s** for the same 1 200 lanes; run 34's seed was back to 37 s
  and its tail was worse. The two do not point the same way, which is what noise looks like.
- **What run 32 still says.** The ADR 573 win is a 58% p95 drop on a matched machine, outside the
  spread; nothing here contradicts it. What these runs withdraw is the "200 ms to spare" reading —
  the budget margin is unmeasured until a repeat on a `performance-4x` bench machine.
- Falsify: run 35 on `performance-4x`, same build and shape, lands a p95 above 1 000 ms. Then the
  bench machine was not the cause and the app's tail under this load needs a profile.
- Follows-up: a `performance-4x` repeat (run 35), and the launcher should print the bench machine size
  in the run header so a size change is never silent again.

## 2026-10-13 — Cloud run 35: the half-size bench machine was the tail; p95 439 ms on `performance-4x`, under a lighter viewer load (lane 01M4V58WNBXVK272FN6KQ6Y9JD)

Same build (`dc09c35`), app machine (`performance-1x` / 2 GB), Neon 1 CU and shape (75/75/75, ramp
1 000 s, duration 1 300 s) as runs 32–34; the bench machine back on `performance-4x` / 8 GB, team
`lb-run35`.

| run | bench machine | p50 | p95 | p99 | requests (req/s) | errors | `GET /teams` calls / p95 / max | `/health` p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | `performance-4x` | 355 ms | 791 ms | 1 203 ms | 66 306 (51.0) | 1 | 30 481 / 794 ms / 2.5 s | 231 ms / 983 ms |
| 33 | `performance-2x` | 175 ms | 1 341 ms | 7 081 ms | 54 594 (42.0) | 55 | 21 031 / 2 883 ms / 159 s | 199 ms / 14.8 s |
| 34 | `performance-2x` | 212 ms | 2 861 ms | 9 443 ms | 57 556 (44.3) | 45 | 22 731 / 4 778 ms / 115 s | 192 ms / 29.4 s |
| 35 | `performance-4x` | 247 ms | **439 ms** | 566 ms | 47 474 (36.5) | 79 | 17 090 / 454 ms / 7.7 s | 209 ms / 7.4 s |

- **The minute-long tails were the bench machine.** On `performance-4x` the maxima drop from 115–159 s
  to under 8 s on every route but one (`interrupt-check` max 40 s, a single request), and p99 is 566 ms
  against 7–9 s. Runs 33–34's falsifier did not fire: the app's tail under this load does not need a
  profile on this evidence.
- **Not a clean repeat of run 32, and not a headroom number.** Run 35 carried 28% fewer requests
  (36.5 req/s against 51.0) because 46 viewer sockets closed with `1006` during the run and 21 roster
  reads failed at the network, so the roster rail did 17 090 reads against 30 481. The 79 errors are
  all `net` / WS close plus two `401`s; none are app errors and the app machine did not restart. A
  lighter roster load is the likeliest reason p95 sits at 439 ms rather than ~790 ms, so the
  honest reading is "under the budget on both 4x runs", not "350 ms to spare".
- **The viewer-socket drops are now the open question.** Runs 32 and 35 ran the same bench size and
  shape; run 32 lost one request, run 35 lost 46 sockets. Nothing in the app changed between them.
  That points at the edge (Cloudflare → Fly) or the bench's own WS client, and it is worth a run that
  records *when* the closes happened rather than only how many.
- Falsify: a run 36 on `performance-4x` with 0–5 WS closes lands a p95 above 850 ms. Then run 35's
  439 ms was the light load, and the budget margin on one app core is thin after all.
- Follows-up: run 36 as above, with the bench logging each WS `1006` close with a timestamp and the
  viewer's reconnect outcome.
