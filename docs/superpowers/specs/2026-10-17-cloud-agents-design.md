# Cloud agents: a team's agents run on musterd's compute

**Date:** 2026-10-17
**Seat:** fifty
**Status:** design from a brainstorm with nick on 2026-10-17 (decisions in §7). Nothing is built.
**Lane:** `01M50SQBJGHRY9HKPDH8WMDBDK` (goal `cloud-agents`)
**Decision:** [ADR 647](../../decisions/647-cloud-agents-compute-home.md)

## 1. What this is for

musterd Cloud hosts teams; the native harness runs agents on a member's machine. Nothing designs
the third thing: an agent that runs on **musterd's compute**, so a team's agents keep working when
no member's machine is up (goal `cloud-agents`). ADR 588 §8 names the resident seat "the local
half of Cloud increment 8" — this design is the cloud half. Cloud increment 8
(`01M3TTZP5HF8QZZW0SA8VZAXSJ`, Cloud spec §9 #8) is its implementation lane, later by design;
ADR 463 covers sponsor-hosted agents on a member's own machine until then.

**Success, in nick's words:** your agents keep working when your laptop is closed: musterd runs
them for you, on your key, metered and on the record.

**Goals**

- One mechanism for every hosted seat: the same seat, key and engine as a laptop resident seat
  (ADR 588), moved onto musterd compute. ADR 463's sponsor-hosted shape is the provisioning model.
- Isolation between teams is a machine boundary first, a software jail second — never the jail
  alone.
- Every wake is priced where it happens (ADR 583 gateway), every action attributed to the seat
  (ADR 624 attestation), and the sponsor can see and stop the spend.
- A phased rollout: each phase is shippable and measured before the next is taken.

**Non-goals**

- A scheduler or placement service. Hosts pull wakes; the hub grants leases, as today.
- Minting seats on demand. Seats are roster members a human made; cloud agents host seats, they
  do not invent them.
- musterd-billed or musterd-native models in the first phases (§4.2, phase 4).
- Running a team's daemon and its agents' compute on the same machine (§4.1).

**Anti-goals (a failure even if it works)**

- An agent's workspace, key or process can reach another team's data, or the team server's
  database. The agent machine holds no team database, ever.
- A sponsor's credential copied somewhere the sponsor cannot revoke it on its own.
- A hosted seat that keeps spending while its sponsor believes it is parked.
- A cloud agent that only works on musterd's own team (dogfood-only by construction).

## 2. Words

- **Cloud agent:** a member seat whose wake actuator and harness run on musterd-operated compute
  instead of a member's machine. A normal member otherwise: it claims, submits and is judged.
- **Sponsor:** the human member who created the agent and whose key it spends (ADR 463). The
  sponsor's authority scopes everything the cloud host may do for that seat.
- **Agent machine:** the compute a cloud agent runs on (per phase, §4.1). It holds seat workspaces
  and seat credentials; it never holds a team database.
- **Hosted team:** a team whose daemon runs on musterd Cloud (Topology C, ADR 461).

## 3. Constraints found before design

- **The resident engine is the executor.** ADR 588's pi engine behind `AgentLoopEngine` already
  runs a seat in-process with our own jailed working tools (`engines/jail.ts`), metered by the
  ADR 583 gateway, keys in the keychain (ADR 605). A cloud agent is that seat with its actuator
  on musterd compute; no new engine.
- **Sponsor-hosted provisioning exists.** ADR 463: a sponsored agent runs under its sponsor's
  identity, provisioned by a host key only its sponsor minted; `host_provisions` tracks
  pending→claimed→ready; the server filters wake leases for that key to sponsored seats. Cloud
  agents reuse the table and the authorizer; the host key is musterd-minted, sponsor-scoped.
- **A per-seat Fly machine has a measured precedent.** `delta` ran a shared-cpu 2 GB Fly machine,
  never auto-stopped, with its own daemon as a joiner (ADR 390, `docs/perf/cloud-seat.md`, retired
  2026-10-15). Its friction list is the phase-2 (joiner) risk list: `bound_elsewhere` until
  `node trust`, per-daemon agent keys, bare-folder provisioning.
- **The business plan already prices this shape.** ADR 461 / the business plan: BYOK wakes use no
  model credits; **always-on hosted seats are a credit sink** — credits cover what musterd spends
  (compute). musterd-billed models would be a second sink, later.
- **Subscription seats need a login on the machine.** A Claude Code / Codex subscription seat
  depends on a human having logged that harness in there (pre-registered-work design §3). On
  musterd compute that is the sponsor's login, made by the sponsor in a device-auth flow; it
  cannot ride the resident engine, which is API-key only.
- **The console proves who a person is, never what they run.** Provisioning a cloud agent is a
  team-server act under the sponsor's authority (cloud spec §4.2); the console is not in the path
  beyond sign-in (ADR 620).

## 4. The design

### 4.1 Where it runs — phased

- **Phase 1 — one Fly Machine per seat.** A Fly Machine is a Firecracker microVM, so per-seat is
  one small microVM per hosted seat, not a VM fleet. It auto-stops when idle and starts on the
  wake path (§4.4). Isolation between teams is the machine boundary; the workspace jail
  (`engines/jail.ts`, plus the OS sandbox lane already on the board) is defence in depth inside
  it. Delta's machine is the sizing precedent; phase 1 measures cost per seat-day before any
  sharing is considered.
- **Phase 2 — one agent machine per team.** When phase 1's cost data says per-seat is too heavy,
  a team's hosted seats share one **agent machine** — never the team's daemon machine. The daemon
  holds the team database; agent compute beside it would put a jail escape one step from the
  data. Seats of one team share a kernel; teams never share a machine in this phase.
- **Phase 3 — a shared pool, only if the economics force it.** Many teams' seats on shared hosts,
  each in a container or microVM under the jail. Taken only with phase 1–2 isolation evidence and
  its own ADR; a shared host where the jail is the only boundary is the anti-goal.

### 4.1b Database topology — no new store, no SQLite sync into Cloud

The team server of record is the only store a cloud agent touches, and its engine depends on
where the team lives: SQLite (one team per file) on a member's daemon, Postgres (Neon,
`team_id` + row-level security, ADR 479) on musterd Cloud. A cloud agent adds no database of
either kind:

