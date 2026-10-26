# 743 — OAuth loopback redirects match on any port (RFC 8252 §7.3)

- Status: accepted
- Date: 2026-10-26

## Context

ADR 446 §3 and ADR 470 Decision 2 match a requested `redirect_uri` against the client's registered
URIs exactly. The real-client CIMD acceptance (lane 01M3QQJENE, 2026-10-26) ran three clients
against a live daemon through a tunnel: claude.ai and ChatGPT web each chose CIMD and authorized
with `https` callbacks on their own origin. Codex CLI 0.162 also chose CIMD, with the client ID
`https://chatgpt.com/oauth/codex/<id>/client.json`. Its document lists
`http://127.0.0.1/callback/<id>` and `http://localhost/callback/<id>` — no port — and the CLI
authorizes with `http://127.0.0.1:<ephemeral>/callback/<id>`, the port its listener got.

## Problem

The exact match refuses that request with `400 redirect_uri is not registered for this client`,
before the consent page. No Codex user can connect a musterd remote MCP server. RFC 8252 §7.3 is
explicit: an authorization server MUST allow any port to be specified at request time for loopback
IP redirect URIs, because a native app cannot know its port in advance.

## Decision

1. When the exact match misses, a requested `redirect_uri` matches a registered one if both are
   `http` URLs whose host is the same loopback IP literal (`127.0.0.1` or `[::1]`) and whose path
   and query are identical. The port may differ. A fragment or userinfo on the requested URI never
   matches.
2. `localhost` is not a loopback IP literal and keeps the exact match (RFC 8252 §8.3 calls it NOT
   RECOMMENDED; a name can resolve elsewhere). `https` redirects keep the exact match.
3. This applies to DCR and CIMD clients alike, on both authorization legs (GET and POST), because
   both go through the one `registeredRedirect` check.
4. Nothing changes at the token endpoint: the code stores the exact URI used at authorization, and
   redemption still compares against that, so a code issued for one port cannot be redeemed on
   another.

## Consequences

- Codex CLI (and any native client following RFC 8252) can complete sign-in against a musterd remote
  MCP server.
- The redirect target stays on the user's own machine — the loopback interface — so admitting any
  port does not widen where a code can be delivered off the machine. A different local process on
  another port could receive a code only if the browser is sent there, which PKCE already defends:
  the code is useless without the verifier.
- SPEC §OAuth, `03-server.md` and ADR 470 Decision 2 (dated amendment marker) name the exception.

## Observability & Evaluation

- **Traces:** none added. A refused redirect is still the `400` on the request log line.
- **Eval:** `oauth-http.test.ts` covers a Codex-shaped CIMD document: an ephemeral port on
  `127.0.0.1` and `[::1]` passes, a different path, query, scheme or a `localhost` host is refused,
  and the issued code is refused at the token endpoint on a different port.
- **Experiment:** the acceptance lane re-runs `codex mcp login` against a live daemon through a
  tunnel; success is a completed token exchange and a tool call.
