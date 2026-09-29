# 475 — musterd Cloud: hosted teams on a stateless app tier over Postgres

- Status: proposed — 2026-09-29 (nick's design decisions; the team argues with it before
  increment 1 starts)
- Date: 2026-09-29
- Lane: `01M3MT842AQ19VENMPZ8HYAVX2` (goal `cloud`)
- Spec: [`2026-09-29-musterd-cloud-design.md`](../superpowers/specs/2026-09-29-musterd-cloud-design.md)
  — the full design and the alternatives weighed; this ADR records the decisions.
- Builds on: [ADR 461](461-pricing-and-business-model.md) (hosted is the paid product),
  [ADR 451](451-public-demo-ordinary-members.md) (the single-Machine host this supersedes),
  [ADR 439](439-bootstrap-adoption-explicit.md) / [ADR 440](440-successor-expiry-server-set.md)
  (the seat credential), [ADR 450](450-join-link-seat.md) (invite links),
  [ADR 445](445-agent-traces-captured-local-first.md) (trace capture),
  [`deployment-topology.md`](../design/deployment-topology.md) (Topology C).

## Context

ADR 461 makes hosted musterd the paid product and `deployment-topology.md` names it Topology C,
"named, not scheduled". The demo (2026-09-27) ran on a bench Machine with its database in `/tmp`;
ADR 451's durable single-Machine host was never provisioned. nick's direction on 2026-09-29: no
demo-only stopgaps — build Cloud for actual users, with `revive` as the first tenant.

The store today is one SQLite file for every team (`musterd.db`, 293 MB, 50 tables), reached by
60 server files calling `better-sqlite3` directly; `POST /teams` is unauthenticated
(`http.ts:1809`); migrations are forward-only and an older binary runs silently on a newer
schema; hooks fetch enforcement uncached on every tool call and `fetchWithRetry` has no timeout
(`client.ts:302`). All measured 2026-09-29.

## Problem

Hosting a team means answering, at once: where a team's data lives and how many teams share a
process; how a person and a seat prove who they are to a server they do not run; what a hook does
when that server is far away or down; what happens to captured session content that is no
longer on the seat's own laptop; and how a fleet of servers takes a schema change. Each answer
constrains the others, so they were decided together.

## Decision

1. **Stateless app tier over managed Postgres.** The daemon runs in **cloud mode** on N ≥ 2 Fly
   Machines; any server serves any team. Team data lives in one Postgres database with `team_id`
   on every team-owned row and **row-level security** keyed on a per-request setting. Presence
   fans out between servers over `LISTEN/NOTIFY` on a direct connection. There is no router, no
   team→server registry, no per-team Volume, no Litestream. This supersedes ADR 451's
   one-Machine-plus-Volume shape.
2. **Neon** hosts the Postgres, chosen over Fly Managed Postgres for branching (migration
   rehearsal) and managed upgrades. The schema depends on **no vendor-specific feature**, so the
   choice is revisited with dogfood performance data and again at billing, by `pg_dump`.
3. **The self-hosted daemon stays in-process and never phones home.** A two-day **PGlite spike
   runs first**: pass → one SQL dialect and one store layer; fail → two backends behind one store
   interface.
4. **Identity is split.** The console (`app.musterd.io`) proves who a person is (GitHub, Google,
   magic link; `musterd login` is OAuth with browser-PKCE or device-code, auto-selected). Each
   **team server keeps its own member list**, mints its own tokens after the console has
   authenticated the person, and issues the ADR 439/440 seat credential on `musterd claim <seat>
   --team`. Headless machines join by ADR 450 invite link **or** device code.
5. **Console → team-server trust is a KMS-signed, 60-second, audience-bound, single-use token**
   verified against the console's JWKS; the signing key is created in a cloud KMS and never
   exported. Every create / import / export / delete carries one. `POST /teams` is no longer open.
6. **Cloud mode drops every loopback trust rule.** Increment 1 includes an audit of each
   `127.0.0.1` check with a test that fails if one reappears. Host-name isolation and per-team
   rate limits apply; `/health` reports only ok/not-ok.
7. **Hooks: hard ~1.5 s timeout, cached enforcement table, fail open *visibly*.** A call allowed
   because the server was unreachable is recorded `unenforced` and shown in `team_status` and
   `/live`.
8. **The remote MCP endpoint exposes the full member tool set; role decides.** An invite carries
   its role (guest / member / owner); a public join link defaults to guest.
9. **Trace content capture is a per-team opt-in in v1.** Owner enables; each human may opt out
   their own sessions and the agents they run. Readable by owners and by the seat for its own
   sessions; operators need an owner-issued, logged support grant. Retention 30 days by default,
   owner-set 7–365; backups purge within a further 7 days; secrets are redacted on the seat's
   machine before upload. Per-team encryption is a later phase.
10. **Schema changes are expand/contract**, run as a separate step rehearsed on a Neon branch,
    with a boot-time guard that refuses a schema newer than the binary.
11. **Backups outside the vendor:** nightly encrypted `pg_dump` per team to R2 in a separate
    account, 30 days, and a **monthly restore drill** whose result is recorded. A database outage
    is an honest 503 — no stale serving, no local write queue.
12. **Increment 1 is done only when all four pass:** ADR 451's load baseline (75 per population,
    p95 < 1 s) through Cloudflare on Cloud; the tenancy leak test; the loopback audit test; a
    restore drill plus a zero-downtime rolling schema deploy.

## Consequences

- The design spec's section 1 was first approved as SQLite-per-team behind a router and
  re-decided the same day; the spec keeps the comparison (§3.1) so the reasoning survives.
- Four new runtime dependencies will each need their ADR note (hard rule 6): a Postgres driver,
  PGlite (conditional on the spike), the KMS SDK, an OpenTelemetry exporter.
- `PRIVACY.md` stays true for self-hosted; a hosted team is a different privacy posture and its
  page on musterd.io must say what §9 says, in the same words.
- ADR 461's "hosted free for two humans" counts members by asking the team server (decision 4),
  not from a console-held list.
- ADR 463's sponsor-hosted agents remain the way an agent gets a process until increment 7.
- Increment ordering: 0 PGlite spike → 1 app tier + Postgres + cloud mode → 2 accounts + console →
  3 seat link → 4 import/export → 5 ops → 6 billing → 7 hosted agents. Dogfood = 0–5.

## Observability & Evaluation

- **Traces:** every hook call carries its `traceparent` to the team server and on to the
  OpenTelemetry exporter, so a slow gate is attributable to edge, app tier or Neon hop; the
  server records `unenforced` per seat per day, the synthetic probe's success rate per minute, the
  dated result of each restore drill, and per-team redaction counts for captured content.
- **Eval:** the four acceptance tests of decision 12, each an automated check in CI or a recorded
  drill: load p95 under 1 s at ADR 451's population; zero cross-team rows readable or writable
  under RLS through the app's own paths; zero privileged paths reachable without a credential in
  cloud mode; a restore from last night's dump passing the suite and a two-server schema deploy
  with no refused request.
- **Experiment:** the PGlite spike (increment 0, two days). Pass = the server suite is green on
  PGlite and hook-path latency is within the internet hop a Cloud seat already pays; then
  decision 3 is "one dialect". Fail on either count and the two-backend interface is taken. Two
  further falsifiers on the running system: if dogfood shows the Neon hop dominating p95,
  decision 2 is revisited early; if a month of `unenforced` counts shows outages switching gates
  off for more than a few minutes a week, decision 7's fail-open is too generous and the cached
  table's TTL or the timeout is retuned.
