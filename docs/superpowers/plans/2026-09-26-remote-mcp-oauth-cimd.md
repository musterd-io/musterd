# Remote MCP OAuth: generic CIMD with DCR fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task. Keep all writes, builds, and commits in the claimed `big-body` seat; do not delegate implementation.

**Goal:** Let supported remote MCP clients authorize as public OAuth clients through generic Client ID Metadata Documents (CIMD), while preserving Dynamic Client Registration (DCR) for clients that need it.

**Architecture:** Add the CIMD metadata contract to `@musterd/protocol`, then resolve DCR records first and valid CIMD identifiers second on both authorization legs. A Node built-in DNS/HTTPS resolver validates and pins public destinations, bounds and caches successful metadata, and never runs on the token endpoint. The existing PKCE, resource indicator, consent, token rotation, redirect checks, and DCR behavior remain in force.

**Tech Stack:** TypeScript, Zod, Node.js built-in `node:dns` and `node:https`, Vitest, pnpm. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-26-remote-mcp-oauth-cimd-design.md`

## Global Constraints

- Resolve an existing DCR client before treating an unknown `client_id` as a CIMD URL; retain and advertise the DCR `registration_endpoint`.
- CIMD URLs are at most 2,048 characters, HTTPS on port 443, have a non-empty path with no `.` or `..` segments (including percent-encoded forms), and have no userinfo, query, or fragment.
- Reject a DNS result if any address is not globally routable unicast; pin the validated address while preserving the hostname for TLS SNI and `Host`.
- Do not follow redirects. Require `application/json`, a 3-second timeout, and a 5 KiB response-body limit.
- Cache only valid documents, by exact URL, for at most 5 minutes in a 256-entry LRU; honor response freshness directives up to that ceiling and do not reuse `no-store` or `no-cache` responses; coalesce same-URL misses and cap unique in-flight fetches at 16 per process.
- Run authorization metadata resolution only after the existing per-IP `authorize` rate-limit check.
- Do not fetch or resolve metadata on the token endpoint. A CIMD-shaped identifier may pass its local DCR-miss check only; grants must still match that exact identifier.
- Require `authorization_code` and `refresh_token`, response type `code`, and support for token authentication method `none`; strip metadata fields the resolver does not use.
- Require the document’s `client_id` to equal the exact URL requested by the authorization request.
- Preserve exact redirect URI matching and the existing `assertRedirectUri` policy. Never redirect after an unknown or invalid client.
- Return generic OAuth failures for fetch, DNS, TLS, size, content-type, JSON, or schema errors. Do not log a metadata URL, fetched body, or transport exception detail.
- Do not implement `private_key_jwt`, fetch `jwks_uri`, add a vendor allowlist, or change the MCP adapter code.
- This changes OAuth HTTP metadata only; it does not change Envelopes or handshakes, so keep `PROTOCOL_VERSION` at `musterd/0.3`.
- Shared OAuth boundaries are confirmed: Ghost has no remaining edits planned in the OAuth files; Stanley will not touch the CIMD design or OAuth implementation, but draft PR #1800 adds a separate test block to `oauth-http.test.ts`. Ryder confirmed his trace lane is limited to ADR 445, CLI trace files, and `04-cli.md`; Izzo confirmed no OAuth or architecture overlap. PR #1793 has merged, clearing the `SPEC.md` hold. Nick approved the team-scoped OAuth client-binding table, DCR backfill, and CIMD grant binding on 2026-09-28. PR #1800 remains open and is stacked on #1784; wait for it to land and rebase before selecting a schema migration version or editing migration files.

## Review Focus

- URL parser edge cases (userinfo, explicit non-443 ports, query, fragment, oversized identifiers, IPv6 literals) must reject before DNS or HTTPS begins.
- A DNS response containing even one private, reserved, link-local, multicast, or IPv4-mapped non-public address must fail; a later DNS change must not alter the pinned connection address.
- Redirects, non-JSON responses, timeouts, oversized bodies, invalid JSON, unsupported grants/methods, or mismatched document `client_id` must fail without leaking details or redirecting.
- CIMD redirect URIs must pass the existing safety policy and match the requested URI byte-for-byte; escaped client names and CIMD hostnames appear in the consent page.
- Cache expiry/eviction, coalescing, the 16-fetch cap, DCR precedence, and a wrong client ID on code/refresh exchange must not bypass the token endpoint’s network-free contract.

---

### Task 1: Reserve and record the protocol decision

**Files:**
- Modify: `docs/superpowers/plans/2026-09-26-remote-mcp-oauth-cimd.md`
- Create: `docs/decisions/470-remote-mcp-oauth-cimd.md` (`pnpm adr:next` first returned 465; subsequent published reservations claimed 465–469, so this lane uses the fresh next number, 470)

**Interfaces:**
- Produces: the accepted decision for generic CIMD plus retained DCR, including the bounded metadata-fetch policy and the network-free token path.
- Reservation order: publish a draft PR claiming the returned ADR number before writing the ADR, as required by ADR 223.

- [x] **Step 1: Reconcile the active lane overlaps**

Read the current inbox and coordinate on shared files. Ghost confirmed no remaining OAuth edits; Ryder and Izzo confirmed their trace/architecture work does not overlap; Stanley confirmed no OAuth or CIMD design edits and disclosed a separate insertion in `oauth-http.test.ts` on draft #1800. At task start Fifty's lane owned `SPEC.md`, so the edit was parked. PR #1793 later merged and cleared that hold. The live-audience lane claimed ADR 464. ADR 465–469 are claimed by published PRs, so this lane uses ADR 470. Stanley confirmed #1800 is stacked on #1784; select the next migration version only after it lands and this branch rebases. Keep Task 5/6 schema changes held until Nick explicitly approves the binding-table change.

- [x] **Step 2: Reserve a fresh ADR number**

Use the number returned by a fresh `pnpm adr:next`; do not choose a number by inspecting `origin/main` or this plan. The initial reservation returned 465, but PRs #1792–#1798 claimed 465–469; the published reservation PR #1791 now claims ADR 470. The ADR number is published, so write the full ADR at `docs/decisions/470-remote-mcp-oauth-cimd.md`. The approved plan and reservation stub are already in that PR.

- [x] **Step 3: Write the ADR before any protocol schema edit**

Record Context, Problem, Decision, Consequences, and Observability. Reference Nick’s 2026-09-26 approval of the design and the 2026-09-28 standards refinements. The Decision must state the protocol schema addition, client-resolution order, SSRF boundary, 5 KiB metadata limit, cache directives and limits, consent hostname, audit privacy boundary, and token endpoint behavior. Do not edit `packages/protocol/src/oauth.ts` before the full ADR is present.

- [x] **Step 4: Run the ADR and doc checks**

Run `pnpm adr-numbers:check`, `pnpm change-adr:check`, and `pnpm format:check`. Expected: the new ADR number is unique, no accepted Decision changed, and the docs pass formatting checks.

### Task 2: Define and test the CIMD protocol metadata

**Files:**
- Modify: `packages/protocol/src/oauth.ts`
- Modify: `packages/protocol/src/oauth.test.ts`
- Modify: `SPEC.md`

**Interfaces:**
- Produces: `OAuthClientMetadataSchema` and `OAuthClientMetadata` in the existing OAuth module/barrel.
- Produces: `OAuthAuthorizationServerMetadataSchema.client_id_metadata_document_supported`.
- Preserves: the existing DCR request/response schemas and `musterd/0.3` Envelope version.

- [x] **Step 1: Add failing metadata schema tests**

Cover required `client_id`, non-empty `client_name` (maximum 200 characters), non-empty `redirect_uris`, explicit code and refresh grants, code response type, and `none` accepted either as `token_endpoint_auth_method` or within `token_endpoint_auth_methods_supported`. Pin stripping of unused fields such as `jwks_uri` and unrelated metadata, including a ChatGPT-shaped document whose scalar method is `private_key_jwt` but plural list includes `none`.

- [x] **Step 2: Run the focused protocol test and verify RED**

Run `pnpm --filter @musterd/protocol exec vitest run src/oauth.test.ts`. Expected: the new imports/assertions fail because the CIMD schema and metadata field do not exist.

- [x] **Step 3: Implement the smallest Zod contract**

Add the metadata schema with unknown-key stripping and refinements for the required grant, response, and supported-auth-method rules. Add the metadata capability field to the AS metadata schema.

- [x] **Step 4: Update the normative OAuth contract**

In `SPEC.md`, update the OAuth endpoint table and Appendix A.13 to say discovery advertises CIMD support while DCR remains available, and to record the resolved metadata requirements and network-free token exchange. Cite the new ADR. Do not bump the Envelope version.

PR #1793 merged and cleared the shared-file hold. `SPEC.md` now records the DCR-first resolution order, CIMD metadata and fetch boundary, consent presentation, and network-free token exchange under ADR 470.

- [x] **Step 5: Run protocol verification**

Run `pnpm --filter @musterd/protocol test`. Expected: PASS with the protocol package’s required coverage threshold intact.

### Task 3: Build the bounded CIMD resolver and pinned HTTPS transport

**Files:**
- Create: `packages/server/src/transport/cimd.ts`
- Create: `packages/server/src/transport/cimd.test.ts`

**Interfaces:**
- Consumes: `OAuthClientMetadataSchema` and `OAuthClientMetadata` from Task 2.
- Produces: `isCimdClientId(clientId: string): boolean` for syntax/policy-only checks, `createCimdResolver(deps): (clientId: string) => Promise<OAuthClientMetadata>` for hermetic tests, and production `resolveCimdClient(clientId: string): Promise<OAuthClientMetadata>`.
- `deps.lookup(hostname)` returns every `{ address: string, family: 4 | 6 }` answer; `deps.request({ url, address, timeoutMs, maxBytes })` returns `{ statusCode, contentType, body, cacheControl, age, expires }`; `deps.now()` returns epoch milliseconds. Production defaults use Node built-ins. The request gets the original `URL`, one validated address, `timeoutMs: 3000`, and `maxBytes: 5_120`. Cache freshness honors `no-store`, `no-cache`, `max-age`, `Age`, and `Expires`, with a local five-minute ceiling.

- [x] **Step 1: Write failing URL and address-classification tests**

Pin accepted HTTPS URLs and rejection of overlong URLs, non-HTTPS schemes, non-443 ports, userinfo, query, fragment, private/loopback/link-local/reserved/multicast addresses, and IPv4-mapped IPv6 forms. Assert rejected inputs cause no DNS or request call.

- [x] **Step 2: Implement CIMD URL parsing and global-unicast checks**

Use `node:net` address parsing and explicit IPv4/IPv6 range checks; do not infer safety from a hostname suffix. Resolve every A/AAAA answer and reject the whole document if any result is unsafe.

- [x] **Step 3: Write failing pinned-transport tests**

Assert that a DNS result is passed as the connection’s pinned address while the original hostname remains the TLS server name and HTTP Host; only HTTP 200 is accepted; redirects are not followed; content type must be `application/json`; timeout and byte limits abort the request.

- [x] **Step 4: Implement the Node HTTPS request boundary**

Use Node’s HTTPS request API with a lookup callback pinned to the validated address. Enforce the 3-second and 5 KiB limits while streaming; reject non-200 responses, redirects, and invalid content type; parse JSON and then apply `OAuthClientMetadataSchema`. Convert all transport/parser failures to one safe resolver error without retaining a raw URL, body, or exception message.

- [x] **Step 5: Verify the resolver boundary tests**

Run `pnpm --filter @musterd/server exec vitest run src/transport/cimd.test.ts`. Expected: PASS with no external network access.

### Task 4: Add positive caching, coalescing, and bounded miss concurrency

**Files:**
- Modify: `packages/server/src/transport/cimd.ts`
- Modify: `packages/server/src/transport/cimd.test.ts`

**Interfaces:**
- Preserves: `createCimdResolver(deps)` and `isCimdClientId(clientId)` from Task 3.
- Adds: a stable retryable resolver-capacity error for the authorization handler to map to a generic service response.

- [x] **Step 1: Add failing cache and concurrency tests**

Verify positive-only caching by exact URL, expiration at 5 minutes, least-recently-used eviction at 256 entries, one outbound request for concurrent same-URL misses, and rejection of the 17th unique in-flight miss with retryable capacity status. Verify failed results are not cached and slots are released after completion.

- [x] **Step 2: Implement the bounded cache and in-flight map**

Keep cache and active-fetch state inside the resolver instance. Coalesce by exact URL before charging the 16-unique-fetch cap. Store only schema-valid results and evict least-recently-used entries.

- [x] **Step 3: Run the focused resolver suite**

Run `pnpm --filter @musterd/server exec vitest run src/transport/cimd.test.ts`. Expected: PASS.

### Task 5: Resolve DCR or CIMD on both authorization legs

**Files:**
- Modify: `packages/server/src/transport/oauth.ts`
- Modify: `packages/server/src/transport/oauth-http.test.ts`

**Interfaces:**
- Consumes: `resolveCimdClient`/`createCimdResolver` and `isCimdClientId` from `cimd.ts`.
- Produces: one async OAuth client resolver returning `{ client_id: string, client_name: string, redirect_uris: string, client_id_host?: string }`; the `redirect_uris` field keeps the DCR store's JSON representation, and both GET and POST authorization use it.

- [x] **Step 1: Add failing HTTP tests for discovery and authorization**

Assert AS metadata returns `client_id_metadata_document_supported: true` and retains `registration_endpoint`. With an injected resolver, prove a DCR hit never fetches, a CIMD GET displays the resolved name, and CIMD POST issues a code for the same client ID. Confirm both authorization routes remain behind the existing per-IP rate limit. Cover exact redirect match, unsafe listed redirect rejection, mismatched document ID, generic non-redirecting client error, escaped `client_name`, and retryable capacity response.

- [x] **Step 2: Run the focused HTTP tests and verify RED**

Run `pnpm --filter @musterd/server exec vitest run src/transport/oauth-http.test.ts`. Expected: the new CIMD cases fail while existing DCR cases remain unchanged.

- [x] **Step 3: Make client resolution asynchronous and share it across GET/POST**

Look up the DCR row first. Only on a DCR miss and a valid CIMD URL call the resolver. Apply the existing redirect safety check to resolved redirect URIs, then compare the requested redirect exactly. Map fetch/validation failure to the current generic OAuth client error; map the bounded-fetch-cap case to a generic retryable service error.

- [x] **Step 4: Run focused OAuth HTTP verification**

Run `pnpm --filter @musterd/server exec vitest run src/transport/oauth-http.test.ts`. Expected: PASS, including the existing DCR registration and consent flows.

### Task 6: Keep code and refresh-token exchange network-free

**Files:**
- Modify: `packages/server/src/store/oauth.ts`
- Modify: `packages/server/src/store/oauth.test.ts`
- Modify: `packages/server/src/db/migrations.ts`
- Modify: `packages/server/src/db/db.test.ts`
- Modify: `packages/server/src/transport/oauth.ts`
- Modify: `packages/server/src/transport/oauth-http.test.ts`

**Interfaces:**
- Preserves: the current code and refresh grant stores and exact `client_id` binding. Add a composite `(team_id, client_id)` binding table for DCR and CIMD identities; migrate existing DCR rows and point code/token foreign keys at it so one published client ID can bind in multiple Teams.
- Consumes: `isCimdClientId(clientId)` only; the token route must not call `resolveCimdClient`.

- [x] **Step 1: Add failing binding and token-path tests**

Issue a CIMD authorization code through the injected resolver, then assert matching code redemption and refresh rotation succeed without a metadata fetch. Assert the binding table scopes the same published client ID independently to two Teams, a different well-formed CIMD URL cannot redeem or rotate that grant, and an unknown non-CIMD ID remains `invalid_client`. Migration coverage preserves existing DCR clients, codes, and tokens.

- [x] **Step 2: Implement the local DCR-miss check**

Keep the existing local DCR lookup. On a miss, allow the request to reach code/refresh grant matching only when `isCimdClientId` accepts its syntax; never resolve DNS or HTTP here. DCR registration creates its `dcr` binding transactionally; `issueCode` ensures the team-scoped identity binding only after authorization has resolved the client and accepted proof. The stores’ exact client ID binding remains authoritative.

- [x] **Step 3: Run the focused token tests**

Run `pnpm --filter @musterd/server exec vitest run src/transport/oauth-http.test.ts`. Expected: PASS, with the resolver spy proving zero token-path calls.

### Task 7: Reconcile implementation docs and complete acceptance

**Files:**
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/05-mcp.md`
- Modify: `docs/implementation-plan.md`

