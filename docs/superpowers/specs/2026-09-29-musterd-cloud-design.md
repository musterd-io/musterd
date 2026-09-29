# musterd Cloud — design

- Date: 2026-09-29
- Author: fifty (lane `01M3MT842AQ19VENMPZ8HYAVX2`, re-scoped from "ADR 451's durable demo host")
- Goal: `cloud` (hosted teams: sign up, get a team, everyone joins over HTTPS with nothing to run)
- Status: proposed as [ADR 475](../../decisions/475-cloud-hosted-teams-postgres.md)
- Builds on: [ADR 461](../../decisions/461-pricing-and-business-model.md) (hosted is the paid
  product; self-hosted stays free and uncapped), [ADR 451](../../decisions/451-public-demo-ordinary-members.md)
  (the one-Machine-per-team eval this supersedes), [ADR 439](../../decisions/439-bootstrap-adoption-explicit.md) /
  [ADR 440](../../decisions/440-successor-expiry-server-set.md) (the scoped, expiring seat credential),
  [ADR 450](../../decisions/450-join-link-seat.md) (invite links), [`deployment-topology.md`](../../design/deployment-topology.md)
  (Topology C, "named, not scheduled" — this schedules it), [`PRIVACY.md`](../../../PRIVACY.md).

Every decision below was settled with nick on 2026-09-29, one question at a time. Where a choice
was between real alternatives the alternatives are recorded, so the next person can see what was
weighed rather than only what won.

## 1. Why now

The demo ran (2026-09-27) on `musterd-loadbench`: a database in `/tmp`, a direct `fly.dev` route,
nothing durable. ADR 451 designed a durable single-Machine host for it and that host was never
provisioned. nick's direction: no more demo-only stopgaps — **build for actual users**. The first
tenant is us: the `revive` team moves onto Cloud and dogfoods it. Strangers come after billing
(ADR 461).

## 2. Constraints that shaped it

1. **One team, one authority.** A team has exactly one server of record
   (`deployment-topology.md` §2). Cloud is that authority for a hosted team; agents may run
   anywhere and reach it over HTTPS. A split self-hosted + Cloud authority is federation (ADR 325),
   not this.
2. **Self-hosted stays first-class and never phones home** (`PRIVACY.md`, ADR 461 fact 3). Cloud
   is opt-in. Nothing in the self-hosted daemon calls musterd.io. Import to Cloud and export back
   to self-hosted are both real features, so there is no lock-in.
3. **Hooks are on the critical path of every tool call.** A seat's PreToolUse gate runs before
   every edit. Whatever Cloud does, a slow or dead server must not stall an agent, and must not
   silently switch the gates off either.
4. **Most secure approach available**, in nick's words, for anything that can create, export or
   delete a team.
5. **The team building this is small.** Anything that turns us into a database-operations team is
   a cost we counted.

## 3. Shape

```
                 musterd.io            app.musterd.io              <team>.musterd.dev
                 (site)                (account console)           (team endpoints)
                    │                        │                             │
                    └──────── Cloudflare edge: wildcard TLS, WAF, per-team rate limits ────────┘
                                             │
                             ┌───────────────┴────────────────┐
                             │  Fly: stateless app servers    │   any server serves any team
                             │  (the daemon in cloud mode)    │   N ≥ 2, rolling deploys
                             └───────────────┬────────────────┘
                                             │  direct conn for LISTEN/NOTIFY, pooled for the rest
                             ┌───────────────┴────────────────┐
                             │  Neon Postgres (plain PG)      │   RLS per team; PITR; branches
                             └───────────────┬────────────────┘
                                             │  nightly encrypted pg_dump per team
                                       Cloudflare R2 (separate account, 30 days)
```

- **Domains.** `musterd.io` is the site. `app.musterd.io` is the account console (accounts,
  team registry, create / import / export, the identity provider the team servers trust).
  `<team>.musterd.dev` is a team's API, WebSocket, MCP, OAuth, join and `/live` — one origin per
  team, so browser isolation is per team. `musterd.ai` and `musterd.build` are held (candidates:
  hosted agents, status).
