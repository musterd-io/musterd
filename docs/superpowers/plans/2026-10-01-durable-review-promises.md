# Durable review promises — implementation plan

**Goal:** An accepted, typed review request remains visible to its owner and requester until the
root thread is resolved. A non-owner close leaves one owner-side notice until the owner reads the
resolve. The weekly audit can identify requests open longer than seven days.

**Architecture:** `SPEC.md` Appendix A.14 and ADR 490 define the protocol. `NextBrief` carries three
optional arrays derived from the existing Act ledger: `request_reviews`, `requested_reviews`, and
`review_closures`. The server remains the only place that derives them. `musterd next`, `team_next`,
and `pnpm goals:audit` consume the same projection. No obligation table, new Act, timer, or runtime
dependency is added.

**Approved design:** [Durable review promises](../specs/2026-09-30-durable-review-promises-design.md)
and [ADR 490](../../decisions/490-durable-review-promises.md). The normative wire definition is
[SPEC.md §A.14](../../../SPEC.md).

**Starting point:** The accepted design and this plan are on the `nothing-vanishes` Goal. The
current protocol feature epoch is 27; read it from fresh `main` when the protocol increment starts
and advance it by one for the landed capability.

## Increments

| Increment | Lane | Scope and dependency |
| --- | --- | --- |
| 1 — Protocol contract | `01M3TWJWBTPETEV8RSZDTRZS9N` | Add validated review metadata and optional `NextBrief` projections. Depends on the design-and-plan lane `01M3TBW5QPKY76FTV9SAGM8MBZ`. |
| 2 — Server projection | `01M3TWKK5NS6SQR0BFM7K4F8FW` | Derive the three arrays from request, accept, resolve and inbox-cursor Acts. Depends on increment 1. |
| 3 — CLI and weekly audit | `01M3TWKKEDSNVZ4XMY07FRG5A1` | Render the projection in `musterd next`; have `goals:audit` inspect the requester-side array. Depends on increment 2. |
| 4 — MCP `team_next` | `01M3TWKMDWMQWTQ777TGEAZM9G` | Render the same projection in MCP. Depends on increment 3. |

The Goal `nothing-vanishes` already exists. All four implementation lanes are open and linked to
it. Each increment is a separate branch and PR. Do not begin the next package until the preceding
package passes its acceptance gate.

## Global constraints

- A typed review request is a root `request_help` Act to exactly one Member. Team recipients,
  `meta.eligible`, an existing thread, malformed references, and `meta.review` on other Acts are
  rejected. Untyped requests keep their current behavior.
- The artifact reference is one of the four accepted forms in SPEC A.14. Validate it with the
  shared protocol schema at every external boundary; never accept credentials or signed tokens in
  the reference.
- Only an `accept` from the direct recipient with `meta.in_reply_to` naming the request creates a
  promise. The server sets or verifies its thread as the request id. Duplicate valid accepts fold
  to the minimum `(ts, id)`; `accepted_at` is that Act's `ts`.
- An unresolved root thread yields owner and requester rows. A Team-addressed `resolve` closes both
  rows; if the closer is not the owner, the owner gets one notice until their inbox cursor crosses
  the resolve Act. No timer expires a promise.
- The three `NextBrief` arrays are optional and have no defaults. A supporting daemon emits all
  three, even as `[]`. Clients show unsupported when absent and an empty state for `[]`; the audit
  abstains when `requested_reviews` is absent.
- Keep these arrays separate from Lane acceptance fields `owed_reviews` and `review_debt`. Preserve
  the existing `GET /next/summary` bounded-query contract; it does not gain review-promise rows.
- No schema migration or runtime dependency. No change to ordinary GitHub review policy.
- Use the protocol → server → CLI → MCP build order below. Keep docs and implementation in agreement
  in each increment. Do not run the full suite locally to pre-verify CI; CI's `gates` job is the
  authority.

## File map

| Increment | Create | Modify |
| --- | --- | --- |
| Protocol | `packages/protocol/src/review-promise.ts`, `packages/protocol/src/review-promise.test.ts` | `packages/protocol/src/envelope.ts`, `packages/protocol/src/envelope.test.ts`, `packages/protocol/src/lanes.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/feature-epoch.ts`, `docs/architecture/02-protocol.md` |
| Server | `packages/server/src/protocol/route.review.test.ts` | `packages/server/src/protocol/route.ts`, `packages/server/src/store/orientation.ts`, `packages/server/src/store/orientation.test.ts`, `packages/server/src/transport/integration.test.ts`, `docs/architecture/03-server.md` |
| CLI and audit | — | `packages/cli/src/commands/next.ts`, `packages/cli/src/commands/orient.test.ts`, `scripts/goals-audit.ts`, `scripts/goals-audit.test.ts`, `docs/architecture/04-cli.md`, `docs/design/figma-brief-terminal.md`, the existing Terminal UX Figma file (`cmd/next` frame) |
| MCP | — | `packages/mcp/src/tools/lanes.ts`, `packages/mcp/src/tools/next.render.test.ts`, `packages/mcp/src/tools/tools.test.ts`, `docs/architecture/05-mcp.md` |

