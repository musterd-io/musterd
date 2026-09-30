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
weighed rather than only what won. The same evening four seats reviewed draft PR #1827 — dolly
(principles and prior ADRs), schmidt (seat experience and operations), big-body (security),
wanderer (storage and architecture) — and the required changes are folded in below; each
paragraph that changed says so with *(review)*. ADR 475's Consequences list them.

**Words.** *Account* is a person's identity at the console (`app.musterd.io`). *Console* is the
account service. *Owner* is the human-facing word for a Member holding the `is_admin` capability;
the two are one thing. A Member on a hosted team may be *bound* to an Account (the team server
records the account id on the member row); the console never records membership. *Guest* is not a
new kind — it is a Member whose role ceiling is talk-only (§4.6). `brand.md` §5 carries these as
secondary nouns.

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
   not this. *(review)* Cloud seats are **thin clients** of that authority, not ADR 325 machine
   replicas: when the server is unreachable a seat's acts do not queue locally and sync later (§7).
   That is a different bet from ADR 325's offline semantics, taken deliberately: a queue creates a
   reconciliation problem after the outage, and a hosted team's outage is ours to end. Also
   *(review)*: `deployment-topology.md` named Topology C as a *relay* (a dumb pipe on the same
   wire protocol, §10). Cloud is not a relay; it is the hosted **authority**. The topology page
   gets a dated note reclassifying C, in this PR.
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