- **App tier.** The existing Node daemon, started in **cloud mode** (`MUSTERD_MODE=cloud`, §5).
  It is stateless: any server serves any team, so there is no router, no team→server registry, no
  Volume, no relocation. Presence fan-out between servers rides Postgres `LISTEN/NOTIFY` on a
  direct (non-pooled) connection; everything else goes through the pooler.
- **Database.** Managed Postgres on Neon, one database, one schema, `team_id` on every team-owned
  row, **row-level security** keyed on a per-request setting. The schema is plain Postgres — no
  Neon-only feature is depended on — so the vendor can be swapped with `pg_dump`/restore.
- **Backups outside the vendor.** Nightly encrypted `pg_dump` per team to R2 in a separate
  Cloudflare account, kept 30 days; a restore drill once a month (§7).

### 3.1 Why a stateless tier over Postgres, not a file per team

Section 1 of this design was first approved as "one SQLite file per team on a Fly Volume behind
a router". It was re-decided the same day after two reframes:

- **SQLite's speed does not matter in Cloud.** A hook already crosses the internet to reach the
  team server (50 ms and up). A database hop inside the datacenter (~1 ms) is noise beside it.
  Microsecond reads only matter for the laptop daemon — which stays.
- **A file per team makes us build the routing layer.** If a team's data lives on one Machine we
  own the router, `fly-replay`, the team→server registry, Volume management, relocation and
  per-file migrations. A database every server can reach removes all of it.

Four candidates were weighed with sunk cost set aside (the existing store is 60 server files
calling `better-sqlite3` directly, 50 tables, one `musterd.db` for every team — 293 MB after
months of dogfood, 17.7k messages):

| | Postgres (managed) | Cloudflare Durable Objects | SQLite per team on Fly | Turso / libSQL |
| --- | --- | --- | --- | --- |
| Model fit | `team_id` + RLS | one object = one team, the closest fit there is | one file = one authority | one DB per team |
| App tier | stateless | stateless by construction | **stateful; we build routing** | stateless |
| Isolation | logical (RLS) | physical | physical | physical |
| Realtime | LISTEN/NOTIFY | WebSocket hibernation, alarms | in-process | our own fan-out |
| Backups | vendor PITR + branching | 30-day PITR built in | ours (Litestream, our runbook) | vendor |
| Self-hosted daemon | PGlite in-process, or a two-backend store | `workerd` — not a story we'd ship | identical to today | one client, two URLs |
| Lock-in | none that matters | strong (DO API is Cloudflare-only) | none | medium; vendor pivoted twice |
| Runtime | keep Node + Hono | **rewrite onto Workers**; store and process model don't port | keep everything | keep Node; store goes async |
| Rewrite | store layer | server + store | split one file into many | store layer |

Durable Objects is the answer for a Cloudflare-native company: best model fit, lowest ops,
strongest isolation. It costs a server rewrite onto a runtime that cannot be self-hosted, and the
laptop daemon is how every seat works today. Postgres is the only option that keeps one codebase,
one runtime, a stateless app tier, and gives the research corpus (ADR 056) plain SQL. Its
weakness is logical tenancy, which §8 turns into a test.

### 3.2 Why Neon, for now

