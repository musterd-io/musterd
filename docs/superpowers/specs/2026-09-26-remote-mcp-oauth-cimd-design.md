# Remote MCP OAuth: generic CIMD with DCR fallback

- Status: approved; standards alignment updated 2026-09-28
- Date: 2026-09-26
- Lane: `01M3AM3GJ2WCMW685AC9NYBZPT`
- Goal: demo
- Architecture approved by Nick on 2026-09-26; standards alignment refinements are recorded in ADR 470.

## Goal

Let supported remote MCP clients authenticate through their published client identity documents,
while keeping Dynamic Client Registration (DCR) available for clients that need it. A Member should
be able to sign into the same remote MCP endpoint from Claude using Claude's published identity and
from ChatGPT Developer Mode on an eligible laptop account, without pasting a token URL.

Increment 3 keeps the existing code grant, S256 PKCE, resource indicator, consent page, and rotating
refresh-token flow. The token endpoint remains network-free.

## Current surface

The server serves authorization-server metadata, protected-resource metadata, DCR, authorization,
token, and revocation routes under `/oauth/:team`. DCR records and their exact redirect URIs are held
in the database. Both authorization GET and POST call `getClientOrOAuth`, which only looks up a DCR
record. The token route checks a DCR record before redeeming a code or rotating a refresh token.

`@musterd/protocol` defines the DCR request and authorization-server metadata schemas in
`packages/protocol/src/oauth.ts`. The metadata currently advertises `registration_endpoint`, S256,
and the public `none` token authentication method. The server does not currently support Client ID
Metadata Documents (CIMD).

## Proposed client resolution

One resolver will serve both authorization GET and POST:

1. Look up `client_id` in the existing DCR table. A hit returns the stored client name and redirect
   list, preserving current behavior.
2. On a miss, treat `client_id` as a CIMD URL only if it passes the URL policy below. Fetch and parse
   the metadata document, then return its validated client name and redirect list.
3. If neither path yields a valid public client, return the existing OAuth client error shape. Do not
   redirect to a client-supplied URI on an error.

Both authorization GET and POST resolve the client and exact-match `redirect_uri` against the
resolved list. Each listed redirect URI must also pass the server's existing `assertRedirectUri`
policy. The consent page displays the escaped `client_name` and, for CIMD clients, the
`client_id` hostname. It does not load a remote logo or other client-supplied presentation asset.

The authorization-server metadata schema and response gain
`client_id_metadata_document_supported: true`. The existing `registration_endpoint` remains present,
so clients can continue to choose DCR. The metadata continues to advertise S256 and
`token_endpoint_auth_methods_supported: ['none']`.

## CIMD document contract

The protocol package will add a Zod schema for the client metadata fields the resolver uses:

- `client_id`: required string, exactly equal to the requested metadata-document URL;
- `client_name`: required non-empty string, at most 200 characters;
- `redirect_uris`: required non-empty array of non-empty strings;
- `grant_types`: must include `authorization_code` and `refresh_token`;
- `response_types`: must include `code`;
- `token_endpoint_auth_method` and `token_endpoint_auth_methods_supported`: the document must
  support `none` either as its single method or in its supported-method list.

The metadata parser strips fields the resolver does not use. This permits standard fields such as
ChatGPT's `jwks_uri` and its advertised `private_key_jwt` preference to be present without giving
them behavior. The server will use `none`, the method it supports and the published ChatGPT
metadata also lists. The server will not fetch a `jwks_uri` or implement `private_key_jwt` in this
increment.

The document URL is limited to 2,048 characters, HTTPS on port 443, and a URL with no userinfo,
query, or fragment. It must have a non-empty path with no `.` or `..` path segments, including
percent-encoded forms. These URL limits avoid embedded credentials and unneeded network
destinations; they cover the currently published Claude and ChatGPT document URLs. Redirect URIs
remain governed by the existing policy and are compared byte-for-byte with the requested URI.

## Metadata fetch boundary

Only a cache miss on the authorization GET/POST path can make an outbound request. The resolver will
use Node built-in DNS and HTTPS APIs; no new runtime dependency is proposed. It will:

- resolve the document host once, reject the destination unless every returned address is globally
  routable unicast (including IPv4-mapped IPv6 checks), and pin the HTTPS connection to a validated
  result so DNS cannot change between validation and connection;
- preserve the document hostname for TLS SNI, certificate verification, and the HTTP `Host` header;
- refuse redirects and require a JSON content type;
- stop the request after 3 seconds and stop reading after 5 KiB;
- validate the response with the new Zod schema before caching it;
- cache only valid metadata in a 256-entry LRU for at most 5 minutes, keyed by the exact document URL;
  honor response freshness directives up to that ceiling, and do not reuse responses marked
  `no-store` or `no-cache`;
