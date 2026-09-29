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
  [`deployment-topology.md`](../design/deployment-topology.md) (Topology C, reclassified here).
- Amends: [ADR 445](445-agent-traces-captured-local-first.md) §3 and build note (2) — captured
  content may travel from a seat to its hosted team's server of record, under per-author consent
  (decision 9). ADR 184 is untouched.
- Supersedes: ADR 451's one-Machine-plus-Volume host (decision 1); ADR 446's "the rest of the
  remote tool set converges after rehearsal" for members (decision 8).
- Reviewed 2026-09-29 by dolly, schmidt, big-body and wanderer on draft PR #1827; the required
  changes are folded in and listed under Consequences.

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
   magic link; `musterd login` is OAuth with browser-PKCE or device-code, auto-selected). The
   console returns an **identity-only** statement (account id, verified email) with decision 5's
   token properties; it holds no membership. Each **team server keeps its own member list** with
   the account binding on the member row, mints its own tokens after the console has
   authenticated the person, and issues the ADR 439/440 seat credential on `musterd claim <seat>
   --team`. A headless **agent** seat joins by a **seat authorization** — seat-scoped, expiring,
   single-use, revocable, minted by a human with standing (an ADR 450 invite admits only a new
   human member and is not this) — **or** by device code.
5. **Console → team-server trust is a KMS-signed, 60-second, audience-bound, single-use token**
   verified against the console's JWKS; the signing key is created in a cloud KMS and never
   exported. Every create / import / export / delete carries one. `POST /teams` is no longer
   open. The token proves identity; for import, export and delete the team server **also
   requires the account to be bound to an owner** of that team. Single-use is an **atomic
   database insert** of the `jti`, shared by every server. "Operators cannot read a team's data"
   is policy plus audit in v1, not a technical guarantee; per-team keys are the guarantee and are
   deferred.
6. **Cloud mode drops every loopback trust rule.** Increment 1 includes an audit of each
   `127.0.0.1` check with a test that fails if one reappears, run against a test issuer since
   the console arrives in increment 2. Host-name isolation and per-team rate limits apply;
   `/health` reports only ok/not-ok.
7. **Hooks: hard ~1.5 s timeout, cached enforcement table, and the outage rule is per class.**
   When the server is unreachable a call matching a `warn` class or no class is allowed and
   recorded `unenforced` — per call, in the acting seat's tool result, counted locally and flushed
   on recovery, shown in `team_status` and `/live`. A call matching a `block` class or a
   costly-action class (ADR 150) is **denied**: those gates exist so a human decides, and an
   outage may not turn them advisory.
8. **The remote MCP endpoint exposes the full member tool set; role decides.** An invite carries
   its role (guest / member / owner); a public join link defaults to guest. A guest is a Member
   with a **talk-only ceiling**: the acts and tools are enumerated in the spec (§4.6) and
   `tools/list` is filtered to them. This supersedes ADR 446's rehearsal-gated convergence of the
   tool set for members.
9. **Trace content capture on a hosted team: owner-enabled capability, per-author opt-in
   consent.** The owner turns the capability on; nothing is captured for a human until they opt
   in, recorded and revocable; an agent seat is captured only when its sponsoring human opts that
   named seat in. Content travels only from the seat to the team's server of record — **this
   amends ADR 445 §3 and its loopback-only build note**; ADR 184's emitted ≠ published line is
   kept and governs publishing unchanged. Readable by owners and by the seat for its own sessions;
   operators need an owner-issued, scoped, ≤ 7-day, logged support grant. Content lives in its
   own database; retention 30 days by default, owner-set 7–365; its dumps are kept 7 days so
   deletion reaches backups within 7 days. Secrets are redacted on the seat's machine and scrubbed
   again on the server; prose is stored in plaintext in v1; per-team encryption is a later phase.
   This widens ADR 445 from a dogfood substrate to a hosted-team capability, deliberately.
10. **Schema changes are expand/contract**, run as a separate step rehearsed on a Neon branch,
    with a boot-time guard that refuses a schema newer than the binary.
11. **Backups outside the vendor:** nightly encrypted `pg_dump` per team to R2 in a separate
    account (30 days coordination, 7 days captured content), and a **monthly restore drill**
    whose result is recorded. A database outage is an honest 503 with a stable reason — no stale
    serving, no local write queue; Cloud seats are thin clients, not ADR 325 replicas. The outage
    alert pages a phone **out of band** first; the musterd `ask` is the second channel.
12. **Increment 1 is done only when all four pass, each on its own:** 75 per population at
    p95 < 1 s **through Cloudflare** on Cloud (a harder bar than ADR 451's, not the same
    measurement); the tenancy leak test with an exhaustive table inventory, run as the app role
    through the pooler with alternating tenants; the loopback audit test; a zero-downtime rolling
    schema deploy with the old binary refusing the new schema. The restore drill is increment 3's
    gate; the seat bar is increment 4's.

## Consequences

- The design spec's section 1 was first approved as SQLite-per-team behind a router and
  re-decided the same day; the spec keeps the comparison (§3.1) so the reasoning survives.
- Four new runtime dependencies will each need their ADR note (hard rule 6): a Postgres driver,
  PGlite (conditional on the spike), the KMS SDK, an OpenTelemetry exporter.