Neon vs Fly Managed Postgres (facts from the vendors' docs, 2026-09-29):

| | Neon | Fly Managed Postgres |
| --- | --- | --- |
| Latency from Fly `iad` | ~1–2 ms cross-provider to `us-east-1`, TLS | sub-ms, same private network |
| Migration rehearsal | **branching**: copy prod, run the migration, discard | none; rehearse against a restore |
| Postgres upgrades | managed | "under development" (Fly MPG docs) |
| PITR | 6 h free / 7 d Launch / 30 d Scale | included, window undocumented |
| Failure domain | independent of the app platform | app and DB fall together |
| Cost at dogfood scale | < $40/mo (always-on ~0.25 CU for the LISTEN connection + storage) | Basic $38 + storage |
| Vendor direction | acquired by Databricks; developer product continues | new product on a platform we already carry |

Decision: **Neon**, because branching and managed upgrades address the two operational things
we are worst at (forward-only migrations with no rehearsal; version upgrades). Revisit **after
performance data from dogfood, and again at billing** (ADR 461 increment). The schema stays plain
Postgres so the revisit is a `pg_dump`, not a rewrite.

### 3.3 The laptop daemon: PGlite spike first

Self-hosted keeps running in-process with no service to install. Two ways to keep one storage
layer:

- **PGlite** (Postgres compiled to WASM, in-process, file-backed): one SQL dialect everywhere,
  one store layer. Maturity and hook-path latency are the unknowns.
- **Two backends** behind one store interface (SQLite on the laptop, Postgres in Cloud): known
  to work, twice the surface to keep correct.

The PGlite spike runs **first, time-boxed to two days**, before any store-layer change: boot the
daemon on PGlite, run the server suite, measure hook-path latency against SQLite. Pass → one
dialect. Fail → the two-backend interface. Either result shapes every store change after it,
which is why it cannot run in parallel or later.

## 4. Identity and data flow

The split: the **console owns who a person is**; each **team server owns what they are on the
team** (member, role, seat, credentials). A team server never sees a password or a GitHub/Google
token.

### 4.1 Account sign-in

- Web: GitHub or Google (OIDC) or an email magic link, at `app.musterd.io`. Ordinary session
  cookie.
- CLI: `musterd login` is OAuth against the console. With a local browser it uses the
  authorization-code + PKCE redirect to a localhost callback; over SSH, on a headless box, or with
  `--device`, it falls back to the device-code flow (RFC 8628), picked automatically as `gh auth
  login` does. The refresh token is stored in the client config, mode 600, one profile per
  console host. Hard rule 5 applies: it is never logged.

### 4.2 Membership lives on the team server

Alternatives weighed: the console keeps the member list (GitHub-org style; membership then lives
in two places and export has to rebuild it); a split (console keeps owners for billing, team
keeps the rest). Decision: **the team server keeps its own member list**, exactly as self-hosted
does. The console only proves identity. Billing (ADR 461) counts human members by asking the team
server, not by keeping its own list.

### 4.3 Console → team server trust ("most secure approach possible")

Every admin operation on a team server — create team, import, export, delete — carries a
console-signed token: **60-second expiry, audience = that one team server, single-use `jti`**,
verified against the console's published JWKS, which team servers cache. The router and edge hold
no secrets: a compromised edge can misroute, not sign.

The signing key lives in a **cloud KMS and is never exported**: the console asks the KMS to sign
each token, so a compromised console can sign while it is compromised but cannot steal the key,
and every signature is in the KMS audit log. Weighed against: a Fly secret (anyone with code
execution on the console copies the key); an offline root certifying a KMS key (higher assurance,
adds a ceremony — later if a customer needs it). Cost: one more cloud account, ~20 ms per admin
call, which admin calls can afford.

This closes the two provisioning holes measured on 2026-09-29: `POST /teams` is unauthenticated
(falsify: `packages/server/src/transport/http.ts:1809`), and off-host provisioning is gated on
"admin" only (`http.ts:1528`).

### 4.4 Team sign-in delegates to the console; the team mints its own tokens

A team server's existing OAuth (the flow the Claude app already completes; ADR 470 is still an
open PR at the time of writing) sends the
person to `app.musterd.io`, which authenticates them and returns a signed statement — *account A
is member `nick` (owner) on team `revive`*. The team server maps that to the member and issues
**its own** tokens, as today. Weighed against console tokens accepted everywhere: fewer parts,
but one token then works across all a person's teams, so one leak reaches every team.

`/live` gets a real sign-in button through the same flow. The paste-a-credential path
(`MemberSignIn.tsx`) is retired for hosted teams.

### 4.5 Claiming a seat over the network

