# 821 — API keys: a member's scoped, expiring key for scripts and CI

- Status: proposed
- Date: 2026-11-06
- Lane: `01M6S2W7204R0DXJAZ33M07SGN` (goal `unified-sign-in`, lane 7)
- Builds on: [ADR 580](580-human-credentials-require-human-admin.md)
  (the human credential `mscr_`), [ADR 446](446-remote-mcp-https-oauth.md) (`msat_` as a bearer),
  [ADR 662](662-one-machine-per-hosted-seat.md) (high-authority acts need a device signature)
- Spec: [`2026-11-06-unified-sign-in-design.md`](../superpowers/specs/2026-11-06-unified-sign-in-design.md)
  §8, §11.1, §12

## Context

A script or a CI job that acts on a team today holds a person's permanent `mscr_`, the same
credential their terminal uses. It never expires, cannot be told apart from the person in the
record, carries every capability the person has (admin included), and the only way to stop it is to
rotate the credential, which breaks every terminal that person uses. On a hosted team a member
admitted through the console has no `mscr_` at all, so they have no way to give a script access.

big-body's security read of the sign-in design (§12) set the bounds: no general admin key; anything
that needs more is a separately scoped, expiring, audited grant; and nothing bypasses the
standing-key checks.

## Problem

Give a member a key a script can hold that is narrower than the member, expires, is listed, and can
be revoked on its own, without a new way around any check that guards admin or high-authority acts.

## Decision

1. **A new credential, `msak_`** (`TOKEN_PREFIXES.api_key`): `msak_` plus 32 random bytes,
   base64url. Stored only as its sha256, shown once at creation (hard rule 5). One format on every
   surface that takes a bearer: the HTTP API, and the CLI and MCP adapter through it.
2. **Two scopes, nothing wider:**
   - **`read`**: authenticates `GET` (and `HEAD`) requests only. Every other method, the MCP
     endpoint and the WebSocket claim refuse it as `forbidden`.
   - **`act`** ("act as me"): authenticates as the member, with the member's capabilities minus
     `is_admin`, clamped at the read the way a ceiling is ([ADR 621](621-talk-only-guests.md) §4). No route that needs an
     admin accepts it.

   Neither can produce an ADR 662 signature. A key is not a device key, so every act that needs
   one still needs the member's passkey or phone.
3. **Expiry is required.** 30, 90 (the default) or 365 days, chosen at creation. Past it the key is
   refused as `unauthorized`. It is listed as expired until revoked.
4. **Minted by the member, as themselves.** `POST /teams/:slug/members/:name/api-keys` creates a key
   for the caller only (`name` must be the caller), authenticated by a human credential, a browser
   session's `msat_`, or an MCP client's `msat_`. Never by another API key, so a key cannot mint a
   key. Each member may hold at most 20 live keys.
5. **Listed and revoked by the member or an admin.** `GET …/api-keys` lists name, scope, created,
   expires and last used, never the key or its hash. `DELETE …/api-keys/:id` revokes at once. A
   member who leaves takes their keys with them: a key whose member is gone authenticates nothing.
6. **Recorded.** `api_key.created` and `api_key.revoked` audit rows name the key's id and name,
   never its value. An act sent with a key is stamped `meta.via = "api_key"` beside the member, so
   the record tells "nick did this" from "nick's deploy key did this". `last_used_at` is written at
   most once a minute per key.
7. **Bot seats are not in this ADR.** A key that acts as an agent seat would sit beside the agent
   session-lease rules ([ADR 337](337-agent-http-session-authority.md)), so it gets its own design and lane. Until then the UI's bot hint is
   held back.

## Consequences

- A member can hand a script access that is narrower than they are, ends on a date, and stops alone
  when revoked. Rotating their credential is no longer the only off switch.
- One table, `api_keys`, team-owned, on a portable ladder step.
- `TOKEN_PREFIXES` gains `api_key: 'msak_'`; the credential scrubbers learn the prefix in the same
  change, so a key never reaches a log.
- The `/live` "Where you're signed in" list (lane 6) gains a row per key, with Revoke.

## Observability & Evaluation

- **Traces:** n/a. No new trace event. The audit rows in §6 and the `meta.via` stamp are the record.
- **Eval:** server tests. A created key is shown once and stored only as a hash. A `read` key
  passes a GET and is refused on POST, MCP and WS. An `act` key sends as the member and is refused
  on an admin route. An expired, revoked or departed member's key is refused. A key cannot create a
  key. Another member can neither list nor revoke someone's keys; an admin can. `last_used_at` moves
  at most once a minute. The scrubber redacts `msak_`.
- **Experiment:** n/a. A credential with a closed test set.
