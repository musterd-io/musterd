# Durable review promises implementation plan

> **For implementers:** Use `superpowers:executing-plans` and the musterd Lane workflow. Implement
> each increment in its named Lane, in a seat; do not dispatch writing subagents.

**Goal:** Keep accepted typed review requests visible to their owner and requester until the root
thread resolves, and let the weekly audit identify requests open longer than seven days.

**Architecture:** The server derives promises from the Act ledger. `NextBrief` returns owner and
requester rows for their own views, while an authenticated Team read returns minimal metadata for
the service audit. CLI and MCP render the per-Member brief; `goals:audit` consumes the Team read.
No obligation table, new Act, timer, or runtime dependency is added.

**Tech Stack:** TypeScript, pnpm workspaces, Zod, SQLite, Vitest.

**Spec:** [Durable review promises](../specs/2026-09-30-durable-review-promises-design.md), [ADR
490](../../decisions/490-durable-review-promises.md), and [SPEC.md §A.14](../../../SPEC.md).

## Global Constraints

- A typed review request is a root `request_help` Act to exactly one Member; Team recipients,
  `meta.eligible`, existing threads, malformed references, and `meta.review` on other Acts are
  rejected.
- Parse the artifact reference through the shared protocol schema at every external boundary; never
  accept credentials or signed access tokens in it.
- Only the direct recipient's `accept` with `meta.in_reply_to` naming the request creates a promise;
  duplicate valid accepts select the minimum `(ts, id)` pair.
- A Team-addressed `resolve` closes both per-Member rows; a non-owner close leaves one owner notice
  until the owner's inbox cursor crosses the resolve Act.
- The three `NextBrief` arrays remain optional with no defaults. Supporting daemons emit all three,
  including `[]`; CLI and MCP distinguish absence from empty.
- `GET /teams/:slug/review-promises?open=1` requires an active Member of the named Team and returns
  only `{request_id, requester, owner, accepted_at}`. The weekly audit abstains when this read is
  unsupported and treats `[]` as supported empty data.
- Keep the audit read separate from `GET /teams/:slug/next/summary`, whose bounded-query contract
  does not gain review rows. Keep review promises separate from Lane fields `owed_reviews` and
  `review_debt`.
- No schema migration, timer, new Act, or runtime dependency. Ordinary GitHub review policy is
  unchanged.
- Follow protocol → server → CLI → MCP. Keep docs and code aligned in each increment; CI `gates` is
  the full-suite authority.

## Review Focus

- Invalid PR, commit, Lane, and URL references must fail protocol validation (Task 1 tests).
- A forged or duplicate `accept` must not change the promise owner or replica-selected timestamp
  (Tasks 1–2 tests).
- A skewed sender timestamp must not clear a non-owner close notice before the owner's cursor has
  crossed the resolve receipt (Task 2 tests).
- The Team audit route must reject unauthenticated and cross-Team reads and omit review prose and
  artifact references (Task 2 tests).
- Older daemons, supported empty arrays, and the strict seven-day threshold must remain
  distinguishable (Tasks 1 and 3 tests).

---

**Starting point:** The approved design and plan belong to the existing `nothing-vanishes` Goal. The
current protocol feature epoch is 27; read it from fresh `main` when increment 1 starts and advance
it by one for the landed capability.

## Increments

| Increment | Lane | Scope and dependency |
| --- | --- | --- |
| 1 — Protocol contract | `01M3TWJWBTPETEV8RSZDTRZS9N` | Add validated review metadata, optional `NextBrief` projections, and the Team audit response schema. Depends on the design-and-plan lane `01M3TBW5QPKY76FTV9SAGM8MBZ`. |
| 2 — Server projection | `01M3TWKK5NS6SQR0BFM7K4F8FW` | Derive per-Member projections and the minimal Team audit read from request, accept, resolve, and inbox-cursor Acts. Depends on increment 1. |
| 3 — CLI and weekly audit | `01M3TWKKEDSNVZ4XMY07FRG5A1` | Render the per-Member projection in `musterd next`; have `goals:audit` consume the Team audit read. Depends on increment 2. |
| 4 — MCP `team_next` | `01M3TWKMDWMQWTQ777TGEAZM9G` | Render the same projection in MCP. Depends on increment 3. |

The Goal `nothing-vanishes` already exists. All four implementation lanes are open and linked to
it. Each increment is a separate branch and PR. Do not begin the next package until the preceding
package passes its acceptance gate.

## File map

