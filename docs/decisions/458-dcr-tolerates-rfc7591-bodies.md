# 458 — Client registration tolerates real RFC 7591 bodies

- Status: accepted
- Date: 2026-09-26
- Lane: `01M3AKNPS1GCQHYVXVHQER0FNC`
- Relates to: [ADR 446](446-remote-mcp-https-oauth.md), [ADR 457](457-oauth-resource-indicator.md)

## Context

Rehearsal A, third attempt of the day (2026-09-26, after #1752 and #1754): the Claude iOS app
reaches dynamic client registration and reports "Couldn't register with demo's sign-in service"
(reference `ofid_7224351c57a991a1`). Registration is the first request the app makes with a
body of its own, so this was the first time its real RFC 7591 body met the daemon.

`OAuthClientRegistrationRequestSchema` was `.strict()` with an enumerated allowlist of members,
and `token_endpoint_auth_method` was the enum `none | client_secret_basic`, with the handler
refusing anything but `none`. Probing the rehearsal daemon from outside with the two plausible
real-client shapes: extra RFC 7591 members (`contacts`, `software_id`, `tos_uri`, `policy_uri`)
→ 400 "Unrecognized key(s)"; `token_endpoint_auth_method: client_secret_post` → 400 "Invalid enum
value". Either refusal locks a real app out at step one, and the failure body was the musterd
error envelope, which no OAuth client parses.

RFC 7591 §2: "The authorization server MUST ignore any client metadata sent by the client that
it does not understand." §3.2.1: the server MAY replace requested metadata with its own values,
and the client MUST use the values in the response. §3.2.2: a failed registration is
`{ "error": <code>, "error_description": ... }` with `invalid_redirect_uri` or
`invalid_client_metadata`.

## Problem

The schema treated the registration body as ours to fail closed on, when the RFC assigns that
body to the client and tells the server to ignore what it does not know. A hard rule says
protocol schemas change only with an ADR.

## Decision

1. `OAuthClientRegistrationRequestSchema` drops `.strict()`: unknown members are stripped.
   Required members (`redirect_uris`, `client_name`) and the redirect-URI rules are unchanged.
2. `token_endpoint_auth_method` accepts any string. The daemon still issues public clients only:
   the response says `token_endpoint_auth_method: "none"` and carries no secret, whatever was
   asked. Confidential clients remain out of scope (ADR 446 increment 1).
3. Registration failures use the RFC 7591 §3.2.2 shape: `invalid_redirect_uri` for a refused
   redirect URI, `invalid_client_metadata` for anything else.

## Consequences

- A standards-shaped body from any app registers. The security posture is unchanged: redirect
  URIs are still validated server-side, the rate limit still applies, and no secret is issued.
- The 2026-09-25 tolerance list in the schema (grant_types/response_types) is subsumed; those
  members are still parsed so the code can read them.
- Which of the two refusals the phone hit is not recorded here: the daemon log line for that
  request is the falsifier, and the wiki page for the run should carry it once read.

## Observability & Evaluation

- Traces: the `oauth.client_registered` audit row on success; a refusal is a 400 with an RFC
  7591 error code in the daemon log.
- Eval: `oauth-http.test.ts` "ignores unknown RFC 7591 members" and the confidential-request
  case (201 with `none`), plus `oauth.test.ts` (ADR 458). Baseline: the Claude-shaped body test
  from 2026-09-25, which passed before and after.
- Experiment: the Claude iOS app reaches the sign-in page through the tunnel after this lands;
  Rehearsal A's wiki page records it.
