# 698 — Console identity statement and `account_id` binding

- Status: accepted
- Date: 2026-10-21
- Lane: `01M3Z44K46C3RBHJT3D2SS7EWY`
- Relates to: [ADR 470](470-remote-mcp-oauth-cimd.md) (status settled in this change), cloud design spec §4.2/§4.3/§4.4 (`docs/superpowers/specs/2026-09-29-musterd-cloud-design.md`)

## Context

Team sign-in on a hosted team delegates authentication to the console (spec §4.4): the console
authenticates the person and returns a signed **identity statement** — *account A, verified
email E*, and nothing about teams. The team server then looks up which of its own members is
bound to account A (§4.2: membership lives on the team server; the console only proves
identity), or binds one through an invite, and mints its own tokens as today.

Two pieces of that contract do not exist yet:

1. **No statement verifier.** The console→team-server admin token (spec §4.3, Cloud 1C) already
   has one: `verifyConsoleToken` in `packages/server/src/cloud/consoleToken.ts` — ES256 against
   the console JWKS, `aud` = the asking server, ≤60 s life, single-use `jti` redeemed
   atomically in `console_token_jti` (`redeemJti`). The identity statement carries the same
   properties (§4.4), so it must pass the same refusals, plus prove a verified email. The lane
   brief (dolly's 2026-10-15 audit) directs: extend that verifier, never write a second one.
2. **No binding column.** `members` has no `account_id`. §4.2 fixes the shape: a column on the
   team's member row, set the first time an account signs in through an invite or a claim;
   export carries it and import restores it.

Both are protocol-visible (the statement's claim shape crosses the wire; `account_id` joins the
member record), so hard rule 1 requires this ADR before schemas change.

A precondition from the lane brief: ADR 470 (generic CIMD) still reads `proposed`, but its
Decision is shipped — `OAuthClientMetadataSchema` in `@musterd/protocol`, the 467-line resolver
in `packages/server/src/transport/cimd.ts` wired into `transport/oauth.ts`, the
`oauth_client_bindings` table (migration v80), and tests on all three sides. This change settles
470's status line to `accepted` with a dated note; its Decision is untouched.

## Problem

Without a statement verifier, a hosted team server cannot accept the console's proof of who is
signing in; without `account_id`, it cannot remember the binding §4.2 requires, so every
sign-in would re-derive membership from the console — the split §4.2 rejects. Writing a second
verifier would duplicate the refusal order (shape → alg → signature → claims) and the JWKS
cache rules, and the two copies would drift on exactly the checks that keep an unsigned or
replayed statement from being believed.

## Decision

1. **The identity statement is a console-signed ES256 compact JWS** with claims `sub` (the
   account id), `email` (the verified email), `aud` (the one asking team server), `jti`, and
   `exp` — the §4.3 properties: at most 60 s of life, audience-pinned, single-use. It asserts
   identity only; it carries no team, member, or role claim (§4.4).
2. **One verifier, extended.** `consoleToken.ts` gains `verifyIdentityStatement`, built on the
   same segment/JWKS/signature path as `verifyConsoleToken`. The claims schema gains an
   optional `email`; the identity path requires it (absent ⇒ `malformed`). Refusals reuse the
   existing vocabulary (`malformed`, `bad_alg`, `unknown_key`, `bad_signature`, `expired`,
   `lifetime`, `wrong_audience`, `replayed`); redemption reuses `redeemJti` unchanged, so a
   statement and an admin token can never each be spent once.
3. **`members.account_id`** — one nullable TEXT column (portable ladder v126), exposed on the protocol
   `Member` as `account_id: z.string().min(1).nullish()`. Binding is **write-once**: the first
   sign-in through an invite or claim sets it (`bindMemberAccount` in the members store);
   binding an already-bound member to a *different* account is refused, and re-binding the
   *same* account is a no-op. Lookup is `memberByAccount(team, account_id)`. Unbinding is not
   in this change (Follows-up below).
4. **Scope of wiring.** This change lands the verifier, the column, the store binding, and
   their tests. Consuming the statement in the hosted `/live` sign-in flow (the console
   redirect and the revocable browser session of §4.4) is Cloud 4's lane
   (`01M3Z458B261P8DW8VX4A7XCHG`, miley), which already holds `transport/oauth.ts` under
   ADR 691; it consumes `verifyIdentityStatement` + `bindMemberAccount` when it wires the
   flow. No OAuth route changes here.
5. **ADR 470 settles to `accepted`** in this change (status line + dated Consequences note
   only), recording that its Decision is implemented and tested on trunk.

## Consequences

- A hosted team server can verify who the console authenticated and remember the binding
  locally; the console still learns nothing about membership, and one leaked statement works
  once, for one server, for 60 s (§4.4's weighing, unchanged).
- The statement and the admin token share one refusal order, one JWKS cache, and one replay
  table — a fix to any of them fixes both.
- Members on self-hosted teams simply never get an `account_id`; the column and protocol field
  are nullish end to end, so no surface has to branch on hosted-ness to render a roster.
- Write-once binding means a person who changes console accounts cannot silently rebind a
  member; an admin-mediated rebind is future work, named below, not improvised here.

Follows-up: `01M3Z458B261P8DW8VX4A7XCHG` (Cloud 4 consumes the verifier + binding in the hosted sign-in flow)
Follows-up: deferred — admin-mediated `account_id` rebind/unbind, when a real account-change case arrives (2026-10-21)

## Observability & Evaluation

- **Traces:** Verification failures return the existing `ConsoleTokenError` reasons; no new
  trace event, and neither the email nor the account id is written to audit details or logs
  (hard rule 5's spirit: identifiers, not secrets, but nothing new to leak).
- **Eval:** Server tests pin the contract — the four refusals the brief names (bad signature,
  wrong audience, expired/lifetime, replayed `jti`) against the identity statement, a missing
  `email` refused as `malformed`, a well-formed statement verifying to `{accountId, email}`,
  and the store binding: first bind sets the column, same-account rebind is a no-op,
  different-account rebind is refused, lookup finds the bound member. Protocol test: `Member`
  parses with and without `account_id`.
- **Experiment:** n/a — a verification and storage primitive with no user-facing behaviour of
  its own; the falsifier is the test set above, exercised again end-to-end when Cloud 4 wires
  the hosted sign-in flow.
