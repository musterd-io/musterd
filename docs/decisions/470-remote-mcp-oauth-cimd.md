# 470 — Remote MCP OAuth with generic CIMD and retained DCR

- Status: proposed
- Date: 2026-09-28
- Lane: `01M3AM3GJ2WCMW685AC9NYBZPT`
- Relates to: [ADR 446](446-remote-mcp-https-oauth.md), [ADR 457](457-oauth-resource-indicator.md), [ADR 458](458-dcr-tolerates-rfc7591-bodies.md)

## Context

The MCP authorization specification (2026-07-28) recommends Client ID Metadata Documents (CIMD)
for clients and leaves Dynamic Client Registration (DCR) as an optional compatibility path. The
musterd remote OAuth server currently accepts registered DCR clients only. That is a blocker for
remote MCP clients that publish a stable client identity and expect the authorization server to
read it. Nick approved the generic CIMD design on 2026-09-26. A standards review on 2026-09-28
found additional requirements in the current IETF CIMD draft and in the published ChatGPT metadata
shape; this ADR records those refinements before protocol or server implementation begins.

The ChatGPT document advertises `none` in `token_endpoint_auth_methods_supported` while its
singular legacy preference is `private_key_jwt`. The server can support it as a public client using
`none`, without implementing signed client assertions or fetching `jwks_uri`. The published
document is small enough for the 5 KiB read ceiling.

Sources: [MCP authorization specification, 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx),
[IETF CIMD draft 02](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-02),
[OpenAI MCP authentication guide](https://developers.openai.com/plugins/build/auth).

## Problem

Adding a protocol schema and an outbound metadata fetch expands the authorization boundary. The
server must read a public client's redirect URIs safely without turning authorization into an
SSRF proxy, displaying an unverifiable name without the client ID's origin, retaining more remote
metadata than needed, or making token exchange depend on remote availability. Protocol schemas are
shared contracts and require a numbered ADR before they change.

## Decision

1. Add `OAuthClientMetadataSchema` and `OAuthClientMetadata` to `@musterd/protocol`. Require an
   exact `client_id`, a non-empty `client_name` of at most 200 characters, non-empty `redirect_uris`,
   `authorization_code` and `refresh_token` grants, the `code` response type, and support for
   `token_endpoint_auth_method: none` either as the singular method or in
   `token_endpoint_auth_methods_supported`. Strip unknown fields. Add
   `client_id_metadata_document_supported: true` to authorization-server metadata. Retain DCR's
   `registration_endpoint`; do not change the Envelope version.
2. Resolve an existing DCR record first. Only a miss may use CIMD, and only on authorization GET or
   POST. Require a URL no longer than 2,048 characters, using HTTPS on port 443, with no userinfo,
   query, or fragment, a non-empty path, and no `.` or `..` path segments (including percent-encoded
   forms). Require the fetched document's `client_id` to equal the exact requested URL. Apply the
   existing redirect URI safety policy to every listed URI and exact-match the requested URI.
3. Fetch only after the existing per-IP authorization rate limit. Resolve the host once; reject the
   URL if any DNS answer is not globally routable unicast, including IPv4-mapped IPv6 and special-
   use ranges. Pin the HTTPS connection to a validated address while retaining the original host
   for TLS verification, SNI, and `Host`. Do not follow redirects. Require HTTP 200 and JSON, stop
   after 3 seconds, and read no more than 5 KiB. Map fetch and validation failures to the generic,
   non-redirecting OAuth client error.
4. Cache only schema-valid metadata in a process-local 256-entry LRU keyed by the exact URL. Coalesce
   same-URL misses, cap unique in-flight fetches at 16, and never cache errors. Cache for no longer
   than 5 minutes and honor response freshness: `no-store` and `no-cache` responses are not reused;
   `max-age`, `Age`, and `Expires` can shorten the local lifetime. With no explicit freshness, the
   local maximum is 5 minutes.
5. Show the escaped `client_name` and CIMD `client_id` hostname together on the consent page. Do not
   fetch remote logos or other presentation assets. DCR consent presentation stays as it is.
6. Keep the token endpoint network-free. It may pass a syntactically valid CIMD URL past a local DCR
   miss, but code redemption and refresh rotation must match the exact `client_id` already bound in
   the grant records. Add a team-scoped `oauth_client_bindings` table keyed by `(team_id, client_id)`
   with a `dcr` or `cimd` source; authorization codes and tokens reference that composite key. DCR
   registration creates a DCR binding, and a CIMD binding is created only when authorization issues
   a code. The exact URL remains in the existing code/token records and binding row for relational
   integrity; fetched metadata fields and documents are not persisted to the database.
7. Keep the existing OAuth audit actions, but omit CIMD URLs and fields derived from fetched
   metadata from audit targets/details, logs, and traces. Existing audit fields that would copy a
   CIMD `client_id` are null for that client. No new trace event is added.
8. Update the normative OAuth contract in `SPEC.md` and the current server/MCP architecture docs in
   the same implementation change. No new runtime dependency is introduced.

## Consequences

- Clients with published CIMD documents can use the generic authorization path; DCR clients keep
  working and the server continues to advertise its registration endpoint.
- A CIMD host can be temporarily unavailable without affecting an already-issued code or refresh
  token. A document with no-store/no-cache must be fetched again on the next authorization request.
- The 5 KiB ceiling and URL path requirements reject some otherwise reachable documents by design.
  The generic OAuth failure does not disclose whether DNS, TLS, size, parsing, or metadata checks
  failed.
- CIMD metadata is not a grant. The exact client ID is stored with codes, token chains, and the
  team-scoped binding row, so token exchange can verify it locally without retaining the fetched
  document or trusting a new client-provided URL at redemption time. A published client ID may be
  bound independently by more than one Team.
- The consent hostname gives the person a stable origin clue; it is not proof that the client name
  is trustworthy. Remote logos and `private_key_jwt` remain out of scope.

## Observability & Evaluation

- **Traces:** No new trace events. Audit actions remain, with CIMD URL and fetched metadata fields
  omitted. Resolver failures return the generic OAuth client error; they do not retain response
  bodies or transport exception text.
- **Eval:** OAuth HTTP cases cover retained DCR and Claude/ChatGPT-shaped CIMD metadata, including
  URL policy, DNS pinning, size, cache directives, redirect validation, consent display, document
  mismatch, and code/refresh binding. Success means both CIMD identities authorize, DCR remains
  available, and code/refresh exchange performs no metadata fetch.
- **Experiment:** Exercise Claude's published identity and ChatGPT Developer Mode on an eligible
  account; no production A/B treatment.