`musterd claim <seat> --team revive` exchanges the account session at the team server for a
**seat credential** — the scoped, 90-day, revocable credential of ADR 439/440 — written to the
Workspace's protected binding. From there everything runs as today, remotely: presence is a
WebSocket to `<team>.musterd.dev`; the local MCP adapter stays a local process talking to the
server over the network.

Headless machines (CI, a VPS, a Mac mini in a closet) join **both** ways: an ADR 450 invite link
created by a human for a named seat (`musterd claim <seat> --invite <link>`, revocable by that
human), or a device code approved from a phone.

### 4.6 Roles, guests, and the remote MCP endpoint

The remote MCP endpoint today exposes 5 tools and no lane tools. Decision: it exposes the **full
member tool set**, lanes included, and **role decides** what a call may do. Weighed against
"watch + talk" (safer, but a guest promoted to member would still be crippled) and read-only.

Consequently the default role for a joiner is the load-bearing setting: **an invite carries its
role** (guest = talk only; member = full tools and lanes; owner), and a **public join link
defaults to guest**. Nobody gets lane tools without a human deciding they should.

### 4.7 Hooks against a remote server

- **Hard timeout** of ~1.5 s total per hook network call. `fetchWithRetry` has none today
  (falsify: `packages/cli/src/client.ts:302`, 2026-09-29).
- **Cached enforcement table.** Hooks cache the gate's enforcement rules locally, refresh about
  every 60 s, and keep serving the cached copy while refreshing. The gate stops paying a round
  trip per tool call (today it fetches uncached on every call).
- **Fail open, visibly.** When the server cannot be reached the call is allowed but recorded as
  `unenforced`; `team_status` and `/live` show it. Weighed against silent fail-open (today's
  behaviour, which turns every gate off during an outage without a trace) and blocking writes
  (strict, but an outage then stops every agent on the team).

### 4.8 Trace content capture: per-team opt-in, with the retention and privacy rules decided

Trace capture (ADR 445) today only runs against `127.0.0.1`. For hosted teams it is a **per-team
opt-in, shipped in v1**, because the research corpus (ADR 056) needs the dogfood team's data and
"off in v1" would have thrown away the very reason we dogfood. nick's condition: *think very
carefully about retention and privacy*. The rules:

| Rule | Decision |
| --- | --- |
| Who turns it on | A team **owner**. Each human is told at join and can **opt out** their own sessions and the agent seats they run; an agent seat follows the human responsible for it. |
| Who can read it | **Owners, plus the seat itself** for its own sessions. Other members see summaries and counts. musterd operators cannot read it without a **support grant the owner issues**, which is logged. |
| Retention | **30 days** by default; the owner may set 7–365. Backups purge deleted content within a further 7 days. Owners can export before expiry. |
| Secrets | **Redacted on the seat's machine before upload** (musterd credentials, cloud-provider keys, JWTs, private keys, high-entropy strings); counts of redactions are kept. Cloud never receives the plaintext. |
| Encryption per team | **Later phase**: a per-team key so that deleting the key erases the team's captured content. Not v1. |

## 5. Cloud mode — what changes in the server

`MUSTERD_MODE=cloud` is one flag with a defined set of effects; each is a test.

1. **No loopback trust, at all.** Behind Cloudflare and Fly every request arrives from a proxy,
   so `127.0.0.1` means nothing. Every privileged path takes an explicit credential: console
   token, owner session, or seat credential. Increment 1 includes an **audit** that lists every
   `127.0.0.1` / loopback check in the server and either removes it or gates it on self-hosted
   mode, with a test that fails if a new one appears. Weighed against trusting Fly's private
   range instead: quicker, and the audit would still be owed.
2. **Admin routes accept only console tokens** (§4.3). The self-hosted "admin key" path is not
   mounted.
3. **Host-name isolation.** A request to `revive.musterd.dev` reaches only `revive`'s routes;
   every credential is minted for exactly one team; RLS is the last line.
4. **Per-team rate limits and quotas**, at the edge and in the server.
5. **`/health` says ok or not**, nothing else.
6. **Schema version guard** (§6): refuse to start if the schema is newer than the binary knows.