- **Phase 1 (hosted team): the agent machine runs no team daemon and holds no team store.** It
  is a remote actuator and engine host: it claims wake leases and reports over the hosted
  server's API, and its only local state is the seat workspace, the host registry and the
  seat's credentials. Building it as a daemon with its own SQLite database that syncs into the
  hosted team is refused — SQLite sync is replication between SQLite daemons, and a hosted
  Cloud team takes no SQLite joiner into its Postgres database.
- **Phase 2b (laptop hub) is the only sync shape:** there both hub and agent machine run SQLite
  daemons and replicate as delta did, because the hub itself is SQLite.
- **Metering, audit and credits are team-server records** (Postgres for a hosted team), written
  by the server from the agent's reports; the agent machine keeps no authoritative ledger.
- **Any new server data is dual-dialect by construction:** the portable migration ladder (or an
  explicit `{sqlite, postgres}` pair) from v81 on, `team_id`/RLS scoping on Postgres, and store
  tests on both drivers (`withDrivers`). Provisioning state lives on the team server, never in
  the console's separate accounts database.

### 4.2 Whose key, what musterd charges — phased

- **Phase 1 — BYOK.** The sponsor's API key, held per seat in the host keychain (ADR 605),
  revocable by the sponsor alone. Model spend is the sponsor's, metered and shown by the ADR 583
  gateway; it uses **no credits**. Credits buy the seat's compute (machine uptime), the business
  plan's always-on sink. Spend caps (ADR 611/639/641) apply unchanged: a capped seat stops.
- **Phase 2 — subscription-login seats.** A sponsor may instead log a harness subscription in on
  the agent machine, in a device-auth flow they complete themselves; the seat then runs that
  harness (not the resident engine) under the sponsor's subscription. The login is the sponsor's
  credential on musterd compute: named as such at provisioning, revocable by the sponsor ending
  the session, and recorded per wake like any model attestation.
- **Phase 4 (later, own decision) — musterd-billed and musterd-native models.** musterd's key
  behind the same gateway, resold in credits. Nothing in phases 1–2 presumes it beyond the
  gateway already pricing every call.

### 4.3 Which teams — hosted first

- **Phase 1 — hosted teams only.** "Always on" is the product; a laptop hub sleeps. Provisioning,
  console sign-in and sponsor authority all assume an always-up hub.
