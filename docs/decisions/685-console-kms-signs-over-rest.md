# 685 — The console signs tokens by asking Cloud KMS, over REST

- Status: accepted
- Date: 2026-10-20
- Lane: `01M3Z43V58G43KTAH893VQCTJH`
- Deciders: schmidt; nick approved the GCP project that holds the key
- Relates to: spec §4.3, spec §10, [ADR 615](615-console-skeleton.md), hard rule 6

## Context

Spec §4.3: the console signs an ES256 compact JWS, 60 seconds, one audience, one `jti`. The team
server verifies it with `node:crypto` and redeems the `jti` by inserting `console_token_jti`. Spec
§10 names "the KMS SDK for the console" as a dependency that needs an ADR. The console already
calls Cloudflare Email Service with `fetch` (`packages/console/src/email.ts`). No JOSE library: the
verifier refuses one (hard rule 6).

The key is Cloud KMS in GCP project `musterd-kms` (332443408096): key ring `console`, location
`global`, key `console-signing`, version 1, algorithm `EC_SIGN_P256_SHA256`. The signer is
`console-signer@musterd-kms.iam.gserviceaccount.com` with `roles/cloudkms.signerVerifier` on that
key. The credential file is mode 600 on the operator's machine. The private key is not in git.

## Problem

Which client asks Cloud KMS to sign, and what that adds to the install.

## Decision

The console calls Cloud KMS with `fetch` over HTTPS. Weighed:

- **`@google-cloud/kms`.** It pulls gRPC and protobuf into the console install for two HTTPS calls.
  Hard rule 6 refuses that weight when the REST calls carry the same two operations.
- **A JOSE library.** The team server already verifies ES256 with `node:crypto` and refuses a
  second JWT stack.

The client exchanges a service-account JWT (RS256, scope
`https://www.googleapis.com/auth/cloudkms`) at `https://oauth2.googleapis.com/token` for a bearer,
then `GET …/publicKey` and `POST …:asymmetricSign`. `sign` sends the SHA-256 of the signing input
as `digest.sha256` (standard base64) so Cloud KMS does not hash twice, and converts the DER
signature to ieee-p1363. `kid` is the first 16 characters of the base64url SHA-256 of the SPKI PEM,
not the key version. The public JWK is cached for the process. The bearer is refreshed 60 seconds
before it expires. Each call uses `AbortSignal.timeout(5_000)` and `redirect: 'error'`. The
cryptoKeyVersion name matches
`^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/[a-z0-9-]{1,30}/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}/cryptoKeyVersions/[1-9][0-9]{0,5}$`
before it is joined to `https://cloudkms.googleapis.com/v1/`.

`MUSTERD_CONSOLE_KMS_KEY` and `MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE` are both set or both unset.
Unset: the JWKS is `{keys:[]}` and `POST /tokens` is 404. There is no dev key. Both set, and the
public key cannot be read at boot: the process exits. The credential file must be mode 600
(`mode & 0o077 === 0`). An error names the variable, or `console KMS <label> failed` /
`console KMS <label> failed (HTTP n)`. It never includes the secret, the assertion, the response
body, or the path.

`POST /tokens` is form-urlencoded, fields `aud` and `csrf`, cookie `__Host-session`. The existing
POST path requires Origin equal to the pinned issuer. Then: no signer → 404; no session → 401
`signed_out`; bad CSRF → 403 `forbidden`; session older than 15 minutes → 403 `stale`; audience
not 1–200 characters, or containing whitespace or a control character → 400 `bad_audience`; more
than 30 a minute for that account → 429 with `retry-after: 60`; else 200 `{token}`. The audit row
is `token.issue` with `{aud, jti}` only.

The token does not authorize import, export, or delete. Those routes (lanes `01M3Z42W1J` and
`01M3Z42YFH`) read this token's `sub` as the account id and also check that the account is bound
to an owner. Team servers keep the JWKS URL they already have. The staging issuer stays until an
operator points them at a console that publishes this key. Rotation is a new key version and a
process restart. In-flight 60-second tokens can fail across that restart. A team server refetches
an unknown `kid` at most every 30 seconds and trusts a JWKS set for at most 10 minutes. An offline
root that certifies the KMS key is spec §11. This record does not add one.

## Consequences

- No new runtime dependency. `@musterd/console` does not gain `@google-cloud/kms`.
- A credential file other users can read is refused at boot. The error names
  `MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE` and not the path.
- Cutover is an ops change recorded in `docs/guides/cloud-ops.md`, not a code default.
  `app.musterd.io` still serves an empty JWKS. Staging team servers still name the staging issuer.
- _(2026-10-20.)_ A live `asymmetricSign` on version 1 of `console-signing` produced a signature
  that `node:crypto` verifies with the JWK `getPublicKey` returned (`kms.test.ts`, "signs with the
  configured key and the published JWK verifies it", 633 ms). CI skips that test.

## Observability & Evaluation

- **Traces:** a `token.issue` audit row `{aud, jti}`; the request log's route label `tokens`; a
  KMS failure line `console KMS <label> failed`, with the HTTP status when there is one. Log
  redaction drops a field whose name matches `token` or `key`, so the line does not carry the
  token.
- **Eval:** `packages/server/src/cloud/consoleToken.console.test.ts` — expiry, audience mismatch,
  `jti` replay across two servers, and `alg` confusion (`none` and HS256) against a booted
  console. The dataset is those four refusals plus the one accepted `POST /teams`. Baseline: the
  test-issuer suite in `consoleToken.test.ts` and `cloudMode.test.ts`.
- **Experiment:** `packages/console/src/kms.test.ts` signs with the real key when both environment
  variables are set, and skips in CI. Falsifier: a signature the console publishes that
  `verifyConsoleToken` rejects, or a Cloud KMS signature `node:crypto` accepts without the
  DER-to-ieee-p1363 conversion.
