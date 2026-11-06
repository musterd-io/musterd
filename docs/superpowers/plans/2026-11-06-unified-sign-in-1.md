# Unified sign-in, increment 1 — hosted `/live` signs in with a musterd account — Implementation Plan

> **For agentic workers:** two lanes, two branches, two PRs, in order. Implement in your own seat
> (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person with a musterd account — including one made with GitHub, which has no email —
presses **Sign in with musterd** on a hosted team's `/live` and lands signed in, with nothing pasted.

**Architecture:** The identity proof gains a `use: "identity"` claim and loses its required email
(new ADR). The console gets `GET /handback`, which signs that proof and answers a self-submitting
form to the team's `/live/signin/callback` (ADR 722 §1, server half shipped in #3982). `/live`
learns whether it is hosted by asking `POST /live/session/token`, shows the button when signed out,
and holds the 15-minute `msat_` in memory.

**Tech stack:** TypeScript; `node:http` (console, server); React (web); vitest; Playwright for the
cross-site test.

**Spec:** [`2026-11-06-unified-sign-in-design.md`](../specs/2026-11-06-unified-sign-in-design.md)
§4, §5 (`/live` hosted row), §11.1. ADR 722 §1–3 for the flow.

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 1a. Proof `use` claim (ADR) + console `/handback` | `01M6RZ8K12GE19462YH3H1BMRQ` | 1–3 |
| 1b. `/live` button, in-memory token, cross-site browser test | `01M6S2TXHVHRZZ38ARRX4BR5PD` | 4–5 |

The other nine lanes of goal `unified-sign-in` get their own plans when picked up.

## Global Constraints

- The proof is ES256, ≤ 60 s, one audience, single-use `jti` (ADR 698 §1); only `use` and
  `email`'s optionality change.
- The console builds the callback URL itself: `https://<team>.<config.teams.suffix>/live/signin/callback`.
  Nothing from the query becomes a URL (ADR 722 §1).
- The statement never appears in a URL, a log line or an audit detail (hard rule 5); audit names
  only `aud`, `team`, `jti`.
- No new runtime dependency (hard rule 6).
- Console copy lives character-for-character in `docs/design/console-signin-copy-spec.md`; new
  strings are added there in the same commit, and sloane reviews them.
- Self-hosted `/live` behaviour does not change (ADR 722 §5).

## Review Focus

1. **A GitHub-only account** (identity email `null`) gets a statement with no `email` and is
   admitted. → Task 1 and Task 3 tests.
2. **Sign-in starting from `/handback` with no console session** returns to `/handback` after
   GitHub, Google *or* the email link, not to `/account`. → Task 3 test on `/auth/email/start`.
3. **A second visit to the same `/handback` URL** (back button, double click) signs a new `jti`;
   the team refuses the spent state with its own page, and the console does not loop. → Task 3.
4. **The 15-minute token expires while `/live` is open** — it is refreshed before expiry, and a
   failed refresh shows the signed-out state rather than a dead socket. → Task 4.
5. **Self-hosted `/live`** (`/live/session/token` answers 404) renders exactly today's form. →
   Task 4.

---

### Task 1: the `use` claim — ADR and the team server's verifiers (lane 1a)

**Files:**
- Create: `docs/decisions/NNN-identity-proof-use-claim.md` (NNN from `pnpm adr:next`; push the
  branch as a draft PR **before** writing it, ADR 223)
- Modify: `docs/decisions/698-console-identity-statement.md` (dated `_(Amended …)_` marker beside
  Decision 1–2, a Consequences note); `docs/decisions/722-hosted-live-browser-session.md`
  (Consequences note)
- Modify: `packages/server/src/cloud/consoleToken.ts:160-243`
- Test: `packages/server/src/cloud/consoleToken.test.ts`, `packages/server/src/transport/liveSession.test.ts`

**Interfaces:**
- Produces: `IdentityClaims { accountId: string; email: string | null; jti: string; exp: number }`;
  `verifyIdentityStatement` requires `use === 'identity'`; `verifyConsoleToken` refuses
  `use === 'identity'`.

- [ ] **Step 1: Write the failing tests** in `consoleToken.test.ts`:
  - `accepts a statement with use:"identity" and no email` → `claims.email === null`, `accountId === 'acct_1'`.
  - `accepts use:"identity" with an email and returns it`.
  - `refuses a token without use:"identity" as an identity statement` (even with an email) → reason `malformed`.
  - `the admin verifier refuses an identity statement` → `verifyConsoleToken(issuer.token(AUD, { sub, use: 'identity' }))` rejects `malformed`.
  - `the admin verifier still accepts a token with no use`.
  - Replace the old `refuses a statement with no email as malformed` test.
- [ ] **Step 2:** In `liveSession.test.ts` change the `statement()` helper to
  `issuer.token(AUD, { sub, use: 'identity', ...over })` (no email), and add
  `admits a GitHub-shaped statement with no email` (callback → 303 `/live`, session row exists).
- [ ] **Step 3: Run** `pnpm --filter @musterd/server exec vitest run src/cloud/consoleToken.test.ts src/transport/liveSession.test.ts` — expect the new tests to FAIL.
- [ ] **Step 4: Implement.** `Claims` gains `use: z.enum(['identity']).optional()`; keep `email`
  optional. `verifyIdentityStatement`: `if (c.use !== 'identity') throw refuse('malformed', 'not an identity statement')`,
  return `email: c.email ?? null`. `verifyConsoleToken`: `if (c.use === 'identity') throw refuse('malformed', 'an identity statement is not an admin token')`.
  `grep -rn "\.email" packages/server/src` for any reader of `IdentityClaims.email` and make it
  null-safe (none expected).
- [ ] **Step 5: Run** the same command — PASS.
- [ ] **Step 6: Write the ADR** (Context: GitHub identities carry no email; Decision: the `use`
  claim, email optional, both verifiers; Consequences; Observability & Evaluation: the refusal
  reasons above are the eval). Amend 698/722 as listed. `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 7: Commit** `feat(server): identity proofs carry use:"identity"; email optional (lane 01M6RZ8K12)` with `Refs ADR-NNN`.

### Task 2: the console signs an identity statement (lane 1a)

**Files:**
- Modify: `packages/console/src/tokens.ts`
- Test: `packages/console/src/tokens.test.ts`

**Interfaces:**
- Consumes: `TokenSigner`, `audienceOk` (existing).
- Produces: `signIdentityStatement(signer: TokenSigner, c: { iss: string; sub: string; aud: string; email: string | null; nowS: number }): Promise<{ token: string; jti: string }>`.
  `signConsoleToken` and it share one private `signJws(signer, payload)`.

- [ ] **Step 1: Write the failing tests:**
  - `signs use:"identity", the audience, iat/exp 60 s apart, and verifies against the published key` (decode payload; verify with `createPublicKey(jwk)` as the existing `/tokens` test does).
  - `omits email when null` (`'email' in payload === false`) and `carries it when given`.
  - `refuses a bad audience` (same as `signConsoleToken`).
  - `an admin token carries no use claim` (regression for Task 1's separation).
- [ ] **Step 2: Run** `pnpm --filter @musterd/console exec vitest run src/tokens.test.ts` — FAIL.
- [ ] **Step 3: Implement** `signIdentityStatement` and the shared `signJws`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(console): sign an identity statement (lane 01M6RZ8K12)`.

### Task 3: `GET /handback` (lane 1a)

**Files:**
- Create: `packages/console/src/handback.ts`, `packages/console/src/handback.test.ts`,
  `packages/console/assets/handback.js`
- Modify: `packages/console/src/returnpath.ts` (+ `returnpath.test.ts`), `packages/console/src/pages.ts`,
  `packages/console/src/http.ts`, `packages/console/src/audit.ts`,
  `docs/design/console-signin-copy-spec.md`, `docs/architecture/03-server.md` (console section, file tree)

**Interfaces:**
- Consumes: `signIdentityStatement` (Task 2); `methodsOf`, `loadSession`, `hit`, `appendAudit` (existing).
- Produces (in `handback.ts`):
  - `HANDBACK_STATE = /^[A-Za-z0-9_-]{16,128}$/`, `TEAM_SLUG = /^[a-z0-9-]{1,32}$/` (move the one in `http.ts` here and import it back).
  - `parseHandbackShape(path: string): { aud: string; team: string; state: string } | null` — pure:
    pathname exactly `/handback`, exactly the three params once each, `audienceOk(aud)`, slug and state regexes.
  - `handbackPath(p: { aud: string; team: string; state: string }): string` — canonical
    `/handback?aud=…&team=…&state=…` via `URLSearchParams` in that order.
  - `callbackUrl(team: string, suffix: string): string` → `https://${team}.${suffix}/live/signin/callback`.
  - `handbackCsp(callbackOrigin: string): string` → `PAGE_CSP` with `script-src 'self'` added and
    `form-action` set to exactly `callbackOrigin`.
  - `statementEmail(db: Queryable, session: Session): Promise<string | null>` — the current
    identity's email, else the first non-null email of the account's identities, else `null`.
- `pages.ts`: `SignInOptions.returnTo?: string` → every sign-in form carries
  `<input type="hidden" name="return" value="…">`; `handbackPage(o: { action: string; team: string; statement: string; state: string }): string`;
  `errorPages.handback()`.
- `audit.ts`: `AuditAction` gains `'statement.issue'`.

- [ ] **Step 1: Write the failing tests** (`handback.test.ts`, booting the console as `teams.test.ts` does, with `config.teams = { suffix: 'musterd.test', audience: AUD }` and a `localSigner()`):
  - `no session: answers the sign-in page carrying the canonical handback path as return`.
  - `an aud that is not the configured audience is the handback error page (400), nothing signed` (no `statement.issue` audit row).
  - `a bad team slug, a short state, a repeated or extra param are each 400`.
  - `with a session: 200, form action is exactly https://acme.musterd.test/live/signin/callback, hidden state equals the query's, hidden statement decodes to use:"identity", aud, sub = the account`.
  - `a GitHub session (identity email null) signs a statement with no email`.
  - `the CSP carries form-action https://acme.musterd.test and script-src 'self', and referrer-policy is no-referrer, cache-control no-store`.
  - `two visits sign two different jti` and write two `statement.issue` rows naming `aud`, `team`, `jti` — and no statement text.
  - `no signer or no config.teams: 404`.
  - `rate-limited with /tokens' per-account bucket: the 31st in a minute is 429`.
  - `POST /auth/email/start with return=<handback path> stores it, and confirming lands on /handback` (Review Focus 2).
  - In `returnpath.test.ts`: the canonical handback path passes `safeReturnPath`; with an extra param, a `//` host, or an encoded `?` it becomes `/`.
- [ ] **Step 2: Run** `pnpm --filter @musterd/console exec vitest run src/handback.test.ts src/returnpath.test.ts` — FAIL.
- [ ] **Step 3: Implement** `handback.ts`; `safeReturnPath` also accepts `p` when `parseHandbackShape(p)` is non-null and `handbackPath(that) === p` (length cap 512 for that branch, 64 otherwise).
- [ ] **Step 4: Implement** the route in `http.ts` beside `/account`: `GET|HEAD /handback` → 404 unless `deps.signer && config.teams`; parse; `aud !== config.teams.audience` → 400 error page; no session → `signInPage({…, returnTo: handbackPath(p)})`; else the rate limit, `signIdentityStatement`, `appendAudit('statement.issue', { aud, team, jti })`, `sendHtml(res, 200, handbackPage(…), { 'content-security-policy': handbackCsp(origin), 'referrer-policy': 'no-referrer' })`. A `HEAD` answers the headers without signing. No freshness check: any live console session may sign (the proof lives 60 s; ADR 722 needs only "signed in").
- [ ] **Step 5: Implement** `handbackPage`, `errorPages.handback()`, the hidden `return` field, and `assets/handback.js` (submits `document.forms[0]` on `DOMContentLoaded`; the page also shows a **Continue** button for no-script). Register the asset like `console.css`. Copy (to the copy spec, for sloane): title `Signing you in — musterd`; heading `Signing you in to {team}`; lede `One moment — taking you back to your team.`; button `Continue`; error heading `This sign-in link isn't valid`, body `Go back to your team and choose Sign in with musterd again.`
- [ ] **Step 6: Run** the Step 2 command and `pnpm --filter @musterd/console test` — PASS.
- [ ] **Step 7:** `pnpm typecheck && pnpm lint && pnpm format:check` (`arch-trees:check` needs the new files in 03-server's console tree).
- [ ] **Step 8: Commit** `feat(console): /handback signs an identity statement and hands it to the team (lane 01M6RZ8K12)`; open the PR, auto-merge, `lane_submit`.

### Task 4: `/live` signs in with musterd (lane 1b)

`packages/web/src/routes/live.tsx` is held by wallow's lane `01M64SXW85` under block posture —
agree the edit with wallow (`team_send`) before Step 4.

**Files:**
- Create: `packages/web/src/live/hostedSession.ts`, `packages/web/src/live/hostedSession.test.ts`
- Modify: `packages/web/src/routes/live.tsx` (the sign-in form, ~`:1280-1330`, and the connect path),
  `packages/web/src/live/client.ts` (accept an in-memory `msat_` as the claim key; 4401 handling)

**Interfaces:**
- Consumes: `POST /live/session/token` → 200 `{ as, access_token, expires_in }` | 401 | 404;
  `POST /live/signout`; `GET /live/signin/start` (all shipped, #3982).
- Produces:
  - `type HostedSession = { kind: 'self_hosted' } | { kind: 'signed_out' } | { kind: 'signed_in'; as: string; token: string; expiresAt: number }`
  - `probeHostedSession(fetchImpl?: typeof fetch, now?: () => number): Promise<HostedSession>` — 404 or network error → `self_hosted`; 401 → `signed_out`; 200 parsed with zod.
  - `refreshDelayMs(s: { expiresAt: number }, now: number): number` → `max(0, expiresAt - now - 60_000)`.
  - `signOutHosted(fetchImpl?: typeof fetch): Promise<void>`.
  - `SIGN_IN_PATH = '/live/signin/start'`.

- [ ] **Step 1: Write the failing tests** (`hostedSession.test.ts`, mocked fetch): 404 → self_hosted; network throw → self_hosted; 401 → signed_out; 200 → signed_in with `expiresAt = now + expires_in*1000`; malformed 200 body → signed_out; the request is `POST` with `credentials: 'same-origin'`; `refreshDelayMs` is 14 min for a fresh 15-min token and 0 when past due.
- [ ] **Step 2: Run** `pnpm --filter @musterd/web exec vitest run src/live/hostedSession.test.ts` — FAIL.
- [ ] **Step 3: Implement** `hostedSession.ts`.
- [ ] **Step 4: Wire `live.tsx`:** probe on mount before the sign-in form renders. `self_hosted` → today's form, unchanged. `signed_out` → a card with heading `Sign in to {team}`, a primary link-button **Sign in with musterd** (`href={SIGN_IN_PATH}`) and the line `You'll sign in at musterd.io and come straight back.` — no paste field, no seat field. `signed_in` → connect with `{ as, key: token }`; schedule a re-probe at `refreshDelayMs`; a failed refresh or a socket close `4401` → `signed_out`. **Sign out** in the account menu calls `signOutHosted()` then shows `signed_out`. The token is never written to storage.
- [ ] **Step 5:** Add component tests beside the existing `live.tsx` tests for the three states (self-hosted renders the paste field; signed_out renders only the button; signed_in never touches `localStorage`).
- [ ] **Step 6: Run** `pnpm --filter @musterd/web test` — PASS; then the fast gates. The ADR 151 perf budget must stay green.
- [ ] **Step 7: Commit** `feat(web): hosted /live signs in with musterd (lane 01M6S2TXHV)`.

### Task 5: the real-browser cross-site round trip (lane 1b)

**Files:**
- Create: `packages/web/e2e/hosted-signin.spec.ts`
- Modify: `docs/architecture/06-testing.md` (the new e2e, one line)

- [ ] **Step 1: Write the test:** a Cloud-mode team server and the console (with `localSigner`, the JWKS the server pins) on **two different sites** over HTTPS (self-signed; how TLS is served is the builder's call). Real Chromium: open the team's `/live` → click **Sign in with musterd** → console sign-in (test email path or a seeded session) → auto-submitted form → `/live` shows the member connected. Assert the `__Host-musterd_signin` cookie reached the callback (the session exists), and `localStorage` holds no `msat_` / `mscr_`.
- [ ] **Step 2: Run** it locally once to see it pass (`pnpm --filter @musterd/web exec playwright test e2e/hosted-signin.spec.ts`), then let CI own it.
- [ ] **Step 3: Commit, PR, auto-merge, `lane_submit`.** Close lane 1b with `follows_up` naming the next lane picked from goal `unified-sign-in`.