- `PRIVACY.md`'s opening line ("no musterd account, no musterd cloud … in the product") becomes
  false when accounts ship. **The PR that lands increment 2 edits that sentence** and adds the
  hosted section (what is stored, decision 9 in the same words, cloud-mode operator telemetry to
  a vendor) — the ADR 461 precedent, not a separate page alone.
- ADR 461's "hosted free for two humans" counts members by asking the team server (decision 4),
  not from a console-held list. Talk-only members do not count toward that line (spec §4.2;
  flagged for nick; ADR 461 gets a dated note at increment 7).
- ADR 463's sponsor-hosted agents remain the way an agent gets a process until increment 8.
- Increment ordering (reordered on review so import, export and dumps precede the cutover):
  0 PGlite spike → 1 app tier + Postgres + cloud mode → 2 accounts + console → 3 import/export +
  backups + first drill → 4 seat link and cutover (import-then-switch) → 5 trace capture → 6 ops
  → 7 billing → 8 hosted agents. Dogfood = 0–6.
- Protocol touches, each its own ADR when its increment starts (hard rule 1): the `unenforced`
  hook outcome, `role` on an invite, the seat-authorization credential, `account_id` on a member
  and the identity statement, per-author consent fields.
- _2026-09-29 — increment 0 result:_ the PGlite spike ([`docs/perf/pglite-spike.md`](../perf/pglite-spike.md))
  was reshaped from "boot the daemon on PGlite" — impossible in two days with 62 synchronous
  better-sqlite3 store files against a Promise-only engine — to four measured questions, and the
  plan tightened this ADR's Experiment bar ("within the internet hop") to a **laptop** bar of
  p95 ≤ 10 ms per query and start ≤ 2 s, because the self-hosted daemon pays no hop today. Schema
  loads (106/106; the only hand-fixes are FTS5's); one SQL text serves both engines behind an async
  driver; every gate-path query is ≤ 1.2 ms p95 on file-backed PGlite with statistics, and
  reopening a data directory takes 93 ms (creating one takes 4.6 s, once). **By the plan's rule the
  spike says one dialect.** A first draft read "two backends" from a bench that timed `initdb` as
  boot and skipped `ANALYZE`; the whole-branch review caught it. The result page records the
  judgment on both sides (memory 310 MB vs 109 MB resident, out-of-process readers, PGlite
  maturity, against one store layer and no native module). **2026-09-29, nick chose two
  backends** over the rule: laptop memory and disk are the binding constraint (the dev machine is
  resource-constrained, and every self-hosted user would carry PGlite's ~200 MB extra resident),
  and the laptop should run exactly what self-hosted users run. better-sqlite3 stays the local
  driver; `pg` serves Cloud; both sit behind the async driver, and the store suite runs on both
  (PGlite as the `pg` test double, in-memory, test-time only) so the dialects cannot drift
  silently. Settled either way: the async store conversion is ~730 call sites in ~70 files, one
  pass. `@electric-sql/pglite` stays a devDependency.
- Same-PR notes landed with this ADR: `deployment-topology.md` Topology C reclassified relay →
  hosted authority; ADR 451 Consequences (shape superseded); ADR 445 Consequences (§3 amended);
  `brand.md` §5 secondary nouns Account / Console / Owner / Guest.
- Review record (2026-09-29, PR #1827): dolly required five changes (per-author consent or a
  stated amendment of ADR 445; identity-only statement; owner check on destructive tokens;
  per-class outage rule; increment reorder with a test issuer) — all taken. schmidt required five
  (split test 4; import before cutover; the 7-day purge vs 30-day dump contradiction; out-of-band
  alerting; an enumerated talk-only ceiling) — all taken. big-body required two (the ADR 450
  invite does not authorize an agent seat; the ADR 445 loopback boundary must be explicitly
  amended, not "built on") — both taken; big-body's three follow-up lanes (RLS test conditions,
  atomic `jti`, hosted trace redaction and support access) are folded into decisions 5, 9 and 12
  and can close against this ADR. Two review-taken choices are flagged for nick in the spec:
  fail-closed for block classes, and talk-only members outside the free-tier count.

## Observability & Evaluation

- **Traces:** every hook call carries its `traceparent` to the team server and on to the
  OpenTelemetry exporter, so a slow gate is attributable to edge, app tier or Neon hop; the
  server records every `unenforced` call (seat, class, time — the per-seat-per-day count is a
  view of it), the synthetic probe's success rate per minute, the dated result of each restore
  drill, per-team redaction counts for captured content, and every read under a support grant.
- **Eval:** the four acceptance tests of decision 12, each an automated check in CI: load p95
  under 1 s at 75 per population through Cloudflare; zero cross-team rows readable or writable
  under RLS through the app's own paths, over an exhaustive table inventory; zero privileged
  paths reachable without a credential in cloud mode; a two-server expand-phase deploy with no
  refused request and the old binary refusing the new schema. Later increments own the rest
  (spec §8): token replay across two servers, the restore drill, the seat bar, consent.
- **Experiment:** the PGlite spike (increment 0, two days). Pass = the server suite is green on
  PGlite and hook-path latency is within the internet hop a Cloud seat already pays; then
  decision 3 is "one dialect". Fail on either count and the two-backend interface is taken. Two
  further falsifiers on the running system: if dogfood shows the Neon hop dominating p95,
  decision 2 is revisited early; if a month of `unenforced` counts shows outages switching gates
  off for more than a few minutes a week, decision 7's fail-open is too generous and the cached
  table's TTL or the timeout is retuned.
