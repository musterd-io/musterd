# Cloud increment 1C — cloud mode: Implementation Plan

> **For agentic workers:** execute inline in your own lane (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `MUSTERD_MODE=cloud` is one flag with a defined, tested set of effects: the store is `pgDriver` from `MUSTERD_DATABASE_*_URL`, no request is trusted for arriving from loopback, team creation takes a console-signed token verified against a JWKS (a test issuer until increment 2), a team's host reaches only that team, `/health` says ok or one stable sentence, and boot refuses a schema it does not match. Done when the §8.3 loopback audit test and the increment-1 503 test pass, on PGlite in CI.

**Architecture:** `resolveConfig` gains `mode: 'self-hosted' | 'cloud'` and, in cloud, a `cloud` block (database URLs, JWKS URL, host suffix). `createServer` builds `pgDriver` for both stores from that block and never opens a SQLite file. One predicate, `trustsLocalPeer(ctx, req)`, replaces every direct `isLocalPeer` call in the transports and is constant `false` in cloud; a static inventory test fails if a new direct call appears. Console tokens are compact JWS (ES256) verified with `node:crypto` against a cached JWKS — no new dependency; single-use is a `console_token_jti` insert (ladder v84, a global table). Host isolation is a pure function from `(Host, path)` to allow/deny, applied in the HTTP handler and the WS claim. Machine-local loops (roster watcher, footprint `ps` sampler, seeds ingest from a checkout, federation sync) do not start in cloud.

**Tech Stack:** TypeScript strict, Node ≥ 22 (`crypto.createPublicKey({format:'jwk'})`, `crypto.verify` with `dsaEncoding:'ieee-p1363'`), `pg` (ADR 486), PGlite (tests), vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §5 (1, 2, 3, 5, 6), §4.3 (token shape, jti), §7 (503), §8.3 (loopback audit). Starts from 1B's end state (#1877, `c6861a23`) and consumes `pgDriver`, `migratePostgres`, `migrateTracePostgres`, `DriverError('unavailable')`, `SCHEMA_NEWER_SENTENCE` unchanged.

## Global Constraints

- `@musterd/protocol` does not change (hard rule 1). The token is server-internal until increment 2's console; no wire schema gains a field.
- No new runtime dependency (hard rule 6): JWS verification is `node:crypto`. If ES256 over `node:crypto` proves unworkable, stop and write an ADR for `jose` — do not add it silently.
- Self-hosted behaviour is byte-for-byte unchanged: every cloud effect is behind `config.mode === 'cloud'`, and the existing suite passes with the mode unset.
- Never log secrets (hard rule 5): database URLs, tokens, and JWKS private keys never reach a log line or an error message. Config errors name the variable, never its value.
- Migrations do not run on boot in cloud (§6): boot reads the version and refuses on mismatch; `migrateCloud()` is a separate step.
- Docs in the same commit (hard rule 3): `docs/architecture/03-server.md` (tree lines drift-checked), `07-conventions.md` env table if present, spec §5 dated note, ADR 479 Consequences.
- Git: branch `feat/cloud-1c-cloud-mode` from `origin/main`, squash PR, seat trailer, fast gates before push.

## Decisions taken in this plan (flag in review)

1. **"Admin routes accept only console tokens" (§5.2) means the operator/lifecycle routes**, not team governance. In 1C that is `POST /teams` (create). Import/export/delete arrive in increment 3 behind the same verifier. Team-level `is_admin` seats keep governing their own team with their own credential — that credential is already explicit, which is what §5.1 asks.
2. **Operator verbs that were loopback-only are not mounted in cloud** (`/store/prune`, `/store/compact`, `/node/enroll`, the sign-in handoff stage/redeem): they are about *this machine*, and Cloud has no machine a caller owns. They return 404 in cloud, not 403 — there is nothing there.
3. **`authProvision` in cloud is admin-only** (the local escape hatch is the loopback trust being removed).
4. **OAuth's TLS-except-loopback rule** becomes TLS-always in cloud (`x-forwarded-proto: https` from the edge, with `trustProxy` forced on).
5. **Global routes** (`/health`, `POST /teams`, discovery) answer on any host; **team routes** (`/teams/:slug/*`, `/mcp/:slug`, WS claim for `slug`) answer only on `<slug>.<MUSTERD_CLOUD_HOST_SUFFIX>`; a mismatch is 404 (not 403 — do not confirm the team exists).
6. **Rate limits and quotas (§5.4)** are not in increment 1's acceptance; they get their own lane (opened in Task 0, goal `cloud`), not a line in this doc.

## Review Focus

1. **A loopback shortcut that survives in cloud.** Every former `isLocalPeer`/`requireLocalPeer` site, requested from `127.0.0.1` with no credential on a cloud server, is refused. Pinned in Task 4 (static inventory) and Task 9 (behavioural sweep).
2. **A console token accepted twice, late, or for another audience** — or with `alg: none`/`HS256` against the ES256 key. Pinned in Task 5, including replay across **two server instances** on one database.
3. **A team host reaching another team** through a path the router does not prefix with `/teams/` (MCP, WS claim, OAuth callbacks). Pinned in Task 6.
4. **`/health` leaking** db path, connection counts, build SHA in cloud, or saying "ok" while the database is down. Pinned in Task 7.
5. **Boot against a wrong schema** (newer: refuse with `SCHEMA_NEWER_SENTENCE`; older: refuse with the migrate instruction) — never serve. Pinned in Task 3.

---

## File structure

**Created**
- `packages/server/src/cloud/mode.ts` — `CloudConfig` type, `resolveCloudConfig(env)` (refuses on a missing variable, naming it), `trustsLocalPeer(ctx, req)`.
- `packages/server/src/cloud/consoleToken.ts` — `verifyConsoleToken(token, { jwks, audience, now })`, `JwksCache`, `redeemJti(opDb, jti, exp)`.
- `packages/server/src/cloud/hostIsolation.ts` — `hostAllows(host, path, suffix)` / `hostTeam(host, suffix)`.
- `packages/server/src/cloud/health.ts` — `cloudHealth(opDb, traceOpDb)` → `{status, body}`.
- `packages/server/src/cloud/migrate.ts` — `migrateCloud(cfg)` (owner URLs → `migratePostgres` + `migrateTracePostgres`).
- `packages/server/src/cloud/testIssuer.ts` — **test-only** (excluded from `dist`, like PGlite): ES256 keypair, `jwks()`, `sign(claims)`, and a tiny HTTP JWKS server.
- `packages/server/src/cloud/*.test.ts`, `packages/server/src/cloud/loopbackAudit.test.ts`, `packages/server/src/cloud/cloudMode.test.ts`.
- `scripts/cloud/migrate.mjs` — runs `migrateCloud` from `~/.musterd/cloud/neon.env`.

**Modified**
- `config.ts` — `mode`, `cloud: CloudConfig | null`; in cloud `trustProxy = true`, `allowedHosts` derived from the suffix.
- `index.ts` — store selection by mode; boot schema check; loop gating; `RunningServer` unchanged in shape.
- `db/ladder.ts` + `db/pg/tenancy.ts` — v84 `console_token_jti` (portable; global table, allowlisted).
- `transport/http.ts` — `trustsLocalPeer` replaces `isLocalPeer`/`requireLocalPeer` bodies; `/health` cloud branch; `POST /teams` console-token gate; host isolation at the top of `handle`; `DriverError('unavailable')` → 503 in the error mapper.
- `transport/ws.ts`, `transport/oauth.ts`, `transport/mcpHttp.ts` — same predicate; host check on claim / `/mcp/:slug`.
- `packages/web/src/live/useLiveStream.ts` (+ a banner component) — 503 from `/health` shows the sentence as a banner; clears on recovery.
- Docs listed in Global Constraints.

---

### Task 0: Lane hygiene
- [ ] Open the rate-limits lane (§5.4, goal `cloud`, depends on this lane); note its id in the PR body.
- [ ] `pnpm adr:next` is **not** needed unless a Global Constraint forces a deviation.

### Task 1: Config — `mode` and the cloud block
- [ ] Test (`config.test.ts`): unset → `mode: 'self-hosted'`, `cloud: null`, everything as today. `MUSTERD_MODE=cloud` with all of `MUSTERD_DATABASE_APP_URL`, `MUSTERD_DATABASE_OPERATOR_URL`, `MUSTERD_TRACE_DATABASE_APP_URL`, `MUSTERD_TRACE_DATABASE_OPERATOR_URL`, `MUSTERD_CONSOLE_JWKS_URL`, `MUSTERD_CONSOLE_AUDIENCE`, `MUSTERD_CLOUD_HOST_SUFFIX` → populated; each missing one → throws naming the variable; the thrown message never contains a URL's value (assert with a sentinel password). Unknown mode value → throws.
- [ ] Test: in cloud `trustProxy === true` and `dbPath`/`traceDbPath` are `'postgres'`.
- [ ] Implement `resolveCloudConfig` in `cloud/mode.ts`; wire into `resolveConfig`. Owner URLs are **not** read by the server (only `migrateCloud`).
- [ ] Commit.

### Task 2: Store selection
- [ ] Test (`cloudMode.test.ts`, PGlite via the `PoolFactory` seam): `createServer({})` under cloud env builds a `pgDriver` for both stores and opens no file (assert no `musterd.db` in a temp `MUSTERD_DIR`).
- [ ] Implement in `index.ts`: `config.cloud ? pgDriver({appUrl, operatorUrl, pools?}) : openDriver(path)`; same for trace. `opts.db`/`opts.traceDb` injection still wins (tests).
- [ ] Commit.

### Task 3: Boot schema check, and `migrateCloud`
- [ ] Test: a PGlite store migrated to `LADDER` max → boots. Stamped to max+1 → `listen()` rejects with `SCHEMA_NEWER_SENTENCE`. Stamped below max → rejects with `schema older than this build — run the migrate step` (export it as `SCHEMA_OLDER_SENTENCE` beside the other in `db/guard.ts`). Same for the trace store.
- [ ] Implement the check in `listen()` before binding (cloud only; self-hosted keeps migrate-on-open).
- [ ] Implement `cloud/migrate.ts` + `scripts/cloud/migrate.mjs` (reads owner URLs from env file, never prints them).
- [ ] Commit.

### Task 4: One loopback predicate, and the static audit
- [ ] Test (`loopbackAudit.test.ts`, static half): read every non-test `.ts` under `packages/server/src`; any occurrence of `isLocalPeer(` or `remoteAddress` outside `config.ts`, `cloud/mode.ts`, and the oauth rate-limit key fails, printing file:line. (Run it first: it fails today with the 16 sites.)
- [ ] Implement `trustsLocalPeer(ctx, req) = ctx.config.mode !== 'cloud' && isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy)`; replace each site in `http.ts`, `oauth.ts`, `mcpHttp.ts`, `ws.ts`.
- [ ] Unmount the machine verbs in cloud (Decision 2): `requireLocalPeer` callers return 404 when `mode === 'cloud'`.
- [ ] Commit.

### Task 5: Console tokens — verifier, test issuer, jti, `POST /teams`
- [ ] `cloud/testIssuer.ts`: `generateKeyPairSync('ec', {namedCurve:'P-256'})`, `jwks()` exports the public JWK with a `kid`, `sign({aud, exp, jti, sub, ...})` → compact JWS ES256. Excluded from the build (add to the `noPgliteInDist`-style dist guard).
- [ ] Tests (`consoleToken.test.ts`): valid → claims. Refused, each with a distinct code: expired (`exp` past, 0 s leeway… allow 5 s skew), `exp` more than 60 s ahead, wrong `aud`, unknown `kid` (triggers one JWKS refetch, then refuses), bad signature, `alg` ≠ `ES256` (incl. `none`, `HS256` keyed with the public JWK bytes), malformed segments.
- [ ] Ladder v84: `console_token_jti(jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)`, global; add to `GLOBAL_TABLES`; drift test + tenancy inventory stay green. `redeemJti` = insert; unique violation → `replayed`. Expired rows pruned by the existing retention loop.
- [ ] Test: one token, **two `createServer` instances on one PGlite**, `POST /teams` to each → first 201, second 401 `replayed`.
- [ ] Gate `POST /teams` in cloud: `Authorization: Bearer <console token>` verified, jti redeemed, then the existing create. Self-hosted path untouched.
- [ ] `JwksCache`: fetch on first use, cache by `kid`, refetch at most once per 30 s on an unknown `kid`; a JWKS fetch failure is a 503 `console unreachable` (a third stable sentence — add to the set in `cloud/health.ts`).
- [ ] Commit.

### Task 6: Host-name isolation
- [ ] Tests (`hostIsolation.test.ts`, pure): `revive.musterd.dev` + `/teams/revive/messages` → allow; + `/teams/other/…` → deny; + `/mcp/other` → deny; + `/health` → allow; apex host + `/teams/revive/…` → deny; port suffix and case are normalised; `revive.musterd.dev.evil.com` → no team.
- [ ] Test (server): cloud server, credential for `revive`, `Host: other.musterd.dev`, `GET /teams/revive/members` → 404. WS upgrade on `other.` host claiming `revive` → refused.
- [ ] Implement at the top of `handle` (after the Host/Origin check) and in the WS claim; OAuth routes are team-prefixed already — confirm in the test list.
- [ ] Commit.

### Task 7: `/health` and the 503
- [ ] Tests: cloud, db up → `200 {ok:true}` and **no other key**. Pool factory that throws `ECONNREFUSED` → `503 {ok:false, reason:'database unreachable'}`; flip the factory back → next call 200 (automatic recovery, no restart). A team route during the outage → `503` with the same reason in the error body. Self-hosted `/health` body unchanged (snapshot).
- [ ] Implement `cloud/health.ts` (`SELECT 1` on both operator handles) and the `DriverError` `unavailable` → 503 mapping in `http.ts`'s error path and the MCP/WS error frames (WS: close with the reason; client reconnect is existing behaviour).
- [ ] Commit.

### Task 8: Loops in cloud
- [ ] Test: cloud `listen()` starts reaper, retention, trace prune, audit retention, expired-member sweep, provision sweep; does **not** start roster watcher, footprint sampler, seeds ingest, sync push/pull/trace push (assert by the stop handles being no-ops, or by a spy on the starters).
- [ ] Implement the gate in `index.ts`; one comment naming why each is machine-local.
- [ ] Commit.

### Task 9: The loopback audit test, behavioural half (§8.3)
- [ ] `loopbackAudit.test.ts`: a cloud server on PGlite with the test issuer; from `127.0.0.1`, no credential, hit every route in a table built from Task 4's site list plus every admin/governance route (`POST /teams`, `POST /teams/:slug/members`, governance reclaim/remove, audit read, the four machine verbs, OAuth authorize over plain http). Each must be 401/403/404 — never 2xx. The table is asserted complete against the static site list, so a new site without a row fails.
- [ ] Commit.

### Task 10: `/live` banner
- [ ] Test (web, vitest + testing-library): `/health` 503 with a reason → banner shows the sentence; next 200 → banner gone. No banner on self-hosted 200.
- [ ] Implement in `useLiveStream.ts` + a small `HealthBanner`; copy per `brand.md` (the sentence verbatim, no extra prose).
- [ ] Commit.

### Task 11: Docs and the PR
- [ ] `03-server.md` tree lines for `cloud/*`; a §Cloud mode section listing the env vars and the five effects; spec §5 dated note naming Decisions 1–6; ADR 479 Consequences note.
- [ ] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm format:check`; PR; `gh pr merge --squash --auto --delete-branch`; `lane_submit`.

## Self-review

- Spec coverage: §5.1 → Tasks 4, 9; §5.2 → Task 5; §5.3 → Task 6; §5.5 → Task 7; §5.6 → Task 3; §5.4 → its own lane (Decision 6); §7 503 + banner + recovery → Tasks 7, 10; §8.3 → Task 9. §8.1 (load) and §8.4 (rolling deploy) are 1D.
- No protocol change; no new dependency; self-hosted unchanged is asserted by the existing suite running with mode unset.

## After 1C

1D (Fly behind Cloudflare, §8.1 load test, §8.4 rolling expand/contract on a Neon branch, batching a request's bare reads into one transaction per `docs/perf/neon-pass.md`) consumes `mode`, `migrateCloud`, `cloudHealth` and the boot check as defined here.
