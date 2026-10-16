# 10 — Console (`@musterd/console`)

> **Living document.** Direction, not gospel: if it disagrees with the code, fix the smaller of the two
> in the same commit; a real disagreement is an ADR. The decisions behind this service are the
> [Cloud design](../superpowers/specs/2026-09-29-musterd-cloud-design.md) §3 and §4 and
> [ADR 615](../decisions/615-console-skeleton.md) (how the console is built, hosted and bounded).

## What the console is

`@musterd/console` is `app.musterd.io`: **who a person is** on musterd Cloud — an account and the
sign-in identities that prove it (GitHub, Google, an email magic link). It never holds what a person
is on a team: membership, roles, seats and credentials stay on each team server (spec §4.2), which
binds a member row to an `account_id` and nothing more.

It is the **trust anchor** team servers verify against: the console signs, through a cloud KMS, the
short-lived tokens a team server accepts for admin operations, and publishes the keys at
`/.well-known/jwks.json` (spec §4.3). That is why it runs in its own Fly app on its own Neon project,
never beside team data.

## What the skeleton serves (increment 2, lane `01M3Z42PED`)

Two routes, and everything else is refused:

| Route | Answer |
| --- | --- |
| `GET /health` | `200 {ok: true, build}`, or `503 {ok: false, reason: "database unreachable"}` — never a URL or a driver error |
| `GET /.well-known/jwks.json` | `200 {keys: []}`, `cache-control: public, max-age=300`. Empty until the KMS lane (`01M3Z43V58`); an empty set verifies nothing |
| `POST /auth/{github,google}/start` | ADR 620: exact Origin; 30 a minute per client (`clientip.ts`: `cf-connecting-ip` only when the hop Fly saw is in Cloudflare's published ranges, else the sender's own address — so a direct-to-origin sender can neither invent addresses nor name a victim's; there is no global sign-in bucket to exhaust); a fresh single-use transaction (state, PKCE S256, Google's nonce) keyed by a `__Host-tx` cookie, 10 minutes; `303` to the pinned provider. A provider with no client configured answers 404 |
| `GET /auth/{github,google}/callback` | consumes the transaction atomically (cookie, provider, state, TTL), exchanges the code (Google's ID token verified: signature, issuer, audience, expiry, nonce; GitHub's numeric id from the pinned `/user`), finds or makes the account by `(provider, subject)` only, issues a session, `303` to an allowlisted return path. Any failure is a fixed error, never a redirect |
| `GET /me` | temporary JSON view of the signed-in account and its methods, until the signed-in page lands |
| `POST /logout` | ADR 620: exact Origin, a form body, the session's CSRF token; revokes the session row, clears the cookie, `303 /`. A GET is a 405 |

No sign-in, signing, identity-binding or team-provisioning route exists until its own lane: sign-in
`01M3Z43QYB`, KMS tokens `01M3Z43V58`, identity statement `01M3Z44K46`, create-team `01M3Z44MTV`.
There is no development issuer or test key to fall back to.

## The HTTP boundary