_Result (2026-09-29): the spike's rule read **one dialect** — the schema loads, one SQL text serves
both engines, every gate-path query is ≤ 1.2 ms p95 on PGlite and reopen is 93 ms. The judgment
(memory, out-of-process readers, maturity) is on the result page, and on it nick chose **two
backends** (2026-09-29, [ADR 479](../../decisions/479-two-store-backends.md), superseding ADR 475
decision 3's spike clause): better-sqlite3 local, `pg` in Cloud, one async driver interface, the
store suite run on both. [`docs/perf/pglite-spike.md`](../../perf/pglite-spike.md)._

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
server, not by keeping its own list. *(review)* The binding is a column on the team's member row
(`account_id`, set the first time an account signs in through an invite or a claim); export
carries it and import restores it, so nothing about membership has to be rebuilt from the console.
Talk-only members (§4.6) do **not** count toward ADR 461's two-human line — they hold no lane
tools and are how an audience joins a demo; owners and members do count. *(Confirmed by nick 2026-09-29; was flagged: ADR
461 says "human members"; this narrows it and ADR 461 gets a dated note when billing ships.)*

### 4.3 Console → team server trust ("most secure approach possible")

Every admin operation on a team server — create team, import, export, delete — carries a
console-signed token: **60-second expiry, audience = that one team server, single-use `jti`**,
verified against the console's published JWKS, which team servers cache. The router and edge hold
no secrets: a compromised edge can misroute, not sign.

*(review)* Three properties the first draft left implied:

- **The token proves the console authenticated a person; it does not by itself authorize the
  operation.** It carries the account id. For import, export and delete the team server *also*
  checks that the account is bound to an **owner** member of that team, from its own member list
  (§4.2). So the console — and therefore a musterd operator — cannot sign an export or a delete of a
  team whose owner they are not. Create is the one exception, because the team does not exist
  yet: the console provisions it and the requesting account becomes its first owner.
- **Single-use is enforced in the database, not in a process.** With N ≥ 2 stateless servers a
  process-local replay cache cannot hold the property. Redemption is one atomic insert into a
  `console_token_jti (jti primary key, exp)` table; a duplicate insert is a replay and is refused.
  Rows expire with the token. The test replays one token against two different servers (§8).
- **"Operators cannot read a team's data" is policy plus audit, not a technical guarantee** while
  a database superuser role exists at Neon and per-team encryption is a later phase (§4.8). What is
  true in v1: every operator access path is an audited support grant (§4.8) or a break-glass
  database session that is logged out of band; no server code path serves a team's rows without a
  credential for that team. The technical guarantee is what per-team keys buy, and §11 keeps it
  open.

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
person to `app.musterd.io`, which authenticates them and returns a signed **identity statement**
— *account A, verified email E* — and nothing about teams. *(review: the first draft had the
statement say "is member nick (owner) on team revive", which would have put membership in the
console, the thing §4.2 rejects.)* The team server looks up which member is bound to account A in
its own list, or offers to bind one through an invite, and issues **its own** tokens, as today.
Weighed against console tokens accepted everywhere: fewer parts, but one token then works across
all a person's teams, so one leak reaches every team.

The identity statement carries the **same properties as the admin token** (§4.3): 60-second
expiry, audience = the one team server that asked, single-use `jti` redeemed atomically. It is
the credential that asserts who is signing in, which is as sensitive as an export.

`/live` gets a real sign-in button through the same flow. The paste-a-credential path
(`MemberSignIn.tsx`) is retired for hosted teams. *(review)* What `/live` then holds is a
**browser session** the team server issues — a cookie, scoped to that team's origin, living for
days and revocable from the roster — not the 60-second statement, which is consumed once at
sign-in.

### 4.5 Claiming a seat over the network

`musterd claim <seat> --team revive` exchanges the account session at the team server for a
**seat credential** — the scoped, 90-day, revocable credential of ADR 439/440 — written to the
Workspace's protected binding. From there everything runs as today, remotely: presence is a
WebSocket to `<team>.musterd.dev`; the local MCP adapter stays a local process talking to the
server over the network.

`musterd login` says which path it took (`signed in via browser` / `signed in via device code`)
so a transcript shows what happened; device code always needs a human at a browser somewhere.

Headless machines (CI, a VPS, a Mac mini in a closet) join **both** ways: a **seat
authorization** created by a human for a named seat, or a device code approved from a phone.
*(review: the first draft called the first path "an ADR 450 invite link", and that is false as
written — an ADR 450 invite carries no identity and no seat; it grants only the creation of a new
**human** member (ADR 450 §1). An agent seat needs the scoped, audited authorization
`security.md` §Trust boundaries asks for.)* A seat authorization is a **seat-scoped, expiring,
single-use, revocable** claim credential that a human with standing mints for one named seat —
the shape ADR 463's sponsor-host claim already has, and the credential it exchanges for is the
ADR 439/440 successor. `musterd claim <seat> --team revive --authorization <token>` on the
headless machine redeems it. The minting human is recorded as the seat's sponsor. This needs its
own ADR at increment 4 (a new credential kind on the wire; hard rule 1).

### 4.6 Roles, guests, and the remote MCP endpoint

The remote MCP endpoint today exposes 5 tools and no lane tools. Decision: it exposes the **full
member tool set**, lanes included, and **role decides** what a call may do. Weighed against
"watch + talk" (safer, but a guest promoted to member would still be crippled) and read-only.

Consequently the default role for a joiner is the load-bearing setting: **an invite carries its
role** (guest = talk only; member = full tools and lanes; owner), and a **public join link
defaults to guest**. Nobody gets lane tools without a human deciding they should.

*(review)* "Talk only" is a ceiling a seat can implement only if it names the acts, so:

| Ceiling | May call | Refused |
| --- | --- | --- |
| **guest** (talk-only) | `team_join`, `team_inbox_check`, `team_status`, `team_members`, `team_send` with acts `message`, `status_update`, `request_help`, `ask`, and `accept` / `decline` / `wait` / `resolve` on a thread addressed to them | every `lane_*`, `team_goal_*`, `team_seed_*`, `team_memory_*`, `team_insight_save`, `team_report`, policy and admin routes; `handoff`, `steer`, `challenge`, `defer` |
| **member** | the full member tool set | admin routes |
| **owner** | everything a member may, plus the admin routes | — |

The MCP `tools/list` is **filtered to the ceiling**, so a phone is never offered a lane tool it
would be refused; a refused act is `forbidden` with the role named. In the product a guest is a
**Member** with a tight role — `/live` and the CLI say "member" — and "guest" is the role's name on
an invite, nowhere else in copy. ADR 446 left the rest of the remote tool set to converge after
rehearsal (its increment 3); this decision **supersedes that clause for members**: the set is the
full member set, gated by role, and rehearsal tunes rate limits rather than the vocabulary. The
`role` on an invite is a protocol change (ADR 450's invite schema) and needs its own ADR at
increment 4.

### 4.7 Hooks against a remote server

- **Hard timeout** of ~1.5 s total per hook network call. `fetchWithRetry` has none today
  (falsify: `packages/cli/src/client.ts:302`, 2026-09-29).
- **Cached enforcement table.** Hooks cache the gate's enforcement rules locally, refresh about
  every 60 s, and keep serving the cached copy while refreshing. The gate stops paying a round
  trip per tool call (today it fetches uncached on every call).
- **Fail open, visibly — for warn classes. Fail closed for block classes.** *(review: the first
  draft failed everything open.)* ADR 150 makes enforcement per class, and a class declared with
  posture `block` (or the human-approve ask of Gate B) exists precisely so a human decides; an
  outage that turns it advisory has switched off the one gate the team asked for. So:
  - a call matching a **warn** class, or no class, when the server cannot be reached is allowed
    and recorded `unenforced`;
  - a call matching a **block** class or a **costly-action** class is **denied** with the reason
    "gate unreachable" — the seat waits or asks a human out of band. Most teams declare few or no
    block classes (ADR 227's warn-only default), so an outage stops the few actions that were
    already gated, not every agent.
  - `unenforced` is **per call**: it appears in the acting seat's own tool result (the hook's
    repair string) at the moment it happens, not only on `/live`. The seat keeps a **local
    counter** while the server is down, since the record cannot be posted, and flushes it as one
    audit act on recovery; `team_status` and `/live` then show the count and window. This
    outcome is a new hook-outcome value on the wire and needs its own ADR (hard rule 1).
  - The **60 s cached table is a stale-enforcement window**, distinct from an outage: a class
    changed on the policy reaches every seat within a minute, and a call in that minute is
    enforced under the previous table. Named here so nobody reads it as a bug later.

  Weighed against silent fail-open (today's behaviour, which turns every gate off during an
  outage without a trace) and blocking every write (strict, but an outage then stops every agent
  on the team). *(Confirmed by nick 2026-09-29; was flagged: this splits the decision he made — "fail open, visibly" — by
  class. It is the smallest change that keeps ADR 150 true.)*

### 4.8 Trace content capture: per-team capability, per-author consent, retention and privacy decided

Trace capture (ADR 445) today only runs against `127.0.0.1`. For hosted teams it is **shipped in
v1**, because the research corpus (ADR 056) needs the dogfood team's data and "off in v1" would
have thrown away the very reason we dogfood. nick's condition: *think very carefully about
retention and privacy*.

*(review — required by dolly and big-body, and the largest change from the first draft.)* The
first draft had the owner switch capture on and each human opt **out**, with an agent seat
following its human. That inverts ADR 445 §3, which says content never crosses the wire
off-machine "without ADR 184 §3 consent recorded per author", and ADR 184 §3, which says absence
of consent is never consent. So:

- **This design amends ADR 445 §3 and its build note (2) ("content goes only to a loopback
  daemon")**, with a dated note in ADR 445's Consequences: on a hosted team the seat's own
  authority is not on its machine, and content may travel from the seat to **the team's server of
  record** — never anywhere else — under the consent rule below. ADR 184 is **not** amended:
  storing a team's own captures on its own authority is emission, and 184 §1's line "emitted ≠
  published" is exactly the line being kept. Publishing any of it stays 184's question.
- **Consent is per author, opt-in, recorded, revocable.** The owner enables the *capability* for
  the team (`trace.content: on`, as ADR 445 has it). That alone captures nothing. Each **human**
  opts in for their own sessions, and the act is recorded as an audit fact with its time. An
  **agent seat** captures only when the human who sponsors it (ADR 463's sponsor, or the member
  who provisioned it) opts that named seat in, explicitly, seat by seat — a proxy consent, and
  the honest reason it is acceptable is that the seat's content is stored on the team's own
  authority for the team's own reading, the same standing ADR 445 already gives admins over a
  dogfood seat's trace. Withdrawal stops capture from the next hook and deletes what was captured
  under that consent. The consent fields on the wire are a protocol change needing their own ADR.

The rules:

| Rule | Decision |
| --- | --- |
| Who enables | A team **owner** enables the capability. Each human is told at join what capture is, and nothing of theirs is captured until they opt in. |
| Who can read it | **Owners, plus the seat itself** for its own sessions. Other members see summaries and counts. musterd operators cannot read it without a **support grant**: owner-issued, scoped to one seat or one session range, **expiring within 7 days**, every read under it logged as an audit act the team can see. (§4.3: policy plus audit, not a technical guarantee, until per-team keys.) |
| Where it lives | Its **own database** on the same Neon project (the Cloud shape of ADR 445's separate `trace.db`), so captured content never adds to the coordination store's size, locks or backup weight. RLS applies there as everywhere. |
| Retention | **30 days** by default; the owner may set 7–365. Owners can export before expiry. |
| Backups | The captured-content database is dumped on its own schedule and its dumps are kept **7 days**, not 30 — that is how "deleted content is gone from backups within 7 days" is true (the coordination dump keeps 30, §7; a 30-day dump holding purged content would have made the promise false). |
| Secrets | **Redacted on the seat's machine before upload**, as today (musterd credentials, cloud-provider keys, JWTs, private keys, high-entropy strings) with ADR 445's second scrub pass on the server before persistence; counts of redactions are kept. What this does **not** do: prose is not PII-scrubbed, and it arrives over TLS and is stored **in plaintext** in v1. The first draft's "Cloud never receives the plaintext" was an overclaim and is withdrawn. |
| Encryption per team | **Later phase**: a per-team key so that deleting the key erases the team's captured content, and so an operator with database access reads ciphertext. Not v1. |

This is a **deliberate widening of ADR 445's scope**, from "what the dogfood daemons do to their
own seats" to a capability any hosted team may turn on. The retention and access rules above are
what make that widening defensible; ADR 475's Consequences name it.

## 5. Cloud mode — what changes in the server

`MUSTERD_MODE=cloud` is one flag with a defined set of effects; each is a test.

1. **No loopback trust, at all.** Behind Cloudflare and Fly every request arrives from a proxy,
   so `127.0.0.1` means nothing. Every privileged path takes an explicit credential: console
   token, owner session, or seat credential. Increment 1 includes an **audit** that lists every
   `127.0.0.1` / loopback check in the server and either removes it or gates it on self-hosted
   mode, with a test that fails if a new one appears. Weighed against trusting Fly's private
   range instead: quicker, and the audit would still be owed.
2. **Admin routes accept only console tokens** (§4.3). The self-hosted "admin key" path is not
   mounted. *(review)* Increment 1 lands before the console exists (increment 2), so increment 1
   ships a **test issuer**: a JWKS and signer in the test suite with the same token shape, and a
   `MUSTERD_CONSOLE_JWKS_URL` the server reads. The loopback audit test (§8) runs against that
   issuer; increment 2 only swaps the URL to the real console. Sequencing is not ambiguous.
3. **Host-name isolation.** A request to `revive.musterd.dev` reaches only `revive`'s routes;
   every credential is minted for exactly one team; RLS is the last line.
4. **Per-team rate limits and quotas**, at the edge and in the server.
5. **`/health` says ok or not**, nothing else. A 503's reason (§7) is one of a small set of
   **stable sentences** ("database unreachable", "schema newer than this build"), so a probe or a
   banner can match it; it is not free text.
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
  encrypted `pg_dump` per team goes to Cloudflare R2 in a **separate account**, kept 30 days for
  the coordination database and **7 days for the captured-content database** (§4.8); once a
  month the newest dump is restored onto a fresh database, the suite runs against it, and the
  result is recorded. The first drill is increment 3's; the monthly cadence is increment 6's.
  Survives losing the Neon account. A backup nobody has restored is a guess.
- **Database unreachable.** The app returns an **honest 503** with the reason; hooks hit their
  timeout and apply §4.7's per-class rule — `warn` and unclassified calls proceed and are recorded
  `unenforced`, `block` and costly-action classes are **denied** until the server is back; `/live`
  shows a banner; recovery is automatic. No serving
  of stale reads as if current, no local write queues — both create a reconciliation problem
  after the outage that is worse than the outage.
- **Observability.** OpenTelemetry traces (the server already emits `traceparent`s) and error
  tracking to a vendor; Neon's metrics; a public status page fed by a **synthetic probe** every
  minute that performs a real sign-in and inbox read. *(review)* The probe signs in as a
  **dedicated, least-privilege member** of a probe team (talk-only role, its own credential), not
  as an owner every minute. **Alerts go out of band first**: the probe runs outside Cloud and
  pages a phone directly (SMS through the Twilio rail the repo already carries, plus email) when
  the team server is down — a musterd `ask` to the infra seat cannot be the alert for the outage
  of the server that would carry it. The `ask` is the **second** channel, sent when the server is
  reachable, so incidents also land where the team works. Cloud-mode operator telemetry (OTel to a
  vendor, error tracking) is disclosed in the hosted privacy text (§10).

## 8. Acceptance for increment 1 — all four, each its own pass/fail

*(review: the first draft's fourth test bundled a restore drill with the rolling deploy, and the
drill needs the R2 pipeline that a later increment builds. The drill moved to increment 3; the
four below are all increment 1's, and a partial pass is a fail.)*

1. **Load: ADR 451's population, through Cloudflare, on Cloud.** 75 humans + agents + live
   viewers per population, p95 under 1 s, through the Cloudflare edge to the Fly app tier on
   Neon. ADR 451 measured 75 on a bare Fly Machine *without* Cloudflare and planned 50 *through*
   the tunnel; this is 75 through the edge — a **harder bar**, and not the same measurement, so
   the two numbers are compared with that said.
2. **Tenancy leak test.** *(review, big-body's lane 01M3Q9YHG8YHJ654635JHP4255 folded in.)* An
   **exhaustive inventory**: every table in the schema is either team-owned (has `team_id`, has
   an RLS policy) or named in a short allowlist of global tables; the test fails on a table in
   neither. For every team-owned table it proves a credential for team A can neither read nor
   write team B, with RLS on, run as the **production app role** (never the owner role),
   through the app's own query paths, with the team context set **per transaction** (`SET
   LOCAL`), and with tenants **alternating on reused pooled connections** so a leaked setting on
   a returned connection would show.
3. **Loopback audit test.** Fails if any privileged path in cloud mode is reachable without a
   credential, including every former `127.0.0.1` shortcut. Runs against the increment-1 test
   issuer (§5.2).
4. **Rolling schema deploy.** Deploy an expand-phase schema change across two servers with no
   downtime and no refused request; then confirm a server built before the change **refuses to
   boot** against the migrated schema (§6's guard).

*(review)* Further tests, each owned by the increment that builds the behaviour:

- **Increment 1:** database down → honest 503 with a stable reason, `/live` banner, automatic
  recovery when it returns; RLS through the pooler as the non-owner app role (above).
- **Increment 2:** console token expiry, audience mismatch, `jti` replay against **two different
  servers**, and `alg` confusion, each refused; the identity statement (§4.4) under the same four.
- **Increment 3:** restore last night's coordination dump onto a fresh database and pass the
  suite; export from Cloud restores on a laptop daemon with the account bindings intact.
- **Increment 4 — the seat bar:** PKCE and device-code each land a claim; `/live` signs in with
  no pasted credential; a talk-only member can send `message` and is refused `lane_claim`, and
  `tools/list` never offered it; a seat credential minted for team A is refused at team B's host;
  a block-class call during an outage is denied and a warn-class call is allowed and recorded
  `unenforced`, per call, in the tool result; a self-hosted daemon makes **no** connection to
  `musterd.io` (the no-phone-home mirror of the loopback audit).
- **Increment 5:** a human who never opted in has zero content rows; withdrawal deletes; a
  support grant expires and its reads are in the audit log.

## 9. Increments

*(review: reordered. The first draft cut `revive` over to Cloud before import existed — the team
would have arrived at an empty roster — and took nightly dumps only after `revive`'s data was
already there. Import, export and the dump pipeline now land **before** any seat moves, and the
cutover is import-then-switch. §4.6 and §4.8 had no increment; they have one.)*

| # | Increment | Done when |
| --- | --- | --- |
| 0 | PGlite spike (two days) | pass/fail recorded; store-layer shape chosen |
| 1 | App tier + Postgres + cloud mode, with the test issuer (§5.2) | §8's four, plus the 503 test |
| 2 | Accounts + console (sign-in, KMS-signed console tokens and identity statements, create team) | a disposable team created from the console; the increment-2 token tests |
| 3 | Import / export + backups (nightly R2 dumps of both databases, **one** restore drill) | a copy of `revive` imported from `musterd.db` into a staging team; exported back and restored on a laptop daemon; one drill recorded |
| 4 | Seat link: `musterd login`, `claim --team`, seat authorization + device code, invite roles and the talk-only ceiling (§4.6), hooks (§4.7), `/live` sign-in | **cutover**: `revive` imported fresh, every seat on Cloud, the seat bar (§8) green, the laptop daemon off — in that order |
| 5 | Trace capture on Cloud (§4.8: consent, retention job, support grants, 7-day content dumps) | `revive`'s consenting humans and their seats capturing; the increment-5 tests |
| 6 | Ops (status page, out-of-band alerts, monthly drill cadence) | one month of drills recorded |
| 7 | Billing (ADR 461) | strangers can pay |
| 8 | Hosted agents (Cloud compute) | later; ADR 463 covers sponsor-hosted until then |

Dogfood = 0–6. Strangers = +7. Between 4 and 5 the dogfood team runs with structural trace only
(ADR 445's default), which is what self-hosted does today.

Protocol and SPEC touches, each needing its own ADR when its increment starts (hard rule 1):
the `unenforced` hook outcome (4); `role` on an invite (4); the seat-authorization credential
(4); `account_id` on a member and the identity statement (2, 4); per-author consent fields (5).

## 10. New runtime dependencies (each needs its ADR-noted why, hard rule 6)

A Postgres driver; PGlite (if the spike passes); the KMS SDK for the console; an OpenTelemetry
exporter. Litestream is **not** needed — the file-per-team shape that wanted it was dropped.

**Docs that change in the same commit as the behaviour** (hard rule 3; *review*):

- `PRIVACY.md`'s opening — "there is no musterd account, no musterd cloud … in the product" —
  becomes false the day increment 2 ships. The PR that lands increment 2 **edits that sentence**
  (self-hosted still does not phone home; a hosted team is a different posture, and the file says
  which is which) and adds the hosted section: what the team server stores, the trace-capture
  rules of §4.8 in the same words, and that cloud-mode operator telemetry (OTel, error tracking)
  goes to a vendor. ADR 461 set this precedent ("this file changes in the same commit"); a
  separate page on musterd.io alone would have left the top line lying.
- `deployment-topology.md`: Topology C reclassified from relay to hosted authority — **this PR**.
- ADR 451: dated Consequences note that its one-Machine shape is superseded — **this PR**.
- ADR 445: dated Consequences note recording the §3 amendment of §4.8 — **this PR**.
- `brand.md` §5: Account, Console, Owner, Guest as secondary nouns — **this PR**.
- ADR 446: dated note that the remote tool set is the full member set gated by role — increment 4.
- ADR 461: dated note that talk-only members do not count toward the two-human line — increment 7.

## 11. Open, deliberately

- Neon vs Fly MPG: revisit with performance data, then at billing.
- Per-team encryption of captured content (crypto-shred on delete): after v1.
- Offline root key certifying the KMS key: only if a customer's threat model asks.
- Hosted agents: increment 8, on the ADR 463 provisioning table.
- ADR 461's org-tier policy pack vs base Cloud: the 7–365 retention range and per-author consent
  are **base Cloud** (every hosted team gets them); the org tier adds the ability to *mandate and
  prove* them across teams. Settled when billing is designed.
- Two decisions taken on review, confirmed by nick 2026-09-29, still reversible: fail-closed for
  block classes (§4.7) and talk-only members not counting toward the free tier (§4.2).

## 12. Increment 1B — real Postgres behind the Driver (design, 2026-09-30)

_Agreed in conversation on 2026-09-30 (fifty, nick), after increment 1A landed the async `Driver`
([ADR 479](../../decisions/479-two-store-backends.md), PR #1871). 1B is the Postgres half of that
decision; cloud mode itself (§5: loopback audit, test issuer, 503 wiring) is 1C, deploy and the load
test are 1D._

### 12.1 Tenant context reaches RLS through the driver, and the default is empty

Every Postgres statement runs inside a transaction that carries `SET LOCAL app.team_id = <team>`;
the row-level policy on every team-owned table is `team_id = current_setting('app.team_id', true)`.
Three shapes were weighed:

- **Driver-scoped (chosen).** `Driver` gains `forTeam(teamId): Driver` and `asOperator(): Driver`.
  A team-scoped handle stamps the tenant on every transaction it opens (a bare `get/all/run` outside
  a `tx` becomes `BEGIN; SET LOCAL; <stmt>; COMMIT` on one pooled client; `tx` sets it once for the
  body; nested = SAVEPOINT). `SET LOCAL` dies with the transaction, so a returned pooled connection
  carries nothing to the next request — the failure §8.2 tests for cannot happen by construction.
  The seam is the one place that already knows the team: the auth helpers (`authTouch`,
  `authClaimedAgent`, `authAgentKeyOnly`, the WS claim) hand the rest of the request
  `ctx.db.forTeam(team.id)`. Store code is untouched. On SQLite both methods return the handle itself.
- Request-scoped transaction (one `tx` per HTTP/WS request): holds a connection and locks for the
  whole request; a wake poll or a webhook would pin a client; on SQLite the 1A queue would serialise
  every request. Rejected.
- No RLS on the app path (`WHERE team_id` only): one missed predicate is a breach; §8.2 says the app
  role runs with RLS on. Rejected.

Two hardenings make the chosen shape the secure one:

1. **Fail closed.** The connection-level handle has no tenant. With no setting,
   `current_setting('app.team_id', true)` is NULL and the policy matches no row, so a code path that
   reaches Postgres without `forTeam` reads and writes nothing — loudly, in its own tests — rather
   than everything. Genuinely cross-team work (the presence reaper, retention, the census, `/health`,
   team creation, the sync loops) takes `asOperator()`, a handle on the `musterd_operator` role
   (`BYPASSRLS`). `asOperator(` is therefore the greppable audit list of every cross-tenant read.
2. **The app role owns nothing.** The server connects as `musterd_app`: DML only, no `BYPASSRLS`,
   not the table owner, and every team-owned table carries `FORCE ROW LEVEL SECURITY` regardless.
   Migrations run as `musterd_owner` in a separate step (§6). An injection-shaped bug in the app
   cannot cross a tenant.

Cost: a bare statement outside a `tx` is three round-trips instead of one — ~1 ms inside the
datacenter, noise beside the internet hop §3.1 already accepts; the hot paths (gate, inbox, wake
poll) already batch inside one `tx`. The laptop pays nothing.

### 12.2 Schema: a frozen Postgres baseline, then one portable ladder

Today `db/pgSchema.ts` derives Postgres DDL from the current SQLite schema on every run — right for
a test double, wrong for a production schema (no history, so nothing to migrate forward). Decision:

- `db/pg/0080-baseline.sql` snapshots the translated DDL once, hand-checked, with the roles
  (`musterd_owner`, `musterd_app`, `musterd_operator`), `ENABLE` + `FORCE ROW LEVEL SECURITY` and the
  `tenant` policy on every team-owned table. Team-owned tables that carry no `team_id` today
  (`presence`, `wake_leases`, `seat_memory`, …) get either a policy through their owning join or a
  `team_id` column in the same baseline; the plan lists each. A short **allowlist of global tables**
  (`schema_meta`, `nodes`, `local_node`, the sync cursors, …) is declared in code.
- From v81 on there is **one** `Migration` shape, `up: (db: Driver) => Promise<void>` in SQL both
  engines accept, with an explicit `{ sqlite?, postgres? }` branch only when unavoidable. SQLite
  keeps its history 1–80; Postgres starts at the baseline. `runMigrations` becomes async and shared;
  `pgSchema.ts` is deleted and PGlite loads the real ladder.
- A translation-aware diff (the same rules that produced the baseline) asserts SQLite@80 and the
  Postgres baseline agree on tables, columns, indexes and constraints, so the two schemas cannot
  drift silently; a fixture v81 applies on both.
- §6's guard lands here: on either engine, boot refuses when `schema_meta.schema_version` is newer
  than the ladder the binary carries, with a stable sentence ("schema newer than this build").

Weighed and rejected: two independent ladders (every change written twice, the diff test the only
tie); generating Postgres from SQLite forever (no expand/contract, no guard, SQLite's 80 rebuilds
become Postgres's history by accident).

### 12.3 Tests

- **Tenancy leak (§8.2), on PGlite, in CI.** (i) Inventory: every table in `pg_tables` is either in
  the global allowlist or has a tenant policy with RLS enabled and forced — a table in neither fails,
  so a new table cannot ship unclassified. (ii) Cross-tenant through the app's own paths: seed teams A
  and B via the store; as `musterd_app` scoped to A, every team-owned table's store reads return only
  A's rows and writes naming B's ids change 0 rows, B intact. (iii) Alternating tenants on reused
  connections: a pool of size 1, A/B/A/B across 200 statements and transactions including a body that
  throws mid-way. (iv) Fail-closed: the bare handle reads 0 rows and writes 0 rows on every team-owned
  table; `asOperator()` sees both teams.
- **Ladder:** both ladders load from empty; the baseline diff; the v81 fixture; the guard on both
  engines.
- **The 94 store test files 1A left on the SQLite hybrid handle** move to `withDrivers`, their raw
  `prepare`/`pragma` reads replaced by driver calls, in clusters with the suite green after each.
  End state: `MUSTERD_TEST_DRIVER=both` covers every store test and the hybrid `openTestDb` is gone.
- **Real Postgres, by hand, before a Cloud release** (ADR 479 decision 3): `scripts/cloud/neon-pass.mjs`
  reads `DATABASE_URL` from `~/.musterd/cloud/neon.env` (chmod 600, outside the repo; nick creates the
  Neon project with `neonctl` and writes the URL there — it never appears in a transcript), runs the
  ladder as owner, then the tenancy test and the store suite through the `pg` driver, and writes a
  dated `docs/perf/neon-pass.md`. Not CI.

### 12.4 Errors and dependencies

An unreachable database or an exhausted pool (after a bounded wait) surfaces as
`DriverError('unavailable')` with the stable sentence "database unreachable", for 1C's 503 to match. A
failed `SET LOCAL` fails its transaction; it is never retried on another client. Postgres errors carry
the translated statement, as PGlite's already do.

New runtime dependency: `pg` (+ `@types/pg` dev), with its own ADR (hard rule 6) weighing `postgres`
(porsager: nicer API, its own protocol quirks behind poolers) and `@neondatabase/serverless`
(HTTP/WebSocket, ties the app to one vendor). Neon's pooled endpoint speaks plain Postgres, so `pg`
keeps the app vendor-neutral.

### 12.5 Done when

The store suite and the tenancy leak test are green on both drivers in CI with no SQLite-only test
file left; the §6 guard refuses a future schema on both engines; the Neon pass has one dated result
page; `pgSchema.ts` and the hybrid test handle are deleted.