If an implementation needs another file, update the relevant lane scope and the architecture file
tree before adding it. `packages/protocol/src/review-promise.ts` owns the shared reference and row
schemas so `envelope.ts` and `lanes.ts` import one definition without a cycle.

## Task 1 — Protocol contract

- **Lane:** `01M3TWJWBTPETEV8RSZDTRZS9N`
- **Branch:** create from fresh `origin/main` after the design-and-plan lane lands.
- **Produces:** parsed review references and backward-compatible `NextBrief` fields.

1. In `review-promise.test.ts`, first pin valid PR, commit, Lane, and HTTPS URL references; reject
   non-positive PR numbers, malformed repository slugs, short/non-hex commit SHAs, `.`/`..` path
   segments, non-HTTPS URLs, userinfo, query strings, and fragments. Pin the three projection row
   shapes and their numeric timestamps. Run `pnpm exec vitest run
   packages/protocol/src/review-promise.test.ts packages/protocol/src/envelope.test.ts` and confirm
   the focused tests fail because the schemas are not implemented yet.
2. In `envelope.test.ts`, pin that `meta.review` is accepted only on a root `request_help` to one
   Member, and rejects Team, eligible-set, non-root, or non-`request_help` forms. Keep the existing
   unknown-meta forward-compatibility behavior for other keys.
3. Add the shared schemas and types in `review-promise.ts`; wire the envelope refinement and the
   optional `NextBrief` arrays in `envelope.ts` and `lanes.ts`. Do not use `.default([])` on the new
   arrays. Add exports and describe the new source file in the protocol tree in `02-protocol.md`.
4. Add a compatibility assertion: a pre-feature brief parses while each new key remains absent;
   an explicitly supported `[]` remains present and empty.
5. Append the implementation-facing notes to `02-protocol.md` to match accepted SPEC A.14. Increment
   `FEATURE_EPOCH` from the value on fresh `main` by exactly one and name ADR 490 in its comment.
6. Run `pnpm --filter @musterd/protocol test`. Do not start server work until it passes.

## Task 2 — Server derivation and close semantics

- **Lane:** `01M3TWKK5NS6SQR0BFM7K4F8FW`
- **Branch:** create from fresh `origin/main` after increment 1 is merged and accepted.
- **Produces:** all three arrays on the existing `GET /next` projection, derived only from Acts.

1. Add failing store tests in `orientation.test.ts` for: accepted unresolved request appears for owner
   and requester; requester row identifies owner and age; rows are oldest-first with request id as
   tie-breaker; untyped, declined, unaccepted, wrong-sender, and resolved requests produce no open
   promise; duplicate accepts select the minimum `(ts, id)`; Lane review fields remain unchanged.
2. Add close-notice tests: any Member can resolve the root thread; the resolve is Team-addressed;
   both open rows disappear; a non-owner close yields one owner notice with closer and timestamp;
   that notice disappears after the owner's cursor crosses the resolve Act. Compare the cursor's
   `(last_read_ts, last_read_message_id)` against the resolve row's receipt position
   `(created_at, id)`, never its sender-controlled `ts`; pin this with skewed Act timestamps. Verify
   an owner close creates no notice.
3. Add route tests in `route.review.test.ts`: a controlling accept with the matching `in_reply_to`
   is stored with the request id as `thread` (fill it when absent; reject a conflicting thread); a
   typed review request cannot be resolved through a private recipient; ordinary request/resolve
   routing remains unchanged. Run `pnpm exec vitest run
   packages/server/src/store/orientation.test.ts packages/server/src/protocol/route.review.test.ts`
   and confirm these focused tests fail before implementation.
4. Implement a bounded, deterministic projection in `store/orientation.ts` over the existing
   message log, member rows and inbox cursor. Do not add a table, timer, or per-recipient copy.
   Return all rows, sorted by `(accepted_at, request_id)`, and always include the three arrays,
   including empty arrays.
5. Exercise the HTTP `GET /teams/:slug/next` path in `transport/integration.test.ts`. Update the
   server source tree and projection contract in `03-server.md`.
