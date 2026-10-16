# 620 — Console sign-in: openid-client, Cloudflare Email Service, and the session and link rules

- Status: accepted
- Date: 2026-10-15
- Lane: `01M3Z43QYBT47XAPJGC5B2EZMS` (goal `cloud`, Cloud increment 2)
- Deciders: nick; fifty, with big-body (security), slippy (design) and sloane (copy) in thread
  `01M50ZHN7R`
- Builds on: [ADR 615](615-console-skeleton.md) (the console skeleton)

## Context

The console at `app.musterd.io` proves who a person is (Cloud spec §4.1): sign-in with GitHub, with
Google, or with an email magic link, then an ordinary browser session. ADR 615 shipped the skeleton
with no sign-in route at all. Hard rule 6 requires an ADR for any new runtime dependency, and both
the OAuth/OIDC client and the email sender are new. The console is the trust anchor team servers
verify against (§4.3), so a sign-in defect is an account-takeover defect.

## Problem

Sign-in needs a library to speak OIDC and OAuth correctly, a way to send email, and a set of rules
for sessions, magic links, account binding, CSRF and redirects. None is settled, and each is a place
where a plausible shortcut becomes a takeover path.

## Decision

1. **`openid-client` is the OAuth/OIDC library** (panva, v6, built on `oauth4webapi` and `jose`).
   Hand-rolled token verification was weighed and refused for the trust anchor. Configuration is
   pinned: Google's and GitHub's endpoints and the console's callback URLs are fixed config, never
   discovered from or influenced by input.
2. **Cloudflare Email Service sends the magic-link email.** `musterd.io` already lives in that
   Cloudflare account, so there is no new vendor. Resend and Postmark were weighed: a new vendor
   for slightly more mature deliverability tooling. The sending credential is least-privileged and
   separate from session and signing secrets. Auth emails carry no click tracking.
3. **Who an identity is.** Google binds by the validated `(iss, sub)`; GitHub by its numeric user id
   from the pinned `/user` endpoint; email by the address after a magic-link round trip. Never by
   email address across providers, never by GitHub login name. Subjects and addresses are not
   normalised (no plus-alias collapsing, no dot removal). Provider access and refresh tokens are
   discarded after sign-in. The console never hands a GitHub or Google token to a team server.
4. **Email never links accounts.** A matching email never selects an existing Google or GitHub
   account. Linking, unlinking or changing a sign-in method requires a fresh sign-in (decision 7)
   and proof of the new identity, cannot remove an account's last method, and is audited and
   notified.
5. **The OAuth transaction is bound and single-use.** Authorization code with PKCE and state, plus a
   nonce for Google's OIDC. The transaction binds provider, redirect URI, a browser cookie, state,
   the PKCE verifier and the intended return path; it is held server-side, short-lived, and consumed
   atomically in the database so it holds across servers. Provider mix-ups, unsolicited callbacks
   and error callbacks are refused. The nonce is never claimed to authenticate GitHub's OAuth flow.
6. **Magic links work only in the browser that asked (v1).** The link opens a confirmation page; a
   GET never signs anyone in or consumes the token, so mail scanners and prefetchers cannot use it.
   A CSRF-protected POST from the same browser consumes the token atomically and issues a fresh
   session. A click in another browser shows "open this in the browser where you started" instead
   of signing anyone in; a cross-device transfer is a later, designed flow. Tokens are high-entropy,
   stored hashed, live about 15 minutes, are scoped to address and transaction, and are used once.
   Responses never reveal whether an address has an account. The link URL is built from the pinned
   issuer, never from the request Host. Redemption pages carry no third-party content, `no-referrer`
   and `no-store`, and query tokens are excluded from every log.
