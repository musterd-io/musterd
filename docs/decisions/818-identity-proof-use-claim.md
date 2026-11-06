# 818 — Identity proofs carry `use: "identity"`; the email becomes optional

- Status: accepted
- Date: 2026-11-06
- Lane: `01M6RZ8K12GE19462YH3H1BMRQ` (goal `unified-sign-in`)
- Amends: [ADR 698](698-console-identity-statement.md) Decision 1–2
- Relates to: [ADR 722](722-hosted-live-browser-session.md) (the hosted `/live` sign-in that
  consumes the statement), [ADR 620](620-console-sign-in.md) (console sign-in methods),
  [ADR 685](685-console-kms-signs-over-rest.md) (the admin token, signed by the same key)
- Spec: [`2026-11-06-unified-sign-in-design.md`](../superpowers/specs/2026-11-06-unified-sign-in-design.md) §4

## Context

ADR 698 made the console's identity statement an ES256 JWS with `sub`, `email`, `aud`, `jti` and
`exp`, and made the team server's identity path refuse a statement without `email`. The email has
one job there: it is the only claim that tells a statement from a §4.3 admin token, which the same
console key signs. Nothing on the team server reads it — not the callback, not the binding, not
audit.

The console keeps an email only when a provider verified one (ADR 620 §3): Google's
`email_verified` email, the address of an email-link sign-in. A GitHub sign-in asks for no scope
and stores `email: null` (`console/src/providers.ts`). So a person whose musterd account is a
GitHub account — revive's owner among them — can never be issued a statement, and can never sign
in to a hosted `/live`.

## Problem

Keep a statement and an admin token impossible to confuse, without requiring a piece of personal
data that a common sign-in method does not give us, and without asking GitHub for more.

## Decision

1. **A statement carries `use: "identity"`.** It is the marker that makes a console JWS an identity
   statement. `verifyIdentityStatement` refuses a token whose `use` is not `"identity"` as
   `malformed`.
2. **`email` becomes optional.** The console includes it only when it holds a provider-verified
   one; the team server returns it as `email: string | null` and still does not read it.
3. **The admin verifier refuses a statement.** `verifyConsoleToken` refuses `use: "identity"` as
   `malformed`. An admin token carries no `use`. The claims schema admits only `"identity"` as a
   `use` value, so any other value is `malformed` on both paths.
4. Everything else in ADR 698 stands: ES256, ≤ 60 s, one audience, one `jti` redeemed once in the
   shared replay table, no team, member or role claim.

Considered and declined:

- **Ask GitHub for `user:email`** and store the primary verified address. More personal data held
  for a check that never reads it; PRIVACY.md and the consent copy would grow.
- **Refuse emailless accounts** until another fix lands. It locks out the common case.
- **A separate signing key per kind.** It also separates the kinds, but doubles the KMS keys and
  the JWKS rotation work for no gain over a claim the verifiers already parse.

## Consequences

- A GitHub-only musterd account can be issued a statement, and so can sign in to a hosted `/live`
  (the console `/handback` lands in the same lane).
- No new personal data is collected; a statement now sometimes carries less.
- Nothing ever issued a statement before this change (the verifier shipped first, ADR 698 §4), so
  no statement in the wild lacks `use`; there is no compatibility window.
- Admin tokens are unchanged on the wire; the admin path gains one refusal.

## Observability & Evaluation

- **Traces:** n/a — no new trace event; refusals reuse `ConsoleTokenError` reasons, and the
  callback's existing `session.refused` audit row with reason `statement` records a refused
  statement. Nothing about the email or account is written.
- **Eval:** server tests pin it: a `use: "identity"` statement with no email verifies to
  `email: null`; one with an email returns it; a token without `use` is refused as an identity
  statement even with an email; the admin verifier refuses a statement and still accepts a token
  with no `use`; the hosted callback admits an emailless statement and refuses an admin token
  presented as one. Console tests pin that the signer sets `use` and omits a null email.
- **Experiment:** n/a — a wire-format change with a closed test set; the end-to-end check is the
  real-browser hosted sign-in test of lane `01M6S2TXHV`.
