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
