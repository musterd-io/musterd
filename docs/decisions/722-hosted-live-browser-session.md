# 722 — Hosted `/live` sign-in: a console hand-back and a revocable browser session

- Status: proposed
- Date: 2026-10-23
- Lane: `01M3Z458B261P8DW8VX4A7XCHG` (Cloud 4)
- Relates to: [ADR 698](698-console-identity-statement.md) (the statement and `account_id`),
  [ADR 620](620-console-sign-in.md) (console sign-in), [ADR 557](557-local-identity-every-human-credential.md) /
  [ADR 580](580-human-credentials-require-human-admin.md) (self-hosted one-click identity),
  [ADR 616](616-demo-audiences-read-at-broadcast-grade.md) (graded watch links),
  [ADR 662](662-one-machine-per-hosted-seat.md) (high-authority acts need an A2 signature),
  cloud design spec §4.4 and §8 (`docs/superpowers/specs/2026-09-29-musterd-cloud-design.md`)

## Context

Spec §4.4 says that on a hosted team, `/live` signs in through the console with no pasted
credential. The team server then issues a **browser session**: scoped to the team's origin, good
for days, and revocable from the roster. The 60-second identity statement is consumed once, at
sign-in.

ADR 698 shipped the verifier (`verifyIdentityStatement`) and the binding (`members.account_id`,
`bindMemberAccount`, `memberByAccount`). Measured on trunk at `876a2a41b`, nothing else exists yet:

- **Nothing on the console issues a statement.** The console's only signing route is
  `POST /tokens` (`packages/console/src/http.ts:481`), which makes the §4.3 admin token. That
  token has no `email`, so the identity path would refuse it as `malformed`. The console's
  return paths after sign-in are limited to `/` and `/account` (`console/src/returnpath.ts:8`).
- **The server has no cookie code.** Every HTTP route reads `Authorization: Bearer`
  (`transport/http.ts` `bearer()`). `/live` keeps `{as, token}` in localStorage
  (`web/src/live/memberIdentity.ts`) and puts the token in the WebSocket `claim` frame's `key`.
  `ws.ts` resolves a human only by `members.credential_hash`.
- **On a public face the server skips the Origin check** (`config.ts` `checkUpgrade`). The reason
  given is that everything arriving there carries a bearer. A cookie that authorizes requests
  would break that assumption on every route at once.
- **No per-session revoke exists.** The only revoke is credential rotate, which re-mints `mscr_`
  and calls `revokeAllForMember`.

## Decision

1. **The hand-back is a form POST, not a redirect with the statement in the URL.** A **Sign in
   with musterd** button on a hosted `/live` goes to `GET /live/signin/start` on the team origin.
   That route:
   - sets a short-lived `__Host-musterd_signin` cookie: a random `state`, 10 minutes,
     HttpOnly, Secure, SameSite=Lax;
   - redirects to `https://<console>/handback?aud=<consoleAudience>&team=<slug>&state=<state>`.

   The console makes the person sign in if they have no session (`/handback` joins the allowed
   return paths). It then signs an identity statement (ADR 698 §1: `sub`, `email`, `aud`, `jti`,
   `exp` ≤ 60 s) and answers with a self-submitting form that POSTs `statement` and `state` to
   `https://<slug>.<hostSuffix>/live/signin/callback`.

   - The console builds that URL itself from `team` and the `hostSuffix` it holds for that `aud`.
     It never takes a return URL from the query, so there is no open redirect.
   - The statement never lands in a URL, so it stays out of history, logs and `Referer`.

2. **The callback trusts only what it can check.** `POST /live/signin/callback` refuses unless all
   of these hold:
   - the form's `state` equals the signin cookie's (this blocks login CSRF; the cookie is cleared
     either way);
   - `verifyIdentityStatement` passes, which brings ADR 698's refusals and the single-use `jti`;
   - `memberByAccount(team, sub)` finds a member who is still on the team.

   An unbound account binds in exactly two ways in this ADR:
   - **Invite.** An invite secret carried in `state`'s server-side record redeems through the
     existing ADR 450 path. The new member is bound with `bindMemberAccount`.
   - **Link.** A member already signed in on this browser with their `mscr_` starts the round
     trip as **Link my musterd account**. The callback binds the account to that member.

   Otherwise the page says the account is not on this team and to ask an owner for an invite. It
   does not say which members exist.