6. Run `pnpm --filter @musterd/server test`. Do not start CLI work until it passes.

## Task 3 — CLI and weekly audit

- **Lane:** `01M3TWKKEDSNVZ4XMY07FRG5A1`
- **Branch:** create from fresh `origin/main` after increment 2 is merged and accepted.
- **Produces:** a usable `musterd next` view and a safe weekly audit check.

1. Add command-level cases in `orient.test.ts` for an owner promise, a requester-visible accepted
   owner and age, and a non-owner close notice. Pin ordering and closure behavior from the server
   response; run `pnpm exec vitest run packages/cli/src/commands/orient.test.ts` and confirm they
   fail on the missing output.
2. Render three distinct sections in `commands/next.ts`, separately from `owed by you` and
   `review debt`. For each new field, pin both cases: absent reports that the daemon does not
   support the section; `[]` reports no matching work. Keep rows readable at the terminal width and
   use the brand's existing accent, member, and dim metadata roles.
3. Add a `cmd/next` frame to the Terminal UX Figma file and its matching entry in
   `figma-brief-terminal.md`. Snapshot the same content in the CLI tests; the frame and renderer
   must match character-for-character.
4. Extend `scripts/goals-audit.ts` to read the full `NextBrief` through the existing `HttpClient`
   and report accepted requester-side reviews older than seven days using `accepted_at`. Extend
   `auditFindings` inputs with an optional review list: `undefined` means abstain, `[]` means a
   supported empty population. Keep the current three checks and the quiet-on-clean posting policy.
5. Add pure audit tests for absent field, supported empty list, a request just under seven days, and
   an open request older than seven days. Run the focused audit tests and confirm they fail first.
   Verify the finding names the request and owner, not request prose or a credential-bearing URL.
6. Update the CLI architecture description. Run `pnpm --filter @musterd/cli test` and
   `pnpm exec vitest run scripts/goals-audit.test.ts`, then check the terminal snapshot against the
   Figma frame. Do not start MCP work until these pass.

## Task 4 — MCP `team_next`

- **Lane:** `01M3TWKMDWMQWTQ777TGEAZM9G`
- **Branch:** create from fresh `origin/main` after increment 3 is merged and accepted.
- **Produces:** the same promise and close information in the existing prose-only `team_next` result.

1. Add `fmtNext` tests in `next.render.test.ts` for owner promises, requester visibility, a non-owner
   close, ordering, and all three absent-versus-empty states. Run `pnpm exec vitest run
   packages/mcp/src/tools/next.render.test.ts` and confirm they fail against the current renderer.
2. Render the three sections separately from `owed_reviews` and `review_debt`, using the same
   copy and ordering as the CLI. Do not add fields to MCP `structuredContent`; `team_next` remains a
   prose read view.
3. Add a tool-level `team_next` test in `tools.test.ts` showing the new fields survive the client
   read and render as expected, including a legacy response with the fields absent.
4. Update `05-mcp.md` and run `pnpm --filter @musterd/mcp test`.

## Final integration and land path

After all four increments merge in dependency order:

1. Run the required fast local gates before each push: `pnpm typecheck && pnpm lint && pnpm format:check`.
   The format check also runs the architecture tree, work-item citations, vocabulary, and ADR gates.
2. Let each PR's CI `gates` job run the full build, tests, coverage, and format checks. Do not merge
   past a red gate and do not run the full suite locally to pre-verify CI.
3. Submit each merged lane with its PR, squash SHA, and `authorized_by`; follow the response's
   acceptance/backstop contract before proceeding to the dependent lane.
4. Keep the existing Goal `nothing-vanishes` in flight until all four lanes are accepted. No
   additional Goal is needed for this feature.

## Self-review checklist

- [ ] Request metadata is typed, direct-Member-only, and parsed at boundaries.
- [ ] The act ledger is the only source of truth; no obligation store or expiration timer exists.
- [ ] Duplicate acceptance selection is replica-deterministic.
- [ ] A non-owner resolve is visible to the owner once and clears when read.
- [ ] Old-daemon omission remains distinguishable from supported empty data in both renderers and
  the audit.
- [ ] The weekly audit uses requester-side `accepted_at` and abstains on omission.
- [ ] `owed_reviews` and `review_debt` keep their Lane acceptance meanings.
- [ ] Every package passes its own acceptance gate before the next package starts.
- [ ] Every increment row names its open Lane on the existing Goal.
- [ ] Architecture docs, SPEC, terminal frame, and code agree at the end of each increment.
