# 820 — Connecting Claude or ChatGPT to a hosted team signs in with musterd

- Status: proposed
- Date: 2026-11-06
- Lane: `01M6S2VPWRQ2TXTP3X4G4ERRZ6` (goal `unified-sign-in`, increment 4)
- Builds on: [ADR 446](446-remote-mcp-https-oauth.md) (the team server as an OAuth server for MCP
  clients), [ADR 450](450-team-invite-join.md) (invites on the consent page),
  [ADR 722](722-hosted-live-browser-session.md) (the console round trip),
  [ADR 818](818-identity-proof-use-claim.md) (the identity proof)
- Spec: [`2026-11-06-unified-sign-in-design.md`](../superpowers/specs/2026-11-06-unified-sign-in-design.md)
  §5 (the MCP row), §12

## Context

When someone adds a team's MCP URL to Claude, ChatGPT or Codex, the client opens the team's
consent page, `GET /oauth/:team/authorize`. That page has three forms:

- **I'm new — I have an invite** (ADR 450): a room code or link secret, and a chosen name;
- **I already have a seat**: the seat name and its permanent `mscr_`, pasted;
- **Connecting an agent?** ([ADR 452](452-agent-connect-over-oauth.md)): an agent's connect link.

A member of a hosted team has a musterd account and, since ADR 722 and ADR 818, can prove it with
one click. They usually have no `mscr_` at all: a member admitted through the console never sees
one (`liveSession.ts` drops it on purpose). The "I already have a seat" form therefore asks a hosted
member for a secret they do not hold. And a member who does hold one has to carry their permanent
credential to whatever device runs the client, often a phone.

## Problem

Let a hosted member connect an MCP client by signing in with their musterd account, with no
pasted secret and no new long-lived way for a browser to authorize a client, and keep the paths
self-hosted teams and guests still need.

## Decision

1. **On a hosted team the consent page leads with "Sign in with musterd".** It is a form that POSTs
   the same OAuth fields the other forms post, plus `via=musterd`, to `POST /oauth/:team/authorize`.
   The words are the sign-in copy spec's §4.
2. **That POST starts the console round trip for this one authorization.** It is refused unless
   `Sec-Fetch-Site` is `same-origin`: only the consent page this server rendered may start a
   connect. Without that, any site could auto-submit the form with its own `client_id`, and a
   visitor already signed in to the console would be walked to that client's redirect with a code
   and no click (CSRF). `Origin` cannot be the check: the OAuth pages send no referrer, so a
   browser sends `Origin: null` even on the real POST. A browser that sends no `Sec-Fetch-Site` is
   refused. The server then makes the
   same client and `redirect_uri` checks every consent POST makes, then writes a one-time state
   record (ADR 722 §1) in a new mode, `connect`. The record carries the validated authorization
   request: `client_id`, `redirect_uri`, `code_challenge`, `scope` and the client's `state`. It
   sets the `__Host-musterd_signin` cookie and answers `303` to the console `/handback`.
3. **The callback shows who is connecting, and the code waits for the person's Allow.** For a
   `connect` record, `POST /live/signin/callback` makes every ADR 722 §2 check and finds the member
   the account is bound to (`memberByAccount`, humans only). It issues nothing yet. The console may
   have signed with whatever account was already signed in there, so the callback answers a page
   that names the client, the team and that member, with **Allow** and **Cancel**. Behind the page
   is a second one-time state in mode `grant`, which pins the member and the request and is set in
   the same cookie.
   `POST /live/signin/connect` is the page's only target. It requires `Sec-Fetch-Site:
   same-origin`, the cookie to equal the form's state, and an unspent `grant`. It reads the request
   from the grant, never from the form, so no field can swap the client or the redirect. On Allow it
   re-checks that the member still stands and that the client is still registered with that exact
   redirect, issues the OAuth code exactly as the consent POST does, and answers `302` to the
   client's `redirect_uri` with `code` and `state`. On Cancel it answers `302` with
   `error=access_denied` and `state` (RFC 6749 §4.1.2.1). The page is never framed. Neither step
   creates or reads a browser session: a `/live` cookie never authorizes a client.
4. **An account that is not on the team is refused, as on `/live`.** The invite form stays for
   strangers. Joining by invite through the console for a connector is later work.
5. **A hosted team's consent page drops the `mscr_` form.** A self-hosted team (where the sign-in
   routes answer 404) keeps it until it can be linked to an account (unified sign-in lane 8). The
   invite form and the agent-connect form are unchanged on both.
6. **No protocol change.** `via=musterd` is parsed on the server by its own schema, derived from
   `OAuthAuthorizeConfirmSchema` without its `proof`. The `connect` request is stored as one JSON
   column on `signin_states`, a portable ladder step.

## Consequences

- A hosted member connects a client in one click plus, at most, a console sign-in. Nothing is
  pasted, and no permanent credential travels to a phone.
- Each connector authorization is its own identity proof (60 s, single use, ADR 818), but a fresh
  proof is not fresh authentication: the console signs it from whatever session it already holds,
  up to 14 days idle (ADR 620). So a connector is as strong as that console session, and the
  confirm page is what makes a stale or unexpected account visible before anything is issued. A
  re-authentication window for connectors is a console change, not made here.
  *(Corrected 2026-11-06 on big-body's read; the first draft called the proof fresh authentication.)*
- `signin_states` gains `oauth_request`, and its `mode` gains `connect` and `grant`.
- Self-hosted consent pages are unchanged until lane 8.

## Observability & Evaluation

- **Traces:** the existing rows. A `connect` start writes nothing new. A refused callback writes
  `session.refused` with its reason, as today. An issued code writes `oauth.code_issued` with
  `detail.via = "musterd"`.
- **Eval:** server tests. A hosted consent page shows Sign in with musterd and no `mscr_` field,
  and a self-hosted one keeps the field. A `via=musterd` POST that is cross-site, same-site, `none`
  or missing `Sec-Fetch-Site` is refused with no state and no cookie (found by the automated
  security review of the first commit, 2026-11-06). A `connect` callback answers the confirm page
  naming client, team and member, and issues nothing. Allow issues a code that redeems only with
  the client's verifier (a mismatch is refused). Cancel answers `access_denied` with the state and
  issues nothing. A confirm that is cross-site, has no cookie or another state's, is replayed,
  presents a `connect` state instead of a `grant`, or carries fields trying to swap the request, is
  refused or ignores them. A member who left between sign-in and the click is refused. The POST refuses an unregistered `redirect_uri` before
  writing any state. A `connect` callback issues a code for the bound member and redirects to the
  stored `redirect_uri` with the client's `state`, and the code redeems at `/token` with the
  client's verifier. A `connect` callback creates no `browser_sessions` row. An unbound account is
  refused. A `connect` state works once.

  The real-browser test (`scripts/e2e/hosted-signin.e2e.test.ts`, run in CI) drives it end to end:
  a third site plays the client; Chrome opens the consent page, signs in with musterd through the
  console's cross-site hand-back, sees the confirm page name the member, clicks Allow, and the
  client's redirect receives a code that redeems only with its verifier and acts as that member.
  Cancel reaches the client as `access_denied` with no code. *(Added 2026-11-06 on big-body's
  acceptance read.)*
- **Experiment:** n/a. This is a sign-in path with a closed test set, and the falsifier is the
  browser run.