| Increment | Create | Modify |
| --- | --- | --- |
| Protocol | `packages/protocol/src/review-promise.ts`, `packages/protocol/src/review-promise.test.ts` | `packages/protocol/src/envelope.ts`, `packages/protocol/src/envelope.test.ts`, `packages/protocol/src/lanes.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/feature-epoch.ts`, `docs/architecture/02-protocol.md` |
| Server | `packages/server/src/protocol/route.review.test.ts` | `packages/server/src/protocol/route.ts`, `packages/server/src/store/orientation.ts`, `packages/server/src/store/orientation.test.ts`, `packages/server/src/transport/http.ts`, `packages/server/src/transport/integration.test.ts`, `docs/architecture/03-server.md` |
| CLI and audit | — | `packages/cli/src/client.ts`, `packages/cli/src/client.test.ts`, `packages/cli/src/commands/next.ts`, `packages/cli/src/commands/orient.test.ts`, `scripts/goals-audit.ts`, `scripts/goals-audit.test.ts`, `docs/architecture/04-cli.md`, `docs/design/figma-brief-terminal.md`, the existing Terminal UX Figma file (`cmd/next` frame) |
| MCP | — | `packages/mcp/src/tools/lanes.ts`, `packages/mcp/src/tools/next.render.test.ts`, `packages/mcp/src/tools/tools.test.ts`, `docs/architecture/05-mcp.md` |

If implementation needs another file, update the relevant Lane scope and architecture file tree
before adding it. `packages/protocol/src/review-promise.ts` owns the shared reference, per-Member row,
and Team audit response schemas so `envelope.ts` and `lanes.ts` import one definition without a cycle.

## Task 1 — Protocol contract

- **Lane:** `01M3TWJWBTPETEV8RSZDTRZS9N`
- **Branch:** create from fresh `origin/main` after the design-and-plan lane lands.
- **Produces:** parsed review references and backward-compatible `NextBrief` fields.

**Files:**

- Create: `packages/protocol/src/review-promise.ts`
- Test: `packages/protocol/src/review-promise.test.ts`
- Modify: `packages/protocol/src/envelope.ts`, `packages/protocol/src/envelope.test.ts`,
  `packages/protocol/src/lanes.ts`, `packages/protocol/src/index.ts`,
  `packages/protocol/src/feature-epoch.ts`, `docs/architecture/02-protocol.md`

**Interfaces:**

- Consumes: none; this is the shared contract increment.
- Produces: `ReviewPromiseReferenceSchema`, per-Member open/closure row schemas,
  `ReviewPromisesQuerySchema` for `open=1`, `ReviewPromiseAuditRowSchema`, and
  `ReviewPromisesResponseSchema` with a required `review_promises` array.

- [ ] **Step 1: Add reference schema tests.** Pin valid PR, commit, Lane, and HTTPS URL forms; reject
  non-positive PR numbers, malformed repository slugs, short/non-hex commit SHAs, `.`/`..` path
  segments, non-HTTPS URLs, userinfo, query strings, and fragments.
- [ ] **Step 2: Add projection and query schema tests.** Pin the three `NextBrief` row shapes and
  timestamps, `ReviewPromisesQuerySchema` accepting `open=1`, the minimal Team audit row
  `{request_id, requester, owner, accepted_at}`, and response shape `{review_promises: []}`. Reject
  extra content/reference fields in an audit row.
- [ ] **Step 3: Add envelope refinement tests.** `meta.review` is accepted only on a root
  `request_help` to one Member; Team, eligible-set, non-root, and non-`request_help` forms fail.
  Existing unknown-meta forward compatibility remains intact.
- [ ] **Step 4: Run the focused tests and confirm they fail.** Run `pnpm exec vitest run
  packages/protocol/src/review-promise.test.ts packages/protocol/src/envelope.test.ts`.
- [ ] **Step 5: Implement the shared schemas and types.** Wire the envelope refinement and optional
  `NextBrief` arrays through `envelope.ts` and `lanes.ts`; do not default new arrays to `[]`. Export
  the schemas and types from `index.ts`.
- [ ] **Step 6: Pin legacy parsing.** A pre-feature brief parses with each new field absent; explicit
  supported empty arrays and `{review_promises: []}` remain present and empty.
- [ ] **Step 7: Update protocol docs and epoch.** Match SPEC A.14 in `02-protocol.md`, add the new
  source file to its tree, and increment `FEATURE_EPOCH` from fresh `main` by exactly one with ADR
  490 in its comment.
- [ ] **Step 8: Run the protocol acceptance gate.** Run `pnpm --filter @musterd/protocol test`;
  resolve any failure before starting Task 2.

## Task 2 — Server derivation and close semantics

- **Lane:** `01M3TWKK5NS6SQR0BFM7K4F8FW`
- **Branch:** create from fresh `origin/main` after increment 1 is merged and accepted.
- **Produces:** the three per-Member arrays on `GET /teams/:slug/next` and the minimal Team-wide
  audit read, both derived only from Acts.