- **Host:** answered only on the hosts pinned in config (the issuer's host, plus an explicit list);
  any other Host is a 404.
- **Trust inputs are config, never the request:** the issuer is `MUSTERD_CONSOLE_ISSUER`, an https
  origin with no path. Nothing reads a Host header, a token's `jku`/`x5u`, or a caller-supplied URL
  to decide what to trust.
- **Forwarded headers are not read** — no route uses the client address.
- **Methods:** GET and HEAD only; a body is never read. Header size (16 KiB) and the request (10 s) and
  header (5 s) timeouts are bounded on the server.
- **Request id:** an inbound `x-request-id` is kept only if it is an 8–64 character safe token, else
  replaced; every response carries one.
- **Headers on every response:** HSTS, `nosniff`, `no-referrer`, a `default-src 'none'` CSP,
  frame-ancestors none, `cache-control: no-store` unless a route says otherwise.
- **One error shape:** `{error: {code, message}}` with stable messages.
- **Cookies** (none set by the skeleton): `hostCookie` is the one writer — `__Host-` prefixed, Secure,
  `Path=/`, HttpOnly, SameSite=Lax, no Domain, and no option to weaken any of it.

## Logs

One JSON line per event on stdout. A request line carries the request id, method, route **label**,
status and duration — never the raw path or query (a magic-link token rides a query string), never a
header or a body. A field whose name says it carries a secret is dropped; every remaining string goes
through `scrubCredentials` (ADR 445). The tests send an `Authorization`, a session cookie and token
query strings down the success, refusal and error paths and assert none reaches the log.

## The database

Its own Neon project, `musterd-console`. Schema version 1:

- `accounts (id, created_at, disabled_at)` — `id` is opaque, never an email (emails change, and a
  team member row binds it).
- `identities (provider, subject, account_id, email, created_at, last_used_at)`, primary key
  `(provider, subject)` — one account holds several; the binding is the provider's stable subject,
  never an email match.
- `audit (id, ts, request_id, actor_account_id, action, detail)` — append-only for the runtime.
- `console_meta (key, value)` — the schema version.

Schema version 2 (ADR 620, sign-in state):

- `accounts.session_generation` — revoke-all bumps it; a session whose generation is behind is dead.
- `sessions` — the id's SHA-256, account, generation, created / last-activity / idle and absolute
  expiries, `authenticated_at`, method and identity, `revoked_at` and reason. **14 days idle, 30
  days absolute, fresh for 15 minutes** (nick, against NIST SP 800-63B-4). Every read re-checks
  revocation, both expiries, account disable and generation in one query — no cache.
- `auth_transactions` — OAuth and magic-link transactions, single-use (`consumed_at`), every secret
  hashed.
- `rate_limits` — fixed windows per bucket, upserted atomically, so limits hold across servers.

The runtime may insert and update `sessions` and `auth_transactions` but never delete them —
revocation and consumption are columns, so the record survives.

Two roles. The **owner** migrates, from `musterd-console-migrate` only (`musterd-console migrate`,
the direct host). The **runtime** role serves: DML on `accounts` and `identities`, **INSERT and nothing
else on `audit`** (no read, update, delete or truncate), SELECT on the version row, no CREATE on the
schema, no membership in the owner. Audit retention is a separate maintenance role, not this one.
Boot refuses a schema that is not exactly its own (`schema newer|older than this build`), and the
server never migrates.

**Backups:** Neon's point-in-time restore until Cloud increment 3's backup lane (`01M3Z42KWH`), whose
scope includes this database: an independently encrypted nightly export to R2 in a separate
Cloudflare account, with the signing key never in a dump and a restore that does not revive consumed
tokens or sessions (nick, 2026-10-15).

## Deploy

`deploy/console/fly.toml` + `deploy/console/Dockerfile`, through the same `scripts/cloud/deploy.mjs`
(migrate, then a blue-green roll, then a probe of `https://app.musterd.io/health`), selected with
`FLY_APP`, `FLY_MIGRATE_APP`, `CLOUD_PROBE_HOST`, `CLOUD_FLY_CONFIG` and `CLOUD_MIGRATE_CMD`. The
console's secrets never include a team database URL. The provisioning steps are in
[cloud-ops](../guides/cloud-ops.md).

## File tree `packages/console/src/`

```
src/
  accounts.ts     // accountFor(db, identity, now): the account an identity (provider, subject) belongs to, or a new one — never by email; null when disabled; methodsOf(account)
  audit.ts        // appendAudit(db, {action, requestId, actorAccountId, detail}, now): one INSERT; detail goes through log.ts's redact, so no secret lands in audit
  bin.ts          // `musterd-console serve` (runtime role; refuses a foreign schema; listens) | `migrate` (owner URL + runtime role name, from the migrate app only); prints versions, never a URL
  config.ts       // resolveConsoleConfig(env, build): the pinned issuer (https origin, no path), allowed hosts, port, runtime DB URL; refusals name the variable, never the value
  csrf.ts         // csrfTokenFor(sid) (sha256 of the session id, base64url), csrfTokenValid (constant time), originAllowed (exactly the issuer; missing or null refused)
  clientip.ts     // clientIp(req, {behindFlyProxy, trustedProxies}): the rate-limit key — cf-connecting-ip only from a Cloudflare-range peer (fly-client-ip on Fly), else the peer itself; CLOUDFLARE_RANGES pinned 2026-10-16; bucketOf keys IPv6 by its /64
  cookies.ts      // hostCookie(name, value, maxAge?): the one cookie writer — __Host-, Secure, Path=/, HttpOnly, SameSite=Lax, no Domain
  db.ts           // Queryable (pg Pool / PGlite seam), schemaVersion, assertSchema (newer|older sentences), DATABASE_UNREACHABLE_SENTENCE
  http.ts         // createConsoleServer: host allow-list, GET/HEAD except the POST routes (Origin, form, CSRF), bounded headers and timeouts, request ids, security headers, /health and the empty JWKS, one error shape, one log line per request by route label
  log.ts          // makeLog / redact: JSON lines, secret-named fields dropped, every string through scrubCredentials
  providers.ts    // PINNED GitHub/Google endpoints, startFlow (state, PKCE S256, Google nonce; pinned callback), finishFlow (openid-client code exchange; Google ID token claims; GitHub numeric id from /user); ProviderOverrides for tests only
  ratelimit.ts    // hit(db, {bucket, max, windowMs}, now): one atomic upsert per hit, held across servers; pruneRateLimits
  request.ts      // SESSION_COOKIE, cookie(req, name), readForm(req) — urlencoded only, at most 8 KiB, else FormError 415/413
  returnpath.ts   // RETURN_PATHS allowlist and safeReturnPath(input): exactly a listed path, else "/"
  schema.ts       // SCHEMA_VERSION, MIGRATIONS (v1 accounts, identities, audit, console_meta; v2 sessions, auth_transactions, rate_limits), grantsFor(runtimeRole) (INSERT-only audit; no DELETE on sessions or transactions), migrate(owner, role)
  secrets.ts      // newSecret (256-bit base64url), hashSecret (SHA-256 hex — the only form a secret is stored in), sameSecret (constant time)
  sessions.ts     // IDLE_MS / ABSOLUTE_MS / FRESH_MS; createSession (always a new id), loadSession (one query: not revoked, both expiries, account live, generation current; touches at most once a minute), isFresh, revokeSession, revokeAllSessions
  testing.ts      // tests only: pglite() — a PGlite instance behind Queryable
  transactions.ts // TX_COOKIE, TX_TTL_MS; createOAuthTx (hashed cookie id and state), consumeOAuthTx (one atomic UPDATE … WHERE consumed_at IS NULL; cookie, provider, state, TTL)
```