**Interfaces:**
- Documents: DCR-first/CIMD-second authorization resolution, fetch limits and error posture, and the token endpoint’s local-only behavior.
- Clarifies: remote OAuth/discovery belongs to `@musterd/server`; `@musterd/mcp` remains the stdio adapter and needs no source change.
- Leaves `docs/architecture/02-protocol.md` unchanged: its current OAuth-neutral Envelope/handshake contract does not describe these HTTP authorization endpoints; the normative OAuth contract stays in `SPEC.md` and implementation detail in `03-server.md`.

- [x] **Step 1: Update the implementation-facing docs**

Add `cimd.ts` to the `packages/server/src/` file tree and describe its bounded metadata resolver alongside `oauth.ts`. Add a short ownership note in `05-mcp.md`. Update `docs/implementation-plan.md` to record the remote OAuth increment’s completed state and any remaining demo acceptance dependency.

- [x] **Step 2: Run the required package suites**

Run `pnpm --filter @musterd/protocol test` and `pnpm --filter @musterd/server test`. Expected: PASS with protocol coverage at least 95% and server coverage at least 85%.

- [x] **Step 3: Run the required local pre-push gates**

Run `pnpm typecheck && pnpm lint && pnpm format:check`. Expected: PASS. CI’s `gates` workflow remains the authority for full build, tests, coverage, format, and ADR checks; do not run the full suite locally as a duplicate of CI.