**Files:**

- Create: `packages/server/src/protocol/route.review.test.ts`
- Modify: `packages/server/src/protocol/route.ts`, `packages/server/src/store/orientation.ts`,
  `packages/server/src/store/orientation.test.ts`, `packages/server/src/transport/http.ts`,
  `packages/server/src/transport/integration.test.ts`, `docs/architecture/03-server.md`

**Interfaces:**

- Consumes: the protocol review, query, and response schemas from increment 1.
- Produces: all three optional per-Member arrays on `GET /teams/:slug/next`, plus
  `GET /teams/:slug/review-promises?open=1` returning `ReviewPromisesResponse`.
- Store projection: `deriveTeamReviewPromises(db, teamId): Promise<ReviewPromiseAuditRow[]>`; it
  shares the same open-promise derivation and deterministic accept selection as `deriveNext`.

- [ ] **Step 1: Pin the Act-derived rows.** In `orientation.test.ts`, cover an accepted unresolved
  request appearing for its owner and requester; requester row owner and age; `(accepted_at,
  request_id)` ordering; and no open row for untyped, declined, unaccepted, wrong-sender, or resolved
  requests. Pin duplicate accepts selecting the minimum `(ts, id)` and prove Lane fields
  `owed_reviews` and `review_debt` are unchanged.
- [ ] **Step 2: Pin close and cursor behavior.** Test a Team-addressed root-thread resolve by any
  Member, disappearance of both open rows, no notice when the owner closes, and one owner notice
  after a non-owner close until the owner's cursor crosses that resolve. Compare the cursor's
  `(last_read_ts, last_read_message_id)` to the resolve receipt `(created_at, id)`, not sender
  `ts`; include skewed Act timestamps.
- [ ] **Step 3: Pin protocol routing.** In `route.review.test.ts`, cover a matching `in_reply_to`
  accept whose `thread` is filled as the request id when absent and rejected when conflicting; a
  typed request cannot be resolved through a private recipient; ordinary request/resolve routing
  stays unchanged. Run `pnpm exec vitest run
  packages/server/src/store/orientation.test.ts packages/server/src/protocol/route.review.test.ts`
  and confirm the new focused cases fail before implementation.
- [ ] **Step 4: Implement shared derivation.** Derive both per-Member projections and Team audit
  rows from the existing Act log, Member rows, and inbox cursor. Do not add a table, timer, or
  per-recipient copy. Select duplicate accepts by minimum `(ts, id)` and sort output by
  `(accepted_at, request_id)`.
- [ ] **Step 5: Add the authenticated Team read.** In `transport/http.ts`, implement
  `GET /teams/:slug/review-promises?open=1` for an authenticated active Member of that Team. Parse
  the query and validate the response through the shared protocol schemas. Return only
  `{request_id, requester, owner, accepted_at}` per row; reject unauthenticated, cross-Team, and
  unsupported query forms.
- [ ] **Step 6: Exercise and document the route.** In `integration.test.ts`, verify authorized reads
  include every open Team row in stable order, supported empty returns `{review_promises: []}`, and
  responses omit context and artifact refs. Verify unauthenticated and cross-Team reads fail.
  Update the server source tree and `03-server.md`.
- [ ] **Step 7: Run the server acceptance gate.** Run `pnpm --filter @musterd/server test`; resolve
  failures before starting CLI work.

## Task 3 — CLI and weekly audit

- **Lane:** `01M3TWKKEDSNVZ4XMY07FRG5A1`
- **Branch:** create from fresh `origin/main` after increment 2 is merged and accepted.
- **Produces:** a usable `musterd next` view and a safe weekly audit check.


**Files:**

- Modify: `packages/cli/src/client.ts`, `packages/cli/src/client.test.ts`,
  `packages/cli/src/commands/next.ts`, `packages/cli/src/commands/orient.test.ts`,
  `scripts/goals-audit.ts`, `scripts/goals-audit.test.ts`, `docs/architecture/04-cli.md`,
  `docs/design/figma-brief-terminal.md`, the existing Terminal UX Figma file (`cmd/next` frame)

**Interfaces:**

- Consumes: `ReviewPromiseAuditRow` and `ReviewPromisesResponse` from the protocol package.
- Produces: `HttpClient.reviewPromises(slug): Promise<ReviewPromisesResponse | undefined>`; `undefined`
  means the old daemon returned `not_found`, while a parsed response with `[]` means supported and
  empty. Other errors and invalid response payloads remain errors.
- Audit input: `auditFindings` accepts optional
  `reviewPromises?: readonly ReviewPromiseAuditRow[]`; undefined skips this check, and a present
  array checks every row.