3. **The session is a cookie, and it is only ever traded for a short access token.**
   - **The cookie.** `__Host-musterd_s` holds `mbs_<32 random bytes>`: HttpOnly, Secure,
     SameSite=Lax, Path=/. `__Host-` pins it to the exact team host, which is the per-team origin
     §4.4 asks for.
   - **The table.** A new team-owned `browser_sessions` table holds `id`, `team_id`, `member_id`,
     `secret_hash`, `created_at`, `last_used_at`, `expires_at`, `revoked_at` and a `label`. The
     label is a user-agent family, never the full string. The table has an RLS policy and joins
     the tenancy inventory (§8.2).
   - **Lifetime.** 14 days absolute, and 3 days idle.
   - **What the cookie authorizes: one route.** `POST /live/session/token` checks that the
     `Origin` exactly equals the team origin and that `Sec-Fetch-Site` is `same-origin`. It then
     mints a 15-minute `msat_` through `mintTokenPair`, on an OAuth chain linked to the
     session's `id`, and returns `{ as, access_token, expires_in }`.
   - **Where the token lives.** `/live` holds the token in memory only, never in storage, and uses
     it exactly as it uses a bearer today, on HTTP and in the WS `claim` frame. `ws.ts` learns to
     resolve a human `msat_` through `verifyAccess`, the same function the HTTP side uses.
   - **What this buys.** Every other route stays bearer-only, so the public-face Origin skip stays
     true and no route needs a CSRF token. The cost is that a script on the page could read a
     ≤15-minute token. A cookie that authorized every route directly would hand that same script
     the whole session, so this trade does not lose.

4. **Revocation is per session, and it reaches the open tab.**
   - `GET /teams/:slug/members/:name/sessions` lists a member's sessions. The member sees their
     own; an admin sees anyone's.
   - `DELETE …/sessions/:id` and `POST /live/signout` (cookie, Origin-checked) set `revoked_at`,
     revoke the linked `msat_` chains, and close that session's open WebSockets with a stable
     close reason. `/live` turns that reason into "You were signed out."
   - Credential rotate also revokes every browser session of that member.
   - The roster's member card gets a **Signed-in browsers** list with a **Sign out** button on
     each row.

5. **Where it sits beside the other ways in.**
   - **Self-hosted is untouched.** `MemberSignIn.tsx`, the ADR 557/580 one-click
     `/local-identity`, and `/signin-handoff` stay as they are. All of them are local-only by
     ADR 580.
   - **Hosted teams** (`ctx.config.cloud`) never render the paste form: the hosted `/live` shows
     only the console button. The server keeps accepting `mscr_` bearers for the CLI and for
     MCP, because §4.4 retires the browser paste path, not the credential.
   - **ADR 616 graded watch links are unchanged.** They are observer seats carried in a `#w=`
     fragment, not a member signing in. They never receive a session cookie, and a cookie never
     upgrades an observer.
   - **The cookie grants no authority.** ADR 662's A2 signature is still required for every
     high-authority act; a session is an A0/A1 credential like the `mscr_` it replaces.

6. **The seam with away-channel pairing (stanley, `01M50XPYZ9`).** "Already authenticated on
   `/live`" means, on a hosted team, holding a token minted from this session. Pairing routes
   stay bearer-authenticated and need no change.

## Consequences

- A hosted member signs in with one click after their first console sign-in. Nothing secret is
  ever pasted, and nothing long-lived sits in localStorage.
- One new credential prefix (`mbs_`, never sent as a bearer, refused by `authMember`), one table,
  and four routes. The console gains one route (`/handback`) and one statement signer next to
  `signConsoleToken`.
- A member can see and end each browser where they are signed in. Losing a laptop no longer means
  rotating the credential that every one of their CLIs uses.
- Self-hosted behaviour and its tests do not change; the loopback audit (§8.3) gains the four new
  routes.

## Observability & Evaluation

- **Traces / audit:** the audit records `session.created`, `session.revoked` (with `by`: self,
  admin or rotate) and `session.refused` (with a reason code). They carry the session id and
  member, never the secret, the statement, the email or the account id (hard rule 5).
- **Eval:** the server tests are the falsifiers.
  - A callback is refused on each of these, and each refusal leaves no session row: state
    mismatch, a missing signin cookie, a replayed statement, the wrong `aud`, an unbound
    account, and a member who has left.
  - `/live/session/token` is refused with no cookie, a foreign `Origin`, cross-site
    `Sec-Fetch-Site`, a revoked session, or a session past idle or absolute expiry.
  - Revoking a session refuses its next exchange and closes its open socket.
  - The cookie, sent as a bearer to any other route, is refused.
  - On the console side, `/handback` refuses an `aud` it does not hold a host suffix for, and it
    never redirects to a host it did not build.
  - End to end on the test issuer: the §8 seat-bar line "/live signs in with no pasted
    credential" passes.
- **Experiment:** n/a. This is an access path; its falsifiers are the refusals above.
