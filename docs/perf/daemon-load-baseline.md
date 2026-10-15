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

## 2026-10-13 — Cloud run 36: p95 809 ms on a matched repeat of run 32; the viewer-socket drops come in bursts late in the run (lane 01M4V72T1VENBVAV65CQN07Q9C)

Same build (`dc09c35`), app machine, Neon 1 CU, shape and `performance-4x` bench as runs 32 and 35,
team `lb-run36b` (the first `lb-run36` attempt was destroyed a minute in by the launcher itself: one
transient Machines API `EOF` on its status poll threw, and its cleanup ran — the poll now rides out five
misses). The bench now logs every viewer socket close with its offset, lifetime and claim state.

| run | p50 | p95 | p99 | requests (req/s) | errors | viewer closes | `GET /teams` calls / p95 | `/health` p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | 355 ms | 791 ms | 1 203 ms | 66 306 (51.0) | 1 | 0 | 30 481 / 794 ms | 231 ms / 983 ms |
| 35 | 247 ms | 439 ms | 566 ms | 47 474 (36.5) | 79 | 46 | 17 090 / 454 ms | 209 ms / 7.4 s |
| 36 | 365 ms | **809 ms** | 1 105 ms | 61 596 (47.4) | 27 | 23 | 27 337 / 816 ms | 275 ms / 1.5 s |

- **Run 35's 439 ms was the light load.** With the roster rail at 27 337 reads (90% of run 32's),
  p95 is 809 ms against run 32's 791: inside the spread. Two matched runs now say the one-core app on
  `dc09c35` meets the 1 000 ms budget at 75/75/75 with about 200 ms to spare. That is the headroom
  number this series was after, and it is small: the next audience step needs the second machine
  (lane 01M3Z4EMH3) or another app-side cut, not more runs at this size.
- **The 23 closes all landed after +810 s, in bursts.** None before the plateau; then clusters of
  5–8 sockets within 2–3 s at about +895, +1 088 and +1 216 s, with lifetimes from 60 s to 1 204 s.
  All had claimed. A client-side cause would scatter them across the ramp; a burst that takes
  sockets of every age at once is the hub or the edge closing a batch. Fly's `--no-tail` log window
  had rolled past those minutes by the time I looked, so this run does not say which.
- **The bench's viewers never reconnect.** Every close lightens the roster rail for the rest of the
  run, so a run with early closes understates load (run 35) and one with late closes barely does
  (this one). A real `/live` viewer reconnects. Teaching the bench to do the same would make the
  load honest and make the closes a latency blip instead of a load change.