- Audit output: `formatAuditOutput(findings, reviewPromisesSupported)` writes explicit abstention
  when the endpoint is unsupported; `auditBody(findings)` remains only real findings for posting.

- [ ] **Step 1: Test the HTTP client contract.** In `client.test.ts`, assert the exact
  `/teams/:slug/review-promises?open=1` request, response schema parsing, 404/`not_found` returning
  `undefined`, and other HTTP or malformed-payload errors propagating.
- [ ] **Step 2: Pin command output.** In `orient.test.ts`, cover an owner promise, requester-visible
  owner and age, and a non-owner close notice. Pin server ordering and closure behavior; run
  `pnpm exec vitest run packages/cli/src/commands/orient.test.ts` and confirm the new cases fail on
  missing output.
- [ ] **Step 3: Render the three promise sections.** In `commands/next.ts`, render each projection
  separately from `owed by you` and `review debt`. For each field, absent means unsupported and `[]`
  means no matching work. Keep rows within terminal width and use existing brand roles.
- [ ] **Step 4: Match the terminal design.** Add the `cmd/next` frame to the existing Terminal UX
  Figma file and the matching description to `figma-brief-terminal.md`. Snapshot the same content in
  CLI tests; frame and renderer must match character-for-character.
- [ ] **Step 5: Use the Team audit read.** Have `goals:audit` call `http.reviewPromises(team)` rather
  than using sweep's per-caller `NextBrief`. Extend `auditFindings` with the optional Team rows and
  flag only requests with `now - accepted_at > WEEK_MS`; exactly seven days is not stale. Keep the
  existing three checks active. When the route is unsupported, print an explicit abstention and
  suppress the all-clean line if there are no other findings; do not include unsupported status in
  a posted finding. Preserve the existing post-on-findings policy.
- [ ] **Step 6: Pin audit boundaries and privacy.** In `goals-audit.test.ts`, distinguish absent from
  `[]`; cover just under, exactly at, and just over seven days; and verify findings identify request
  id, requester, and owner without context or artifact references. Test `formatAuditOutput` so
  unsupported output says the review-promise check abstained and never implies a clean audit; verify
  `auditBody` contains no unsupported status. Run `pnpm exec vitest run
  scripts/goals-audit.test.ts` and confirm new cases fail before implementation.
- [ ] **Step 7: Update docs and run the CLI gate.** Update `04-cli.md`; run
  `pnpm --filter @musterd/cli test` and `pnpm exec vitest run scripts/goals-audit.test.ts`, then
  check the terminal snapshot against the Figma frame. Do not start MCP work until these pass.

## Task 4 — MCP `team_next`

- **Lane:** `01M3TWKMDWMQWTQ777TGEAZM9G`
- **Branch:** create from fresh `origin/main` after increment 3 is merged and accepted.
- **Produces:** the same promise and close information in the existing prose-only `team_next` result.


**Files:**

- Modify: `packages/mcp/src/tools/lanes.ts`, `packages/mcp/src/tools/next.render.test.ts`,
  `packages/mcp/src/tools/tools.test.ts`, `docs/architecture/05-mcp.md`

**Interfaces:**

- Consumes: the optional per-Member `NextBrief` rows and schemas from `@musterd/protocol`.
- Produces: prose sections in the existing `team_next` result; no new MCP tool or
  `structuredContent` fields.

- [ ] **Step 1: Pin renderer behavior.** In `next.render.test.ts`, cover owner promise, requester
  visibility, non-owner close, ordering, and absent-versus-empty states for each of the three
  projections. Run `pnpm exec vitest run packages/mcp/src/tools/next.render.test.ts` and confirm
  the new cases fail against the current renderer.
- [ ] **Step 2: Render the sections.** In `lanes.ts`, render the three projections separately from
  `owed_reviews` and `review_debt`, matching the CLI copy and ordering. Keep `team_next` prose-only;
  add no fields to MCP `structuredContent`.
- [ ] **Step 3: Pin tool-level rendering.** In `tools.test.ts`, verify the protocol fields survive
  the client read and render correctly, including a legacy response with all three fields absent.
- [ ] **Step 4: Document and run the MCP gate.** Update `05-mcp.md` and run
  `pnpm --filter @musterd/mcp test`.

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
- [ ] The weekly audit uses the Team-wide `accepted_at` rows, flags only ages strictly over seven
  days, and explicitly abstains when the route is unsupported.
- [ ] `owed_reviews` and `review_debt` keep their Lane acceptance meanings.
- [ ] Every package passes its own acceptance gate before the next package starts.
- [ ] Every increment row names its open Lane on the existing Goal.
- [ ] Architecture docs, SPEC, terminal frame, and code agree at the end of each increment.