- coalesce concurrent requests for the same URL and cap cache-miss fetches at 16 per server process;
  when that cap is full, return a retryable service error instead of queuing unbounded work;
- return a generic OAuth client error for fetch, TLS, body-size, JSON, schema, or address failures;
  do not place fetched bodies, document URLs, or transport exception details in logs.

The resolver revalidates on a cache miss. A valid cached document may be used within the response's
freshness lifetime, capped at 5 minutes; absent explicit freshness, the local maximum is 5 minutes.
Authorization codes still expire under the existing 90-second bound and bind the exact client ID,
redirect URI, and PKCE challenge.

## Token endpoint stays network-free

The token route will not resolve or fetch CIMD metadata. It will keep DCR client lookup local. A
well-formed HTTPS CIMD identifier may pass the local DCR-miss check; code redemption or refresh
rotation must then match that exact `client_id` against the already-stored authorization code or
refresh-token chain. The code/token rows reference a team-scoped `oauth_client_bindings` row keyed
by `(team_id, client_id)`; successful CIMD authorization creates that binding with source `cimd`,
without persisting fetched metadata. DCR registration creates a `dcr` binding. Code redemption also
checks the exact redirect URI and S256 verifier. A request with an unrecognized ID and no matching
grant cannot mint or rotate a token.

This preserves the existing token route's synchronous local work and avoids putting client metadata
availability on the access-token or refresh-token path. Token and resource-indicator schemas do not
change.

## Errors, rate limits, and audit

Authorization uses the existing per-IP `authorize` rate limit. Cache misses share that budget. A
failed or unsupported CIMD document produces the same non-redirecting client-error response used for
an unknown DCR client; the client sees no internal DNS or TLS detail. A full fetch cap produces a
generic retryable service error. Successful authorization, token issuance, rotation, and client
registration retain their existing audit actions. The exact CIMD URL remains in existing code/token
records and its team-scoped binding row because redemption must bind it; parsed metadata is held only
in the bounded process-local cache. Audit rows, logs, and traces omit CIMD URLs and fetched metadata
fields. Resolver failures do not retain raw document bodies or transport exception details.

## Acceptance

Automated coverage will verify:

- authorization-server metadata validates against the protocol schema and advertises both CIMD and
  the retained DCR endpoint;
- valid Claude-shaped and ChatGPT-shaped metadata documents resolve, including ChatGPT's plural
  supported-auth-method list when its legacy single method names `private_key_jwt`;
- DCR registration, authorization, code redemption, resource validation, and refresh rotation remain
  unchanged;
- CIMD authorization GET and POST require a valid document and exact registered redirect;
- consent shows the escaped client name and CIMD hostname, and omits remote logos;
- mismatched document IDs, unsupported methods/grants, unsafe destinations, DNS rebinding,
  dot-segment paths, redirects, non-JSON responses, timeouts, cache directives, and bodies over
  5 KiB fail closed or expire from cache as specified;
- the token route completes code and refresh flows without invoking the metadata transport.

End-to-end acceptance uses Claude's published identity and ChatGPT Developer Mode on a Business,
Enterprise, or Edu laptop account. ChatGPT's current product guidance limits write-capable MCP apps
to those tiers; Pro is read/fetch only, and mobile MCP is not an Increment 3 target. Fifty's
Host/Origin gate fix is already merged in #1767, so this lane can exercise Claude's published
identity on top of that behavior. Rehearsal A reports two real joins in 49 and 56 seconds; its
three-phone and `/live` checks remain in that lane
([run record](../../wiki/rehearsal-a-2026-09-26.md)).

## Scope exclusions

- `private_key_jwt`, confidential clients, or fetching any client-supplied `jwks_uri`;
- removal of DCR or a vendor-specific allowlist;
- new MCP tools or a broader adapter surface;
- ChatGPT mobile support;
- implementation of the Host/Origin gate correction already merged in #1767; Rehearsal A's
  three-phone and `/live` checks remain in that lane.

## Protocol and ADR requirements

The metadata boolean and new client-metadata schema change the shared protocol contract. Before
implementation, obtain a number with `pnpm adr:next`, publish a draft PR reserving that number, then
write the ADR before changing `@musterd/protocol`. The ADR and the normative `SPEC.md` update must
land with the implementation. Update `docs/architecture/03-server.md` and
`docs/architecture/05-mcp.md` in the same change where their descriptions of the current surface
change.

## Sources

- [MCP authorization specification (2026-07-28)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx)
- [IETF OAuth Client ID Metadata Document draft 02](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-02)
- [OpenAI MCP authentication guide](https://developers.openai.com/plugins/build/auth)
- [Anthropic remote MCP integration guidance](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)
- [ChatGPT Developer Mode and MCP app availability](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