- Falsify: hub logs (`ws_close` lines, or the edge's) for a run 37's burst windows show the closes
  initiated by the bench process, not the hub or edge.
- Follows-up: a run that captures the hub's `ws_close` reasons live during the burst windows, with the
  bench reconnecting a closed viewer (lane 01M4VAWG302W0MYD45DW583ZS5).

## 2026-10-13 — Cloud run 37: the edge closes the viewer sockets and the hub never sees it; reconnect makes a close a 1–2 s blip; p95 1 226 ms on `6fd7aca` is a new build, not a matched repeat (lane 01M4VAWG302W0MYD45DW583ZS5)

Same app machine, Neon 1 CU, shape and `performance-4x` bench as runs 32/35/36, team `lb-run37`, but
the app was rolled from `dc09c35` to main `6fd7aca` (#2499) first: the hub's `ws_close` line now
carries `code`, `reason`, `error` and `lived_ms`, the bench's viewers reconnect with `/live`'s backoff
(1 s doubling to 15 s), and `bench-run.mjs` tailed the hub's log for the whole run
(`BENCH_HUB_APP=musterd-cloud`, socket lines kept in `~/.musterd/cloud/bench/out/hub-git-6fd7aca44986-*.log`).

| run | build | p50 | p95 | p99 | requests (req/s) | errors | viewer closes | `GET /teams` calls / p95 | `/health` p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | `dc09c35` | 355 ms | 791 ms | 1 203 ms | 66 306 (51.0) | 1 | 0 | 30 481 / 794 ms | 231 ms / 983 ms |
| 36 | `dc09c35` | 365 ms | 809 ms | 1 105 ms | 61 596 (47.4) | 27 | 23 | 27 337 / 816 ms | 275 ms / 1.5 s |
| 37 | `6fd7aca` | 493 ms | **1 226 ms** | 1 685 ms | 66 203 (50.9) | 3 | 3, all back in 1–2 s | 31 522 / 1 180 ms | 477 ms / 1.7 s |

- **Who closes the viewer sockets: the edge, and the hub does not see it.** The bench saw three
  `1006` closes at +508, +511 and +522 s (lifetimes 188–270 s, all claimed). The hub's log for the
  whole run holds exactly 75 `ws_close` lines, all at the bench's teardown at +1 300 s, one per
  viewer, 75 distinct members — and the three dropped viewers appear once each with `lived_ms`
  counted from their *reconnect*, not their first open (h24: 791 s = 1 300 − 508). So the hub never
  logged the three original sockets closing: no close frame reached it and the TCP stream did not
  end on its side within the run. A `1006` at the client with silence at the origin is the proxy
  between them dropping the client leg and holding the origin leg. The falsifier (the bench
  initiating the closes) fails on the same evidence — a bench `close()` or `terminate()` would have
  reached the hub as a `ws_close` at +508 s. What the hub carries afterwards is a socket nobody is
  heartbeating, which the reaper takes offline later; `ws_heartbeat_reaped` is the tell if a
  reconnected viewer's old presence ever shows up as a second row.
- **Reconnect works and costs nothing visible.** Each of the three came back in 1–2 s (first
  backoff step) and re-claimed; 75 of 75 viewers were live at stop, and the roster rail read
  31 522 times — the full load, where run 36's late drops and run 35's early ones had lightened it.
  The bench's load is now honest across closes.
- **Three closes in one 14 s window, not run 36's three bursts of 5–8.** Same shape (a cluster
  taking sockets of different ages), smaller and earlier. With two runs the burst count is noise;
  the mechanism is not.
- **p95 1 226 ms is not a matched repeat and must not be read against the 800 ms headroom.** Two
  things changed at once: the viewers now hold the full roster load through the whole run (+3% reads
  over run 32, not a 55% jump), and the app build moved 10 server/protocol commits from `dc09c35` to
  `6fd7aca` (#2438–#2499). `/health` p95 went 231 → 477 ms with the same request rate, which is the
  app being slower per request, not the bench asking for more. Candidates in that range that touch
  the hot path: #2473 (every replicated row rings the push loop), #2452 (wake-lease claim
  transactions), #2440 (`/report` rewrites). Nothing here says which, or whether it is noise.
- Falsify: a run 38 on `6fd7aca` with the same shape lands p95 under 900 ms — then run 37 was
  noise and the headroom from runs 32/36 stands on the new build. If it repeats at ~1 200 ms, bisect
  the ten commits with two deploys (`dc09c35` + #2440 + #2452, then + #2473).
- Follows-up: run 38, a matched repeat on `6fd7aca`, to separate the build from the noise; then the
  bisect above if it repeats (lane to open from this one's close).

## 2026-10-13 — Cloud runs 38, 38b, 39: `6fd7aca` holds at p95 1.6–1.75 s; the database is not where the time goes, and the planned bisect cannot run (lane 01M4VJX4KBTMSAW2MS0NM9GZGB)

Same app machine (one vCPU), Neon 1 CU, shape and `performance-4x` bench as run 37, on the same
build — Fly confirmed `musterd-cloud:git-6fd7aca44986` (release v25) before and after. Fresh team
per run (`lb-run38`, `lb-run38b`, `lb-run39`). Before 38b, `pg_stat_statements` was reset
(22:07:57Z) so its numbers are that run's alone. During 39, the hub's `http_request` lines were
captured in full (`~/.musterd/cloud/bench/out/run39-hub-http.log`, 63 872 in the load window).

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 37 | `6fd7aca` | 493 ms | 1 226 ms | 1 685 ms | 66 203 (50.9) | 3 | 477 ms |
| 38 | `6fd7aca` | 516 ms | 1 668 ms | 2 145 ms | 64 043 (49.3) | 1 | 536 ms |
| 38b | `6fd7aca` | 557 ms | 1 632 ms | 2 196 ms | 64 477 (49.6) | 4 | 600 ms |
| 39 | `6fd7aca` | 560 ms | **1 754 ms** | 2 341 ms | 63 838 (49.1) | 3 | 663 ms |

- **Run 37 was not noise, and it was the low one.** Three repeats agree at 1.6–1.75 s. Against runs
  32/36 (~800 ms on `dc09c35`) that is a real regression, or a drift in the environment that started
  at the same time — nothing below can tell those apart, because nothing below exists for `dc09c35`.
- **The database is not the bottleneck.** Run 38b's statements spent 133 s executing in ~1 400 s:
  about 2 ms of Postgres time per HTTP request against a 557 ms median. The hottest statement,
  interrupt-check's window read, averages 1.5 ms. The cumulative `members` and `messages` seq-scan
  counts that first suggested "every run's leftover team slows the next" were history: in 38b
  `members` took 277 seq scans and `messages` none. The cross-tenant growth hypothesis is refuted.
- **No request ever waits for a connection.** In run 39 `db_wait_ms` is 0 at p95 on every route; the
  10-connection pool is not the queue.
- **Two fifths of the bench's p95 is outside the handler.** The server measured p50 369 / p95 990 ms
  where the bench measured 560 / 1 754 ms on the same requests. The difference is the edge
  (Cloudflare → Fly proxy) plus whatever the Node process does before it emits `request`.
- **Inside the handler, the time is round trips and the event loop, not SQL.** Median request:
  6 transactions, connection held 163 ms, of which 54 ms was the driver waiting on queries — 8.7 ms
  per transaction at p50 for statements Postgres runs in 1–2 ms. The rest of the hold is JavaScript
  between awaits while the transaction is open. The heavy routes are heavy by transaction count:
  interrupt-check runs 15 per call to return nothing, `GET /inbox` 23, `POST /claim` 28. At ~430
  transactions/s, each with its `SET LOCAL ROLE` and `set_config` statements, the one vCPU sat at
  ~45% user, 15–17% softirq (8–10 on `dc09c35` runs) and ~30% idle — busy, not pinned.
- **The bisect as planned cannot run.** `6fd7aca` migrated the schema 92 → 94 (#2440, v93/v94) and a
  server refuses to boot on a schema that is not exactly its own, so neither `dc09c35` nor the
  `dc09c35` + #2440 + #2452 step can be deployed against this database. #2473 is excluded on the
  code: it rings the sync push loop, and Cloud never starts `sync_push` (`cloud/loops.ts`
  `NOT_ON_CLOUD`), so on the hub it walks an empty listener set.
- Falsify: a run on a `dc09c35` build against a Neon branch taken before v25's migration lands
  ~800 ms with this same `http_request` capture — then the regression is in the ten commits, and the
  capture says which routes moved. Lands ~1.6 s — the environment moved, not the build.
- Follows-up: lane 01M4VR3Y42VMAX57KJ1HNDCKYQ — run 40, that `dc09c35`-on-a-Neon-branch baseline with
  the request capture, to settle build vs environment; lane 01M4VR41VE5MABHT8SYC9N6X8X — the
  transaction count per request (interrupt-check's 15 for an empty answer), which costs the same on
  either build.

## 2026-10-14 — Cloud run 40: p95 537 ms on `1311808` — the ambient-touch cut (#2543) and shared read transactions (ADR 589, #2556) take a third off every request's database time (lane 01M4VVMNEX2CQB9TYSKA6CNGD4)

Same app machine (one vCPU), Neon 1 CU, shape and `performance-4x` bench as runs 37–39, team
`lb-run40`, on main `1311808` (Fly release after `6fd7aca`). The deploy carries two changes over run
39's build:

- #2543: the ambient touch every authenticated request runs is 4 statements shorter;
- #2556: consecutive same-scope `SELECT`s on a request's leased client share one transaction.

`pg_stat_statements` was reset at 01:00:18Z. The hub's `http_request` lines were captured as in run
39 (`run40-hub-http.log`, 66 922 in the load window).

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 32 | `dc09c35` | 355 ms | 791 ms | 1 203 ms | 66 306 (51.0) | 1 | 231 ms |
| 39 | `6fd7aca` | 560 ms | 1 754 ms | 2 341 ms | 63 838 (49.1) | 3 | 663 ms |
| 40 | `1311808` | **229 ms** | **537 ms** | 671 ms | 67 160 (51.7) | 1 | 235 ms |

The server's own timings, medians (p95 where marked):

| route | run 39 ms (p95) | run 40 ms (p95) | hold 39 → 40 | tx 39 → 40 | statements 40 |
| --- | --- | --- | --- | --- | --- |
| all | 369 (990) | 107 (427) | 163 → 51 | 6 → 2 | 5 |
| `GET /teams/:slug` | 466 (979) | 300 (455) | 116 → 42 | 4 → 2 | 4 |
| interrupt-check | 251 (972) | 56 (286) | 247 → 55 | 15 → 4 | 11 |
| `GET /report` | 178 (584) | 48 (126) | 177 → 47 | 6 → 2 | 5 |
| `GET /inbox` | 465 (1 563) | 107 (416) | 456 → 103 | 23 → 4 | 19 |
| `POST /claim` | 658 (2 060) | 244 (648) | 654 → 238 | 28 → 15 | 39 |
| `POST /messages` | 332 (1 242) | 88 (369) | 319 → 84 | 16 → 6 | 16 |

- **Round trips were the cost.** Statements per request barely moved: interrupt-check sends 11, about
  what #2543 left. Transactions per request fell 3–6×, and connection hold fell with them, while
  query time fell less (interrupt-check 82 → 38 ms). The hold that left was the BEGIN and COMMIT
  round trips around each read.
- **Most of the outside-the-handler gap closed too.** Run 39's bench p95 sat 760 ms above the
  server's; run 40's sits 110 ms above (537 against 427). `/health`, which touches the database once,
  went from p95 663 to 235 ms. Shorter requests hold the one event loop and their client for less
  time, so less queues behind them. Run 39's gap was mostly that queue, not the edge.
- **This passes the budget and beats the `dc09c35` baseline** (run 32's 791 ms). Whether `6fd7aca`
  regressed against `dc09c35` is now moot for capacity. Lane `01M4VR3Y42` (call it run 41, on a
  pre-migration Neon branch) would still answer it, if anyone needs the answer.
- **ADR 589's snapshot premise was wrong; vacuum kept up.** Sampled four times around +12 min,
  `idle in transaction` backends after a plain `SELECT` showed `backend_xmin` in 5 of 7 cases, in
  transactions 3–18 ms old. After the run, `presence` (655 autovacuums, the hottest churn) was at
  0 dead rows, vacuumed at 01:25Z. `messages` was at 13.9% dead, short of its 20% trigger and level
  with before the change. ADR 589 Consequences records the correction; the ledger entry is
  `docs/claims/entries/2026-10-14-read-run-holds-no-snapshot.md`.
- Falsify: a matched repeat on `1311808` lands p95 above 800 ms. Then run 40 was a low draw, as run
  37 turned out to be, and the gain is smaller than the table says.

## 2026-10-14 — Cloud run 41: p95 509 ms, a matched repeat of run 40 on `1311808` — the gain is the build, not a low draw (lane 01M4WAP0DVSSDFWM6J8WNMX4WG)

Same build as run 40 (staging still on `1311808`, no deploy), same app machine, Neon 1 CU, shape
(75/75/75, ramp 1 000 s, duration 1 300 s) and `performance-4x` bench, on a fresh team `lb-run41`.
`pg_stat_statements` was reset at 04:28:25Z; load ran 04:31–04:53Z. The hub's `http_request` lines
were captured as in runs 39–40 (`run41-hub-http.log`).

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 40 | `1311808` | 229 ms | 537 ms | 671 ms | 67 160 (51.7) | 1 | 235 ms |
| 41 | `1311808` | **214 ms** | **509 ms** | 654 ms | 66 107 (50.9) | 100 | 213 ms |

The server's own timings, from the hub's lines after the first minute:

| | run 40 | run 41 |
| --- | --- | --- |
| request p50 / p95 | 108 / 426 ms | 111 / 433 ms |
| `db_hold_ms` p50 | 51 ms | 51 ms |
| `db_wait_ms` p95 | 0 | 0 |
| interrupt-check p50 / p95, hold, tx, statements | 56 / 286 ms, 55 ms, 4, 11 | 57 / 290 ms, 55 ms, 4, 11 |
| `GET /teams/:slug` p50 / p95, hold | 300 / 455 ms, 42 ms | 308 / 465 ms, 41 ms |

- **Run 40's falsifier did not fire.** The repeat landed at 509 ms, under run 40's 537 ms, and the
  server's per-route numbers match it within a few milliseconds. The p95 gain from #2543 and
  ADR 589 is the build.
- **The 100 errors are one edge blip, not the app.** 50 viewer sockets closed 1006 in the same
  second (+659 s, 04:42:16Z) and all 50 were back within 3 s; 47 viewer `GET /teams/:slug` and 3
  interrupt-checks failed at the network layer in the same window. The hub logged no `ws_close`
  then (its six mid-run closes are at 04:48–04:52Z) and no 4xx or 5xx at all; its request rate dipped
  from 70–90/s to 10–28/s for 04:42:14–18Z and recovered. That is the pattern runs 36–37 traced to
  the path between the bench and the app, not to the server.
- **Vacuum kept up** (the check runs 40 added to every readout). At +13 min, 5 backends were
  `idle in transaction`, 4–5 of them holding a `backend_xmin`, the oldest 136 ms. After the run,
  `presence` (680 autovacuums) was at 0 dead rows, vacuumed at 04:54Z. `messages` was at 18.2% dead
  (13.9% after run 40), still short of its 20% trigger; it grows by about 2% a run and its next
  autovacuum is due.
- Falsify: the next readout shows `messages` past 20% dead with no autovacuum since 2026-10-13
  18:22Z. Then autovacuum is not reaching it under this load, and ADR 589's open read runs are the
  first suspect.

## 2026-10-15 — Cloud run 42: p95 524 ms, a second matched repeat on `1311808`; autovacuum fired mid-run and `messages` ended at 0.2% dead (lane 01M4YYPARBCV5N1HHK4J802WZN)

Same build as runs 40–41 (staging still on `1311808`, the same app machine `82dd559c7051e8`, Neon 1
CU), shape 75/75/75 with ramp 1 000 s and duration 1 300 s, `performance-4x` bench on a fresh team
`lb-run42`. The bench image was rebuilt at `84ad877`; `scripts/perf/demo-audience-load.mjs`, the
Dockerfile and `bench-run.mjs` are unchanged since run 41's `4ba6f3b`. `pg_stat_statements` was
reset at 05:01:29Z; load ran 05:02:49–05:24:30Z. The first launch (04:59Z) never started: the bench
machine was refused because `performance-4x` needs `BENCH_MEMORY_MB=8192` and the script's default
is 4096. Runs on this size set it.

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 40 | `1311808` | 229 ms | 537 ms | 671 ms | 67 160 (51.7) | 1 | 235 ms |
| 41 | `1311808` | 214 ms | 509 ms | 654 ms | 66 107 (50.9) | 100 | 213 ms |
| 42 | `1311808` | **216 ms** | **524 ms** | 679 ms | 65 948 (50.7) | 4 | 217 ms |

- **Three matched runs sit inside a 28 ms p95 spread** (509–537 ms), 476 ms under the 1 000 ms
  budget. Run 40 was not a low draw; the gain from #2543 and ADR 589 is the build.
- **The 4 errors:** one `GET /inbox` 502, and three viewer sockets closed 1006 at +897, +1 048 and
  +1 213 s, each back in 1–2 s (the bench reconnects). Unlike run 41 there was no 50-socket burst.
  The 502 is unexplained: this run did not capture the hub's `http_request` lines (runs 39–41
  did), and `fly logs --no-tail` had rolled past it. The per-route server timings of run 41's
  second table therefore have no run 42 counterpart; the load generator's own per-route table is the
  evidence here.
- **Vacuum kept up, and the falsifier did not fire.** Before the run `messages` was at 15.4% dead
  (20 589 dead, 113 322 live), last autovacuum 2026-10-13 18:22Z, 4 in all. Autovacuum ran on it at
  05:22:45Z, during the run, and the count went to 5. After the run it was at 217 dead of 116 054
  (0.2%). `presence` (703 autovacuums, the latest 05:24:43Z) held 75 dead rows, `lanes` 0, and
  `audit` was at 9.0% (last vacuum 2026-10-13 19:10Z). At the end the database held 180 idle
  connections and 1 active, none idle in transaction.
- **Trap, readout queries:** `~/.musterd/cloud/neon.env` names the retired Neon project `musterd-1b`
  (`steep-grass-78620414`), whose tables are empty. Staging's database is the project `musterd-cloud`
  (`long-thunder-03987236`), database `musterd`. Querying the wrong one returns zero rows and, on an
  archived project, wakes it.
- Falsify: a later run whose pre-run readout shows `messages` above 20% dead with a last autovacuum
  older than the previous run's start. Then the mid-run vacuum here was luck, not a rate that keeps up.

## 2026-10-15 — Cloud run 43: p95 645 ms on `60cf546`, the first new build since `1311808` — the server itself got faster (request p95 433 → 252 ms); the 100+ ms the bench saw was added outside the app (lane 01M50AWR5J413JRVYDVP57S40F)

Staging deployed from `60cf546b2e2d` (`origin/main` d498a2f plus the bench-run change below) at
17:52Z, which replaced the app machine: `8de50dfe952498` (`performance-1x`, 2 GB, iad) instead of
runs 40–42's `82dd559c7051e8`. Neon 1 CU, shape 75/75/75, ramp 1 000 s, duration 1 300 s,
`performance-4x` bench on a fresh team `lb-run43`. `pg_stat_statements` reset at 17:53:44Z; load
ran 17:56–18:18Z. `bench-run.mjs` now keeps EVERY hub log line, not only the socket lines (run 42
could not name its 502 or rebuild the server table), so this run has the per-route server timings
back: `~/.musterd/cloud/bench/out/hub-git-60cf546b2e2d-2026-10-15T17-55-16-816Z.log`, 66 751
`http_request` lines.

| run | build | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | `1311808` | 214 ms | 509 ms | 654 ms | 66 107 (50.9) | 100 | 213 ms |
| 42 | `1311808` | 216 ms | 524 ms | 679 ms | 65 948 (50.7) | 4 | 217 ms |
| 43 | `60cf546` | **354 ms** | **645 ms** | 849 ms | 65 303 (50.2) | 56 | **493 ms** |

The server's own timings, from the hub's lines after the first minute:

| | run 41 | run 43 |
| --- | --- | --- |
| request p50 / p95 | 111 / 433 ms | **62 / 252 ms** |
| `db_hold_ms` p50 / p95 | 51 ms / — | 53 / 170 ms |
| `db_wait_ms` p95 | 0 | 0 |
| interrupt-check p50 / p95, hold | 57 / 290 ms, 55 ms | 57 / 174 ms, 56 ms |
| `GET /teams/:slug` p50 / p95, hold | 308 / 465 ms, 41 ms | 73 / 285 ms, 39 ms |
| `GET /report` p50 / p95, hold | — | 43 / 122 ms, 43 ms |
| `POST /claim` p50 / p95, hold | — | 227 / 496 ms, 223 ms |

- **The lane's falsifier fired (p95 above 600 ms), and the build is not what fired it.** Inside the
  app every route got faster or stayed put: the roster read's p50 fell from 308 to 73 ms with its
  database hold unchanged at ~40 ms, so the 16 server commits between `1311808` and `60cf546` took
  CPU off the request path, not database time. The bench's view moved the other way on every route
  at once, `/health` included — one database touch, p95 213 → 493 ms. The gap between what the
  server measures and what the bench measures was ~100 ms at p50 in run 41 (111 → 214) and is
  ~290 ms here (62 → 354). That gap is the network between the bench machine and the app's process:
  Cloudflare, Fly's proxy, the app host. The deploy moved the app to a new machine on a new host;
  nothing else on that path changed.
- **No server-side error.** The hub logged 64 448 × 200, 2 229 × 201, 75 × 302, and no 4xx or 5xx.
  Of the bench's 56 errors, 32 are viewer sockets closed 1006 in two bursts (+262–277 s, 12 sockets;
  +1 115–1 136 s, 14 sockets), each back in 2–3 s; 20 are viewer `GET /teams/:slug` that failed at
  the network layer, 2 interrupt-checks, 1 `inbox-full`, 1 `/report`. The hub's own `ws_close` lines
  (89) are all 18:16–18:18Z, the bench shutting down; it logged no close in either burst, which is
  the run 41 pattern: the path between bench and app, not the server. No `event_loop_stall`,
  `sqlite_stmt_slow` or pool line in the whole log.
- **Database:** top statement by total time is the interrupt-check's inbox read, 18 104 calls at
  1.23 ms mean (22.3 s); the roster's status read is 582 calls at 10.9 ms mean (its new
  `UNION ALL` from ADR 601 is not in this build). The credential lookup ran 63 068 times at 0.11 ms.
- **Vacuum kept up.** `messages` 0.2% → 2.4% dead over the run (2 903 of 118 740), no autovacuum
  needed; `presence` vacuumed at 18:20Z (729 in all); `audit` at 10.0%, last vacuum still
  2026-10-13 19:10Z.
- **Next:** run 44, a matched repeat on `60cf546` on the SAME machine `8de50dfe952498`. Falsify: the
  bench's p95 stays near 645 ms with the server's request p95 near 252 ms — then the host or the
  edge path owns the ~300 ms and the lane for it is a Fly machine move or a bench-side traceroute,
  not a server change. If instead the bench's p95 returns to the 510–540 ms band with the server at
  252 ms, run 43's gap was a one-run edge draw and `60cf546` is the new, faster baseline.

## 2026-10-15 — Cloud run 44: p95 625 ms, a matched repeat of run 43 on `60cf546` and the same machine — the bench-side gap stays; the server table was lost to a stale checkout (lane 01M50DPNH301V2KS93HJPYFYCJ)

No deploy: staging on `60cf546b2e2d`, app machine `8de50dfe952498`, Neon 1 CU, shape 75/75/75,
ramp 1 000 s, duration 1 300 s, `performance-4x` bench on a fresh team `lb-run44`.
`pg_stat_statements` reset at 18:38:15Z; load ran 18:40–19:02Z.

| run | build | machine | p50 | p95 | p99 | requests (req/s) | errors | `/health` p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 41 | `1311808` | `82dd559c` | 214 ms | 509 ms | 654 ms | 66 107 (50.9) | 100 | 213 ms |
| 43 | `60cf546` | `8de50dfe` | 354 ms | 645 ms | 849 ms | 65 303 (50.2) | 56 | 493 ms |
| 44 | `60cf546` | `8de50dfe` | **353 ms** | **625 ms** | 819 ms | 67 347 (51.8) | 92 | **399 ms** |

- **Run 43's falsifier held: the elevated bench view is a property of this machine or its path,
  not a one-run draw.** p50 is identical (353 against 354 ms), p95 within 20 ms, and `/health`
  — one database touch — is still ~180 ms above the `82dd559c` band at p95. Both runs on the new
  machine sit 100–130 ms above both runs on the old one at every route.
- **No server table for this run, and that is this seat's error.** The bench was launched from a
  checkout fetched BEFORE #2633 merged, so the old `bench-run.mjs` ran and kept only `ws_close`
  lines: the hub file (`hub-git-41fffd34d3e8-…`) holds 98 socket lines and nothing else. The
  launch line reads `hub log (musterd-cloud, socket lines)`; the new script prints `every line;
  socket lines echoed`. Check that line before walking away from a launch. Run 43's server numbers
  (request p50 / p95 62 / 252 ms on this build) stand as the only server-side measurement of
  `60cf546`.
- **Errors, 92:** 48 viewer sockets closed 1006, 47 back in 2–4 s — one burst of 25 at
  +1 188–1 229 s and a scatter of 23 across the run (+212 s to +1 019 s), more spread than run 43's
  two bursts; 22 viewer `GET /teams/:slug`, 12 `GET /report`, 6 interrupt-checks and 3 others
  failed at the network layer; one interrupt-check answered 502. The 502 cannot be traced here for
  the reason above.
- **Database, from `pg_stat_statements`:** the interrupt-check's inbox read is again the top
  statement, 18 098 calls at 1.35 ms mean (24.5 s, run 43: 1.23 ms); the credential lookup 65 051
  calls at 0.12 ms. Database time per request did not move between the two runs.
- **Vacuum:** `audit` finally autovacuumed (19:02Z, 10.0% → 0.1% dead, its first since
  2026-10-13 19:10Z); `messages` 2.4% → 4.4% (5 612 of 121 449), no vacuum needed; `presence`
  vacuumed at 19:05Z (754 in all).
- **Next:** move the app off `8de50dfe952498` — a no-change redeploy of `60cf546` lands a new
  machine, usually on another host — and run 45 as a matched repeat WITH the new script's hub log.
  Falsify: the bench's p95 stays in the 625–645 band and `/health` p95 above 350 ms on the new
  machine — then the host is not the variable and the next lane is a traceroute from the bench
  machine through Cloudflare to the app. If it returns to the 510–540 band with `/health` near
  215 ms, the host was.

## 2026-10-15 — §8.4 rolling schema deploy: an expand-phase change across two servers under load, then the old build refuses to boot (lane 01M3Z44EMJAEEEMAR3P6Z2X24T)

Spec §8 item 4. Staging went from one machine to two (`fly scale count 2`, run by nick), both on
`60cf546` at schema 96. ADR 608's team affinity is what makes two machines safe for the in-process
Hub. The expand-phase change was real, not staged for the test: main had landed v97
(`audit_archive`, #2655) and v98 (#2667) since `60cf546`.

1. **Rehearsed on a Neon branch first.** Branch `rehearse-v97-2026-10-15` of staging, migrated with
   `scripts/cloud/migrate.mjs` on the branch's direct owner URLs: 96 → 97 clean, `audit_archive`
   present, 121 445 messages intact.
2. **Deploy under load.** Bench `lb-run45`, 40 humans / 40 agents / 40 viewers, ramp 240 s,
   duration 900 s, `performance-4x`, whole hub log kept. Three minutes in,
   `CLOUD_DEPLOY_STRATEGY=rolling node scripts/cloud/deploy.mjs` migrated staging 96 → 98 as the
   pre-rollout step (22:10:52Z) and began replacing machines one at a time.

| | value |
| --- | --- |
| requests (req/s) | 26 149 (29.1) |
| p50 / p95 / p99 | 296 / 472 / 614 ms |
| hub status codes | 21 699 × 200, 1 668 × 201, 32 × 302, 8 × 429, 1 × 401, **no 5xx** |
| bench errors | 91: 65 viewer sockets closed 1006, all 65 back in 2–3 s; 17 network-layer; 8 × 429; 1 × 401 |

- **No refused request.** The 8 429s are `POST /oauth/<team>/register` during the client ramp
  (the registration rate limit, before the roll began) and the 401 is one interrupt-check; none is
  the deploy. The old build on machine 2 served the newer schema the whole time, which is what
  expand/contract promises: 22 928 requests from 22:05 to 22:21Z, every one of them once machine 1
  stopped passing at 22:11Z.
- **The rehearsal caught a defect in ADR 608, and the roll stopped at machine 1 of 2.** Fly's
  checker calls `/health` with `Host: health.musterd.dev`; the affinity code read that host as a
  team named `health` and the non-owner answered `fly-replay`, so the check never passed. #2675
  limits HTTP replays to a team named in the path. A failed health gate leaves the app mixed, one
  machine per build, and that is a safe state: the next deploy finishes the roll.
- **The second deploy did not reach the roll** (22:24Z): the migrate machine pulled its image in
  39 s and then stayed `created` for 10 minutes. A Fly host-side stall; `deploy.mjs` timed out and
  destroyed it, nothing was changed, and staging kept serving. The third deploy (`e695906`, 22:29Z)
  migrated clean and rolled both machines. Both list each other in `affinity_machines`.
- **Affinity works live.** Twelve requests for `/teams/lb-run45` through Cloudflare: the non-owner
  `801650b60e0578` answered all of its share with `307` + `fly-replay`, the owner `8de50dfe952498`
  served every one, and the client saw only the owner's answer.
- **The old build refuses to boot.** `fly machine run registry.fly.io/musterd-cloud:git-60cf546b2e2d
  --rm` with `fly.toml`'s `[env]` passed as `-e`, against the migrated database: `✗ schema newer
  than this build: database is at schema 98, this build knows 96`, exit 1.
- **Spec §8 increment 1 acceptance:** item 1 (load) met by runs 40–44; items 2 and 3 (tenancy,
  loopback audit) landed earlier; item 4 met here. Falsify: a later rolling deploy under load whose
  hub log holds a 5xx from the deploy window, or an old image that boots against a newer schema.
