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
3. **The callback finishes the authorization, not a browser session.** For a `connect` record,
   `POST /live/signin/callback` makes every ADR 722 §2 check, finds the member the account is bound
   to (`memberByAccount`, humans only), issues the OAuth code for that member exactly as the consent
   POST does, and answers `302` to the client's `redirect_uri` with `code` and `state`. It creates no
   browser session and reads none: a `/live` cookie never authorizes a client, so a 14-day browser
   session cannot become a 30-day connector chain without a fresh proof.
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
- Each connector authorization is its own fresh identity proof (60 s, single use, ADR 818), so its
  strength is the console sign-in's, never a stale cookie's.
- `signin_states` gains `oauth_request`, and its `mode` gains `connect`.
- Self-hosted consent pages are unchanged until lane 8.

## Observability & Evaluation

- **Traces:** the existing rows. A `connect` start writes nothing new. A refused callback writes
  `session.refused` with its reason, as today. An issued code writes `oauth.code_issued` with
  `detail.via = "musterd"`.
- **Eval:** server tests. A hosted consent page shows Sign in with musterd and no `mscr_` field,
  and a self-hosted one keeps the field. A `via=musterd` POST that is cross-site, same-site, `none`
  or missing `Sec-Fetch-Site` is refused with no state and no cookie (found by the automated
  security review of the first commit, 2026-11-06). The POST refuses an unregistered `redirect_uri` before
  writing any state. A `connect` callback issues a code for the bound member and redirects to the
  stored `redirect_uri` with the client's `state`, and the code redeems at `/token` with the
  client's verifier. A `connect` callback creates no `browser_sessions` row. An unbound account is
  refused. A `connect` state works once.

  Follows-up: 01M6S7DKXH0R7TN2QJV1CQQR7V (the real-browser test gains a connect run: a fake client
  redirect on its own host, the code exchanged with the verifier)
- **Experiment:** n/a. This is a sign-in path with a closed test set, and the falsifier is the
  browser run.