7. **Sessions** (nick, 2026-10-15, against NIST SP 800-63B-4 and comparable products):
   - **14 days idle, 30 days absolute.** The console's sign-in is AAL1 — it cannot see a
     provider's MFA, and an email link is one factor — and AAL1's overall ceiling is 30 days.
     Google Workspace's default web session is 14 days.
   - **A fresh sign-in within the last 15 minutes for any sensitive action**: linking or unlinking a
     method, and every console-signed admin operation (§4.3: create, import, export, delete). This
     matches AAL3's inactivity limit and is stricter than Google's one-hour Admin console and
     GitHub's roughly two-hour sudo mode. A fresh sign-in makes the session recent; it does not make
     it AAL2.
   - A session row holds the identifier's hash, `account_id`, created, last-activity, idle and
     absolute expiries, `authenticated_at`, the method and identity used, `revoked_at` and reason,
     and the account's session generation for revoke-all. The identifier rotates on every sign-in
     and re-authentication; an anonymous cookie is never adopted as a session. Logout is a POST
     that revokes the row and clears the cookie. Revocation and account disable take effect on the
     next request on every server. IP and user agent are diagnostic, never a hard binding.
8. **CSRF and redirects.** Every authenticated change carries an explicit CSRF token and passes a
   strict Origin check against the pinned issuer (no suffix matching, no reflection; a missing or
   `null` Origin is refused for browser mutations); wrong content types are refused; a GET never
   changes state. SameSite=Lax is defence in depth, not the rule. The OAuth callback is a GET that
   authenticates by its single-use transaction (decision 5). The return path after sign-in is a
   same-origin relative path from a narrow allowlist, canonicalised before checking; `//`,
   backslashes, control characters, encoded variants and external origins are refused, and a
   failed sign-in never redirects anywhere a caller chose.
9. **Rate limits** at the edge and in the console, per IP, per address or account and per
   transaction, under global ceilings and an email send budget, with no lockout an attacker could
   use to keep a victim out. Callbacks get the same body and time limits as every route (ADR 615).
10. **Audit and logs.** Audit rows for sign-in start, result, reason and provider; session issue,
    revoke and revoke-all; identity link and unlink; with server-generated request ids. Never codes,
    verifiers, token hashes, cookies, magic URLs or provider user-info responses — in audit or logs —
    tested on the refused and error paths as well as success.
11. **A console session grants nothing on a team.** Team membership stays on the team server (§4.2);
    the §4.3 admin token's KMS signature and the team's own owner check stay separate from sign-in.

## Consequences

- Two new runtime dependencies for `@musterd/console`: `openid-client` (and through it
  `oauth4webapi` and `jose`) and the Cloudflare Email Service client or REST call. None reaches the
  team server.
- The console schema grows: sessions, OAuth transactions, magic-link tokens, and rate-limit state.
- Three human steps gate the lane's done-state: a GitHub OAuth app, a Google OAuth client, and
  `musterd.io` verified as an email sending domain. Their exact steps go in `docs/guides/cloud-ops.md`
  with the build.
- Before sign-in ships, tests cover: same and cross-browser links, a stolen link, a scanner GET,
  double redemption across two servers, session fixation, state and provider swaps, return-path
  variants, revoked and expired sessions, and the fresh-sign-in requirement.
- If export and delete ever need AAL2, the console needs a second factor (a passkey is the natural
  one). That is a separate decision.
- The screens and their words come from slippy and sloane; this record governs what the screens are
  allowed to do, not how they look.

## Observability & Evaluation

- **Traces:** audit rows per decision 10; `http_request` lines by route label (ADR 615), so sign-in
  starts, callbacks and redemptions are countable without logging a token.
- **Eval:** the test list in Consequences, on PGlite for the store and over HTTP for the flows,
  with synthetic secrets asserted absent from every log line.
- **Experiment:** the lane's done-state — a person signs in at `app.musterd.io` by each of the
  three ways and gets one account per identity. Falsify: a magic link that signs in on a GET, a
  session that survives revoke-all on either server, or two providers merged into one account by a
  shared email.