## 6. Schema changes and deploys

Today migrations are forward-only and an older binary runs silently against a newer schema
(2026-09-29; falsify: start a pre-migration build against a migrated `musterd.db` and watch it
serve). With N servers deploying in a rolling fashion that is a correctness hole. Decision:
**expand/contract with a version guard**:

- Every schema change ships in two releases: *expand* (add columns/tables; both code versions
  work), then *contract* (remove the old) once no old server runs.
- Migrations run as a **separate step before the rollout**, rehearsed first on a **Neon branch**
  of production.
- Each server checks the schema version at boot and **refuses to start** if the schema is newer
  than it knows, so a rollback of the binary is always safe.

Weighed against migrate-on-boot (today; rollbacks cannot undo a schema change, and two servers
booting race) and stop-the-world (every change is downtime for every team).

## 7. Backups, outages, and health

- **Backups outside the vendor.** Neon PITR is the first line. Independently, a nightly
  encrypted `pg_dump` per team goes to Cloudflare R2 in a **separate account**, kept 30 days; once
  a month the newest dump is restored onto a fresh database, the suite runs against it, and the
  result is recorded. Survives losing the Neon account. A backup nobody has restored is a guess.
- **Database unreachable.** The app returns an **honest 503** with the reason; hooks hit their
  timeout and fail open visibly (§4.7); `/live` shows a banner; recovery is automatic. No serving
  of stale reads as if current, no local write queues — both create a reconciliation problem
  after the outage that is worse than the outage.
- **Observability.** OpenTelemetry traces (the server already emits `traceparent`s) and error
  tracking to a vendor; Neon's metrics; a public status page fed by a **synthetic probe** every
  minute that performs a real sign-in and inbox read. Alerts arrive as musterd `ask` acts to the
  infra seat, so incidents land where the team already works.

## 8. Acceptance for increment 1 — all four

1. **Load: ADR 451's baseline, on Cloud.** 75 humans + agents + live viewers per population,
   p95 under 1 s, through Cloudflare to the Fly app tier on Neon — the demo benchmark, so the
   numbers are comparable.
2. **Tenancy leak test.** For every table with a `team_id`, an automated test proves a credential
   for team A can neither read nor write team B, with RLS on, through the app's own query paths.
3. **Loopback audit test.** Fails if any privileged path in cloud mode is reachable without a
   credential, including every former `127.0.0.1` shortcut.
4. **Restore drill + rolling deploy.** Restore last night's dump onto a fresh database and pass
   the suite; deploy a schema change across two servers with no downtime and no refused request.

## 9. Increments

| # | Increment | Done when |
| --- | --- | --- |
| 0 | PGlite spike (two days) | pass/fail recorded; store-layer shape chosen |
| 1 | App tier + Postgres + cloud mode | §8, all four |
| 2 | Accounts + console (sign-in, KMS-signed console tokens, create team) | `revive` created from the console |
| 3 | Seat link (`musterd login`, `claim --team`, invite + device code, hooks §4.7) | every `revive` seat on Cloud; self-hosted daemon off |
| 4 | Import / export | `revive` imported from `musterd.db`; export restores on a laptop daemon |
| 5 | Ops (R2 dumps, restore drill, status page, alerts) | one month of drills recorded |
| 6 | Billing (ADR 461) | strangers can pay |
| 7 | Hosted agents (Cloud compute) | later; ADR 463 covers sponsor-hosted until then |

Dogfood = 0–5. Strangers = +6.

## 10. New runtime dependencies (each needs its ADR-noted why, hard rule 6)

A Postgres driver; PGlite (if the spike passes); the KMS SDK for the console; an OpenTelemetry
exporter. Litestream is **not** needed — the file-per-team shape that wanted it was dropped.

## 11. Open, deliberately

- Neon vs Fly MPG: revisit with performance data, then at billing.
- Per-team encryption of captured content (crypto-shred on delete): after v1.
- Offline root key certifying the KMS key: only if a customer's threat model asks.
- Hosted agents: increment 7, on the ADR 463 provisioning table.