- [x] **Step 4: Complete or record real-client acceptance**

Use Claude’s published identity and ChatGPT Developer Mode on an eligible Business, Enterprise, or Edu laptop account. Verify discovery, consent, callback, code exchange, MCP tool call, and refresh; separately verify a DCR client still completes the same flow. If an eligible ChatGPT account is unavailable, record that acceptance item as unmet rather than replacing it with a fixture.

Recorded unmet on 2026-09-29: this workspace exposes no authenticated Claude published-identity or eligible ChatGPT Developer Mode session, and no browser-control surface to run those callbacks. The hermetic fixtures do not count as real-client acceptance; reopen this check when those client sessions are available.

Run on 2026-10-26 (lane 01M3QQJENE): a throwaway daemon on its own database, reached through a Cloudflare quick tunnel, team `cimd`, members admitted by invite.

| Client | Identity it chose | Discovery | Consent | Callback + code exchange | Tool call | Refresh |
|---|---|---|---|---|---|---|
| claude.ai web | CIMD, `https://claude.ai/oauth/mcp-oauth-client-metadata` | pass | pass, page shows "Client ID host: claude.ai" | pass | pass, `team_status` | pass, `oauth.token_rotated` after the 1h expiry |
| ChatGPT web, Plus account | CIMD, a per-connector `https://chatgpt.com/oauth/<id>/client.json` | pass | pass | pass | pass, `team_status` | not observed (the run ended inside the first hour) |
| Codex CLI 0.162 | CIMD, `https://chatgpt.com/oauth/codex/<id>/client.json` | pass | failed with 400, then pass after ADR 743 | pass | `tools/list` pass; no tool call, because the machine's Codex model login was revoked | not observed |
| DCR | a client registered over `/register`, driven by curl through the tunnel | pass | pass | pass | pass, `team_status` | pass |

- Codex registers portless loopback redirects and authorizes from an ephemeral port, which the exact redirect match refused. Fixed by [ADR 743](../../decisions/743-oauth-loopback-redirect-any-port.md) (#3379); the same login then completed.
- No real client used DCR. All three defaulted to CIMD, and claude.ai sent its CIMD client ID even with "Register automatically" selected on the connector. The DCR row is therefore the client shape driven by hand, as Rehearsal A did, and not a real client.
- ChatGPT's "Add custom MCP server" is on a Plus account, not only Business, Enterprise or Edu.
- The consent page renders as unstyled HTML, and a remote seat's `POST /teams/:team/telemetry/tool-calls` is refused 403 on every tool call. Both are noted here and not fixed in this run.

- [ ] **Step 5: Publish and close the lane by the repository workflow**

Push only after the local pre-push gates pass. Keep the seat trailer and `Refs ADR-NNN` in the final squash message. Let required CI auto-merge the PR; after merge submit the lane with PR/SHA/authorizer and follow the returned acceptance contract.