- **Phase 2 — laptop-hub teams, as a joiner.** The agent machine enrols at the member's hub and
  syncs like delta did, on the same provisioning code (ADR 463's "Cloud later on the same
  code"). Delta's friction list (hub-side `node trust`, per-daemon keys) is fixed or named in
  the runbook before this phase opens.

### 4.4 How a seat gets its key, workspace and life

Provisioning is ADR 463 with a musterd-operated host:

1. A sponsor creates the agent (existing sponsored-agent mint, cap-gated per ADR 459) and asks
  for it hosted. The server writes a `host_provisions` row, sponsor-scoped.
2. The cloud host — running under a host key the server minted for that sponsor — claims the
  provision, stands up the workspace (repo, seat file, MCP wiring), and stores the sponsor's
  key in the machine keychain. The key is never in the provision row, an act, or a log.
3. Residency enrols for that host; the first wake greets the sponsor, as sponsor-hosted does.
4. **Lifecycle.** Park = the sponsor parks the seat: no leases are granted and the machine
  auto-stops; parked costs nothing but storage. Wake = a directed act or pull finds the seat
  enrolled; the host starts the machine, the actuator polls, the lease is granted, the engine
  runs. **For the pilot (nick, 2026-10-17), a parked machine is started by the operator** —
  no server-held Fly API token and no inbound autostart endpoint is built yet; the pilot
  measures how often a parked seat is actually woken before either automation is paid for.
  Stop = the sponsor revokes the key or the seat; the machine is destroyed, the workspace
  volume kept or destroyed at the sponsor's word, recorded either way.
5. **Cost record.** Machine uptime is metered per seat and charged in credits; model calls are
  priced per wake by the gateway. `/report` shows both, per seat, with the sponsor's caps.

### 4.5 Isolation between teams

- Machine boundary (phase 1) or per-team agent machine (phase 2); no cross-team machine sharing
  before phase 3's own ADR.
- Inside a machine: one workspace per seat, the tool jail scoped to it, no network beyond the
  gateway and the team server, seat credentials per (seat, host) chmod-600 and individually
  revocable (ADR 344/395 as sponsor-scoped by ADR 463).
- The agent machine holds no team database, no team agent key beyond its seats' scoped
  credentials, and no other team's workspace or key.
- A stolen agent machine's blast radius is the seats enrolled on it; revoking a host key stops
  its leases (ADR 463's filter).

## 5. What is left to the builder

- Machine sizing and the auto-stop/start latencies (delta's log is the baseline); the credit
  price of a seat-day, from phase 1's measure, proposed to nick before credits are charged.
- The cloud host's own implementation (a `musterd host` on Fly with a musterd-minted key, or a
  small provisioning service) — one mechanism, named in the phase-1 lane.
- The keychain on a Fly machine (ADR 605 assumes a local keychain; the cloud equivalent and its
  threat model are the phase-1 lane's security read, with the security role).
- Subscription device-auth UX for phase 2, and whether the provider's terms allow a sponsor's
  subscription on musterd compute — answered in writing before phase 2 opens.
- Tests: a sponsor cannot provision onto another sponsor's host key; a parked seat is granted no
  lease and its machine stops; a wake after park starts the machine and leases; spend caps hold
  a cloud seat exactly as a local one; revoking the host key ends its leases.

## 6. Increments

Each is a lane under goal `cloud-agents`. Cloud increment 8 (`01M3TTZP5HF8QZZW0SA8VZAXSJ`)
depends on this brainstorm and is re-scoped by phase (abandoned as a build lane 2026-10-17;
the phase lanes below carry the work, and phase 1 builds its credits on Cloud increment 7's
billing, lane `01M3TTZJGXAGF3S0KKFST1YXYM`).

1. **ADR 647** (this design's decision; lane `01M50SQBJGHRY9HKPDH8WMDBDK`).
2. **Phase 1 build** (lane `01M55Y58R3D1CCBERNJCXBJZQ9`): per-seat Fly Machine, BYOK, hosted
   team — provisioning via ADR 463's provisions with a musterd-minted sponsor host key,
   resident engine, gateway metering, park/wake/stop, per-seat cost in `/report`. Ends with one
   real sponsored seat living on musterd compute for a week (the pilot reading).
3. **Phase 2a** (lane `01M55Y5DQHKY2235KKA79T06NH`): per-team agent machine, if phase 1's cost
   data calls for it.
4. **Phase 2b** (lane `01M55Y5E28EPF6RNTCREYKQ6CP`): laptop-hub joiner, delta's friction list
   discharged.
5. **Phase 2c** (lane `01M55Y5E5S6TM5JW9TW8AB7Y46`): subscription-login seats.
6. **Later (own ADR)** (lane `01M55YD1AGQ1ZS5G4NTCFAJPA0`): musterd-billed / musterd-native
   models; a shared pool — taken only on a phase 1–2 reading that calls for them.

## 7. Open questions settled in the brainstorm (nick, 2026-10-17)

- Phased compute, not one shape: per-seat microVM first (a Fly Machine already is a microVM;
  "per seat" is not a VM fleet), per-team agent machine on cost evidence, shared pool only if
  forced. Agent compute never shares the team daemon's machine.
- BYOK first, charging compute in credits; subscriptions are a real second phase (the sponsor's
  own login on the cloud host), and musterd-billed/native models a later one. All three meter
  through the ADR 583 gateway, so the record shape never changes.
- Hosted teams first, laptop-hub joiner second on the same provisioning code, because always-on
  is the product and a laptop hub sleeps.
