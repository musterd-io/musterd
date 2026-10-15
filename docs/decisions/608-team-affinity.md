# 608 — Team affinity: one server owns a team at a time; other servers replay to it

- Status: accepted
- Date: 2026-10-15

## Context

The Cloud design (spec §3) draws N ≥ 2 stateless app servers where "any server serves any team",
with presence fan-out between servers over Postgres `LISTEN/NOTIFY` on a direct connection. Cloud
has run ONE machine since 2026-10-02, because the Hub (`transport/hub.ts`) is an in-process
connection registry and a second machine would not see the first's WebSocket pushes. nick deferred
the fan-out lane (`01M3Z4EMH3`) until the §8.1 load test had real numbers.

Those numbers exist. Runs 40–44 (`docs/perf/daemon-load-baseline.md`) put 75 humans + 75 agents +
75 viewers on one `performance-1x` machine at p95 509–645 ms against the 1 s budget, with the
server's own request p95 at 252 ms on the current build. One machine carries the demo population
with margin. What a second machine is for is the §8.4 rolling schema deploy (two servers sharing a
database with no refused request) and headroom across teams, not more capacity for one team.

What has to cross servers, counted on 2026-10-15: 91 Hub call sites. 22 are pushes (`broadcastTeam`,
`broadcastFirehose`, `deliver`, `deliverToAdmins`), which a bus carries mechanically. 46 are
displacement (`connsForMember` + `close`, with the ADR 068/092/489 workspace and surface predicates)
and claim approval (`addPending`, `getConn`, `deliverClaimDecision`: an admin's HTTP approve finds a
held pending socket by id). Those are not "send a frame"; they are "find this socket and act on it",
and each becomes a cross-server round trip with a new failure mode under a bus. The ADR 092 grace
reap decides from local socket state.

## Problem

Two servers need a rule for who serves a team's sockets, and the spec's rule (a shared bus, every
seat rule rebuilt as a cross-server operation) prices the 22 easy sites and not the 46 hard ones.

## Decision

1. **One server owns a team at a time.** The owner of a team is the machine with the highest
   `sha256(slug \0 machine_id)` over the live machine list (rendezvous hashing). Every server
   computes the same answer from the same list; there is no registry, no election, no shared state.
2. **A non-owner hands the request to the proxy.** For a request or WebSocket upgrade that names a
   team (by host or path) the non-owner answers `fly-replay: instance=<owner>` and the Fly proxy
   replays it there. Global routes (`/health`, the apex) are served where they land. A request the
   proxy has already replayed (`fly-replay-src` present) is served where it lands, so two servers
   that disagree about the list for a moment cannot bounce one request between them.
3. **Inside the owner nothing changes.** The Hub stays in-process; all 91 call sites and every
   seat rule keep their single-process semantics and their ADRs.
4. **Losing a team closes its sockets.** The machine list is re-read from Fly's internal DNS
   (`vms.<app>.internal`) every 5 s. When a team this server has served is no longer its own, the
   server closes that team's connections; the clients reconnect and the proxy replays them to the
   new owner. A socket that claims against a team this server no longer owns is closed (1012) at
   the claim. A team is never knowingly served from two servers.
5. **Fail open to one server.** With no `FLY_MACHINE_ID` (self-hosted, tests) or an unreadable
   list, every team is local, which is the behaviour Cloud has had since 2026-10-02. An empty list
   is never evidence of being alone; a list that omits this machine is stale and is served, not
   replayed to.
6. **The capacity of one team is one machine.** This is a stated limit of the design, not an
   accident of it. Spec §3's "any server serves any team" is amended to "any server serves any
   team's GLOBAL routes; a team's own routes and sockets are served by its owner". The bus design
   (spec §3's `LISTEN/NOTIFY`, or a poll of the message sequence reusing the federation fold path)
   stays on the roadmap for the day one team outgrows one machine.

## Consequences

- Two machines can run now: `deploy/cloud/fly.toml` may go to `count = 2` with a rolling strategy,
  which is what the §8.4 rehearsal needs (lane `01M3Z44EMJ`).
- A deploy moves ownership: teams whose owner is the retiring machine reconnect once, within the
  ~2 s every bench run measured for a 1006 close. A deploy under load is a brief reconnect storm
  for those teams, not downtime.
- During the few seconds two servers hold different machine lists a team can be double-owned: a
  displacement in that window is not enforced across the pair. Decision 2's replay guard bounds the
  damage to that window, and the guard trusts `fly-replay-src` only when it names a live peer other
  than this machine, so a client cannot spoof its way onto a non-owner.
- The module tracks no per-team state of its own: on a list change the server walks the teams the
  Hub holds sockets for and closes those it no longer owns, so a flood of invented team hosts costs
  the affinity module nothing.
- `fly-replay` buffers request bodies up to 1 MB; every musterd request body is far under it.
- Spec §3 and `03-server.md` are amended in this change; `fly.toml`'s one-machine note is replaced.

## Observability & Evaluation

- **Traces:** `affinity_machines` (the list changed, with the list and self), `affinity_lost`
  (team, sockets closed, new owner), `affinity_list_unreadable` (once). A replay is a 307 with a
  `fly-replay` header in the proxy's log, not the app's.
- **Eval:** `cloud/affinity.test.ts` (determinism, spread, minimal movement on removal, the four
  local cases, the stale-list case, TXT parsing, onLost), `cloud/affinity-http.test.ts` (a non-owner
  replays a team request and a team upgrade, serves `/health` and a replayed request; the owner and
  an affinity-off server serve locally), `transport/hub.closeTeam.test.ts`.
- **Experiment:** the §8.4 rehearsal on staging at `count = 2`: a bench run across a deploy, with the
  hub log kept. Falsify this ADR if a team's clients see more than one reconnect per deploy, or if
  the replay rate (307s at the proxy) stays above a few per cent after the list converges.
