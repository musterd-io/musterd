# Cloud 4 inc 1 — hosted `/live` sign-in, the server half — Implementation Plan

> **For agentic workers:** one lane, one branch, one PR. Implement in your own seat (AGENTS.md hard
> rule 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a hosted team the server can sign a browser in through the console with no pasted
credential, hold that as a revocable browser session, trade it for a short access token the page
uses as a bearer, and end it per browser — exactly [ADR 722](../../decisions/722-hosted-live-browser-session.md)
§1–4. The console's `/handback` and the `/live` page are later increments.

**Architecture:** two new team-owned tables on one ladder step; two stores; one transport module
holding the four cookie routes; `ws.ts` resolves a human `msat_` through `verifyAccess`; the hub
can close every socket of one session; the member routes list and revoke sessions; credential
rotate revokes them too. Every refusal is a `session.refused` audit row with a reason code and no
secret.

**Tech stack:** TypeScript, `node:http`, the portable migration ladder (SQLite + Postgres), vitest
over `withDrivers` (stores) and `bootCloud` + `testIssuer` (routes).

**Spec:** ADR 722 (its Observability section is the falsifier list this lane's tests follow).

## Increments

| Increment                                                 | Lane                         | Tasks |
| --------------------------------------------------------- | ---------------------------- | ----- |
| 1. Server: tables, stores, routes, ws, revoke, docs       | `01M5WX0ZXM5NBNWCBP8KDG8PWB` | 1–6   |
| 2. Console: `/handback` signs an identity statement       | `01M3Z458B261P8DW8VX4A7XCHG` | —     |
| 3. `/live`: the console button, the in-memory token       | `01M3Z458B261P8DW8VX4A7XCHG` | —     |
| 4. Real-browser cross-site cookie test (Playwright)       | `01M3Z458B261P8DW8VX4A7XCHG` | —     |

Increments 2–4 hang off the Cloud 4 lane until their own lanes are opened when this one lands
(`follows_up` on its close).

## Decisions taken inside ADR 722's lines

- **Console origin.** The ADR names `<console>` without a setting. The console publishes its JWKS,
  so its origin is `new URL(cloud.consoleJwksUrl).origin`; no new environment variable. Recorded in
  the ADR's Consequences.
- **Invite in the state record.** The ADR carries "an invite secret" in the state record. The invite
  store keeps only hashes, so the secret is checked at `start` (`checkInvite`, charged on a miss)
  and the record carries the invite **id** and the name the stranger chose; the callback re-checks
  the invite is still live and the name still free before `addMember` + `consumeInvite`. Nothing
  secret lands in the table.
- **Linking a chain to a session.** `oauth_tokens.scope` carries `session:<id>`; the client id is
  one registered-once-per-team `musterd-live` DCR client (the FK to `oauth_client_bindings` needs
  one). Revoking a session revokes its chains by that scope.
- **The 15-minute token.** `mintTokenPair` takes an optional `accessTtlMs` cap; the refresh token
  it mints is never returned on this path and dies with the session's revoke.

## Task 1: the tables and the stores

- [x] Ladder step (next free number; wallow's ADR 769 step is taken in parallel): `signin_states`
      and `browser_sessions`, portable SQL, both carrying `team_id` (tenancy inventory picks them up).
- [x] `store/signinStates.ts`: `startSigninState`, `consumeSigninState` (one-shot, expiry-checked,
      returns the record or a reason), prune on the way in.
- [x] `store/browserSessions.ts`: `createBrowserSession` (returns the `mbs_` secret once),
      `resolveBrowserSession` (hash, idle and absolute expiry, touches `last_used_at`),
      `listBrowserSessions`, `revokeBrowserSession`, `revokeBrowserSessionsForMember`.
- [x] Tests on every driver, failing first.

## Task 2: the OAuth store hooks

- [x] Export `ensureClientBinding`; add `liveSessionClient(db, teamId)` that registers the
      `musterd-live` client once; `mintTokenPair` accepts `accessTtlMs`; `revokeChainsByScope`.

## Task 3: `transport/liveSession.ts`

- [x] Cookie parse/serialize (`__Host-` attributes exactly as ADR 722 §1 and §3).
- [x] `GET|POST /live/signin/start`, `POST /live/signin/callback`, `POST /live/session/token`,
      `POST /live/signout`; hosted only (self-hosted answers 404); team from the Host header.
- [x] Every refusal in ADR 722's eval list, each leaving no session row, each a `session.refused`.
- [x] Tests on `bootCloud` with `testIssuer`.

## Task 4: the socket side

- [x] `ws.ts`: a `msat_` claim key resolves through `verifyAccess`; the connection carries the
      session id read from the token's scope. `hub.closeSession(sessionId, code, reason)`.

## Task 5: the member routes and rotate

- [x] `GET /teams/:slug/members/:name/sessions` (self or admin), `DELETE …/sessions/:id`.
- [x] Credential rotate revokes the member's sessions.

## Task 6: audit, sweep, docs

- [x] `session.created` / `session.revoked` / `session.refused` with `AUDIT_SUBJECT` entries.
- [x] Loopback sweep rows for the four routes.
- [x] `01-data-model.md` (the step), `03-server.md` (file tree, Auth, Cloud mode), ADR 722
      Consequences (the decisions above), this plan's checkboxes.
