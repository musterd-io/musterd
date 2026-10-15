# 615 — The console skeleton: its own Neon project, package and Fly app; health and an empty JWKS only

- Status: accepted
- Date: 2026-10-15
- Lane: `01M3Z42PED6K1XK5XZ1HF46D63` (goal `cloud`, Cloud increment 2)
- Deciders: nick; fifty, with stanley, ghost and big-body (security) in thread `01M50W1RJK`

## Context

Cloud spec §3 draws `app.musterd.io`, the account console, and §4 says what it owns: who a person is
(accounts and sign-in identities), never what they are on a team (§4.2). §4.3 makes it the trust
anchor: team servers verify console-signed admin tokens against its published JWKS. Nothing says how
the console is built, where its data lives, or how it is deployed, and every later increment 2 lane
(sign-in `01M3Z43QYB`, KMS tokens `01M3Z43V58`, identity statement `01M3Z44K46`, create-team
`01M3Z44MTV`) builds on that answer.

## Problem

Three choices shape every console lane after this one, and two of them create paid infrastructure:
where the accounts data lives, what the service is built on, and how it is deployed. A skeleton that
gets them wrong is undone by the lanes that follow.

## Decision

1. **Its own Neon project, `musterd-console`.** No role, RLS policy, backup path or retention story
   is shared with team data. The console's credentials never include a team database URL.
2. **Two roles.** The owner migrates, from its own migrate app only. The runtime role has DML on
   `accounts` and `identities`, **INSERT and nothing else on `audit`**, SELECT on the version row, no
   CREATE on the schema and no membership in the owner. Audit retention is a separate maintenance
   role. Boot refuses a schema that is not exactly its own; the server never migrates (spec §6).
3. **A new `packages/console` on `node:http` and the existing `pg` driver.** No new runtime
   dependency (ADR 486 already admits `pg`). It imports `@musterd/protocol` only — never
   `@musterd/server`. A framework, if any, is the sign-in lane's choice with its own dependency ADR.
4. **Its own Fly app, `musterd-console`**, one machine, blue-green, deployed through
   `scripts/cloud/deploy.mjs` (migrate, then roll, then probe) with `CLOUD_FLY_CONFIG` and
   `CLOUD_MIGRATE_CMD` selecting it; `app.musterd.io` is a proxied CNAME in the existing Cloudflare
   zone. The console does not share a blast radius or deploy cadence with the team servers that
   trust it, and ADR 608's team affinity does not apply to it.
5. **The skeleton serves two routes:** `GET /health` (`{ok, build}`, or one fixed sentence) and
   `GET /.well-known/jwks.json` (an empty key set, published so team servers code against the real
   URL). Every other route is refused. No sign-in, signing, identity or provisioning route, and no
   development issuer or test key to fall back to: an empty JWKS authenticates no one.
6. **The HTTP boundary holds from the first route:** a pinned host allow-list; trust from config
   only, never from a request Host, a token's `jku`/`x5u` or a caller URL; forwarded headers unread;
   GET/HEAD only with bounded headers and timeouts; safe request ids; security headers on every
   response; one error shape; `__Host-` cookies only, through one writer that cannot weaken them.
7. **Logs** carry request id, method, route label, status and duration — never a raw path, query,
   header or body. Secret-named fields are dropped and every string is scrubbed (ADR 445). A test
   pushes secrets down the success, refusal and error paths before any token exists.
8. **The schema:** `accounts.id` is opaque, never an email. `identities` is keyed `(provider,
   subject)` so one account holds several sign-ins, and identities are never auto-linked by email.
   No membership table, ever.
9. **Backups:** Neon point-in-time restore now. Cloud increment 3's backup lane (`01M3Z42KWH`)
   carries this database too — an independently encrypted nightly export to R2 in a separate
   Cloudflare account, the signing key never in a dump, a tested restore that does not revive
   consumed tokens or sessions (nick, 2026-10-15).

## Consequences

- Spec §3's diagram stands; this record is how the console box is built. Spec §3 carries a dated
  pointer here.
- Two more Fly apps (`musterd-console`, `musterd-console-migrate`), one more Neon project and one DNS
  record are provisioned by a human (`docs/guides/cloud-ops.md`). The console's machine is
  `shared-cpu-1x`, 512 MB: it serves a sign-in page and a key set, not team traffic.
- Before sign-in opens, the direct Fly origin needs protection equal to the Cloudflare rate limit
  on `/login` and the device-code endpoints: a rate limit at the edge is not a bypass boundary
  (big-body). That is the sign-in lane's to close.
- Append-only audit stops a compromised runtime rewriting history; it does not stop it adding
  forged rows. Tamper evidence is the KMS lane's audit log, out of band.
- CSRF and session design wait for the sign-in lane, which is safe only while the console has no
  cookie-authenticated state change — the skeleton has none.

## Observability & Evaluation

- **Traces:** `http_request` (rid, method, route, status, ms) and `http_error` (rid, route, error
  kind) on stdout; `listening` with the schema version at boot.
- **Eval:** `packages/console/src/*.test.ts` — config refusals that never echo a value; the schema
  ladder and guard; the runtime role's grants and denials on PGlite (audit read/update/delete/
  truncate refused, schema changes refused, no owner membership); the HTTP boundary (two routes,
  404/405, foreign host, headers, request ids) and log redaction on every path.
- **Experiment:** the lane's done-state on real infrastructure — `https://app.musterd.io/health`
  answers from the deployed console against its own database. Falsify: a console secret that holds a
  team database URL, or a runtime role that can change a row in `audit`.
