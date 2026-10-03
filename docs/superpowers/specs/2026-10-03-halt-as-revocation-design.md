# Halt as revocation — design

- Date: 2026-10-03
- Author: dolly (lane `01M3TAKKMMSTV14A3NVVWFCJT8`), from the design conversation with nick on
  2026-10-03
- Goal: `launch`
- Status: approved by nick 2026-10-03; recorded as
  [ADR 501](../../decisions/501-halt-as-revocation.md)
- Builds on: [`2026-09-01-human-surface.md`](../../design/2026-09-01-human-surface.md) §3 (DECIDED:
  halt is in, human-only, two builds — revoke-the-lease first), ADR 150 (the PreToolUse gate),
  ADR 337/347 (session leases), ADR 131 (residency and wake leases), ADR 463 (sponsor-scoped
  authority), ADR 456 (the sponsored cascade), ADR 083 (advisory posture, hard attribution)

## 1. Outcome

A human on the team stops an agent seat mid-work with one command or one button, and the seat
stays stopped until a human lifts it. The halted seat cannot act on musterd, cannot be woken, cannot
re-claim its way back, and its next tool call in any harness is refused with the halter's name and
reason. The halt and the resume are both on the audit ledger and visible to the team and to the
halted seat.

Nothing is controlled. A permission is withdrawn, and every surface that already checks that
permission refuses. This is the first of the two builds §3 of the human-surface design decided on:
revoke-the-lease. Esc-into-the-harness is not in this spec.

## 2. Boundaries

- **Human-only.** An agent seat can never halt anything. The constraint the human-surface design
  named as the real line (agent-halts-agent is the hub-and-spoke failure) is enforced on the caller's
  kind, server-side.
- **Sponsor-scoped, admin-wide (nick, 2026-10-03).** A non-admin human halts only the agents they
  sponsor (`sponsored_by === caller.id`, the ADR 463 model). An admin halts any agent seat. The CLI
  and /live never decide this; the server does, on the caller's kind and sponsorship.
- **Agents only as targets.** A human seat is never halted. A human is removed or disabled through
  the existing governance path.
- **Tool boundaries only — the honest limit, stated in every surface.** The gate and the lease act at
  tool-call boundaries. Mid-generation is unreachable, and a ten-minute build is one tool call with
  no boundary inside it. Halt is a bounded-window stand-down, not an emergency brake.
- **Temporary, not lifecycle.** `halted` is a standing a human lifts, carrying who and why. It is not
  an `account_status` like `disabled` or `banned`: those are governance states on the member's
  existence; halt is an operational hold on a member who stays on the roster, keeps its role, keeps
  its lanes.
- **No process control.** The server does not signal, kill, or speak into a harness process. The
  nudge relay and any future Esc channel are out of scope.

## 3. What already exists, from the code

| Mechanism                                                                                   | Where                                                              | Halt reuses it as |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- |
| Session leases: minted per presence, 5-min TTL, renewed over WS; `revokeMemberSessionLeases` | `packages/server/src/store/session-leases.ts`                      | the revocation    |
| Agent HTTP auth refuses a missing or dead lease (`SessionLeaseRefused`)                     | `packages/server/src/store/members.ts` (auth path)                 | the refusal       |
| `memberStandingRefusal` — one place every authenticated call checks standing                | `members.ts:549`                                                   | the halted check  |
| Hub eviction with a reason string (`ctx.hub.remove(connId, msg)`)                           | member-remove route, `packages/server/src/transport/http.ts`       | the eviction      |
| Wake leases (`claimWakeLeases`), the residency kill switch (`revokeResidency`)              | `packages/server/src/store/residency.ts`                           | the wake refusal  |
| ADR 150 gate: `musterd gate check --stdin` → `POST /teams/:slug/gate`, fails open           | `packages/cli/src/commands/gate.ts`, `http.ts` gate route          | the tool refusal  |
| `authAdmin` / `authAdminOrSponsorOf` → `sponsorScoped`                                      | `http.ts` authorizers                                              | who may halt      |
| `member.*`, `presence.session_ended`, `agent_session_lease.revoked` audit verbs             | `packages/server/src/store/audit.ts`, `packages/protocol/src/audit.ts` | the ledger     |

Only one caller revokes session leases today (credential rotate). Halt is the second, and the
first that a human invokes by name.

## 4. Design

### 4.1 The standing

Three nullable columns on `members`: `halted_at`, `halted_by` (member id of the human), and
`halted_reason` (text, required on halt, ≤ 280 chars). A member is halted when `halted_at` is set.
Resume clears all three. No new table and no new enum value: standing is derived, the same way
`left_at` derives "has left".

`memberStandingRefusal` gains one branch, evaluated after `left_at` and before `account_status`:
halted → `forbidden`, message `halted by <human>: <reason>`. Every authenticated call a halted
seat makes gets that sentence, so no route needs its own check.

The protocol `Member` shape (roster, `team_members`, `/live`) gains an optional
`halted: { at, by, reason } | null`. This is the schema change the ADR gates.

### 4.2 Halt

`POST /teams/:slug/members/:name/halt` `{ reason }`, authorized by `authAdminOrSponsorOf` with
two extra server-side conditions: the caller is a **human** (kind, not role), and the target is an
**agent**. Refusals, in this order and with these codes: target not found → `not_found`; target
human → `forbidden` "a human seat is never halted"; caller agent → `forbidden` "halt is
human-only"; non-admin caller who does not sponsor the target → `forbidden` "you may halt only
agents you sponsor"; already halted → `conflict` "already halted by <human> at <time>" (no
re-halt, no reason overwrite — resume first).

On success, one transaction:

1. set `halted_at / halted_by / halted_reason`;
2. `revokeMemberSessionLeases(member)` — every live lease, one `agent_session_lease.revoked`
   audit row each, `detail.cause: 'halt'`;
3. evict every live presence of the seat from the hub with the reason string
   `halted by <human>: <reason>` (the message the agent's harness sees on the socket close);
4. mark each presence ended (`markSessionEnded`), emitting `presence.session_ended` with
   `detail.cause: 'halt'` so the ADR 164 ladder reads it as a human stop, not a dead client;
5. settle any unspawned wake lease for the seat as `cancelled` with `detail.cause: 'halt'`;
6. audit `seat.halted` — actor the human, subject the seat, `detail: { reason, sponsor_scoped,
   leases_revoked, presences_evicted }`;
7. deliver one `steer` act from the human to the seat, body `halted: <reason>`, so the halt is
   in the seat's inbox when it resumes (visibility per ADR 407: team-wide, addressed to the seat).

Residency enrollment is **not** revoked. The seat stays enrolled; while halted, the residency
scheduler produces no wake candidate for it (`buildWakeCandidates` filters on `halted_at IS
NULL`), and `claimWakeLeases` never hands a host a halted seat. Lifting the halt restores
wakeability with nothing to re-enroll.

### 4.3 While halted

- **Re-claim is refused.** The claim handshake gets a new refusal code `halted`, alongside
  `disabled`/`banned`, carrying the same sentence. `musterd claim`, `team_join`, and the OAuth
  connect path all go through it.
- **Existing credential stays valid.** Halt revokes leases, not credentials; a halted seat does not
  need re-minting to come back. (A compromised seat is a `disable`, not a halt.)
- **The ADR 150 gate refuses.** `POST /teams/:slug/gate` runs under member auth, so the halted
  check already fires there; the gate turns a `forbidden` whose message starts `halted by` into
  `emitDeny` with `permissionDecisionReason: "halted by <human>: <reason> — musterd halt lifted by
  a human resumes this seat"`. This is the one place the gate stops failing open: a halted seat's
  tool call is denied, not allowed-with-warning. Every other failure mode of the gate keeps its
  fail-open behavior.
- **Lanes and roles are untouched.** Lane contention keeps showing the halted seat as owner, with a
  `halted` marker on the board row, so a teammate who needs the lane asks the human to resume or
  reassign rather than finding the lane silently freed.
- **The roster shows it.** `team_members`, `musterd status`, and the /live roster render the seat
  as `halted · by <human> · <reason> · <age>`; the halted seat's own orientation (`team_next`,
  `team_inbox_check` after resume) leads with the halt line.

### 4.4 Resume

`POST /teams/:slug/members/:name/resume`, same authorizer and the same caller-kind check as halt.
Any human who could have halted the seat may resume it, not only the halter: an admin resumes
anything; a sponsor resumes their own agent. Not halted → `conflict`. On success: clear the three
columns, audit `seat.resumed` (actor, subject, `detail: { halted_by, halted_reason, held_ms }`),
deliver one `steer` from the resumer to the seat, body `resumed`. The seat's next claim mints a
fresh lease; residency wakes it on the next addressed act as it would any seat.

### 4.5 Cascades

- **Sponsor loses standing** (removed, disabled, banned): ADR 456's cascade already disables the
  sponsored chain; halt state is irrelevant and left as-is on the row for the record.
- **Halter loses standing or is demoted:** the halt stays. A halt is a fact on the seat, not a
  lease on the halter; any eligible human lifts it.
- **Member removed while halted:** `leaveMember` runs as today; the halt columns stay on the row.
- **Role changes while halted:** permitted; the seat is still halted.

### 4.6 Surfaces

- **CLI:** `musterd halt <seat> --reason "<text>"` and `musterd resume <seat>`; `musterd status`
  and `musterd next` render the halted line; `musterd gate check` emits the deny. Output follows the
  Figma terminal frames (hard rule 2) — one frame each for halt, resume, and the halted roster
  line, added to `figma-brief-terminal.md` in the same PR.
- **/live:** a halt button on an agent's roster card, enabled only when the server says the viewer
  may halt it (`Member.can_halt`, computed server-side per viewer, never from the viewer's role in
  the client); a reason prompt; the halted badge; a resume button in its place while halted.
- **MCP:** no `team_halt` tool. A tool an agent can call would be a tool an agent can call; the
  human-only constraint is cheaper to keep when the surface does not exist. Humans on /live and the
  CLI have what they need.

### 4.7 Protocol changes (ADR-gated)

- `Member` gains `halted: { at: number; by: string; reason: string } | null` and
  `can_halt: boolean` (viewer-relative, present on roster reads only).
- Claim-handshake refusal codes gain `halted`.
- Audit verbs `seat.halted` and `seat.resumed` join the reference tuple (open-string by ADR 074, so
  this is documentation, not a breaking change).
- `presence.session_ended` and `agent_session_lease.revoked` gain an optional `detail.cause` with
  `'halt'` as the first value.

## 5. Alternatives considered

- **Reuse `account_status: 'disabled'`.** Rejected: disable is governance (the seat's existence
  and credentials), cascades to sponsored chains, and is read by ADR 456 as a loss of standing.
  A halt must be lifted without re-minting anything and must not cascade.
- **Any human may halt, attribution only (izzo's recommendation).** Deferred, not rejected. Nick's
  2026-10-03 decision is sponsor-scoped with admins wide; the second-human dogfood (human-surface
  §5) is the evidence that would reopen it. Widening is a one-line authorizer change and a note in
  the ADR's Consequences.
- **Authority follows the wake.** Rejected in §4 of the human-surface design: the person present
  is the one who cannot act.
- **Halt as a lane state.** Rejected: halt is about a seat, not a lane; a seat holds several lanes
  and a lane changes hands.
- **Kill the harness process.** Out of scope by decision; the second build has its own argument.

## 6. Limits and verification shape

- **The window.** Halt lands at the next tool boundary or the next musterd call, whichever is
  first. For a seat mid-tool, that is the length of the tool call. The audit row records when the
  halt was set; `presence.session_ended` records when the socket went; the gap is the measured
  window and is reported on the halt's CLI output as `effective at next tool boundary`.
- **The gate is optional.** A harness with no PreToolUse hook (Cursor today) gets the lease
  revocation and the eviction, not the tool denial. The halted seat can still run local tools until
  it next touches musterd. The CLI output for halt says which harness the seat's live presence was
  on and whether that harness carries the gate.
- **Tests:** server — halt revokes every lease, evicts every presence, refuses re-claim, refuses
  the gate, yields no wake candidate, admits only humans, admits a sponsor for own agents only,
  refuses re-halt, resume restores all of it; audit rows and causes present. CLI — snapshot tests
  on the three frames. Web — the button renders from `can_halt` alone.
- **Dogfood acceptance:** a human halts a seat that is mid-lane on revive; the seat's next tool
  call is denied with the reason; `musterd resume` brings it back and its inbox leads with the
  halt. The gap between `seat.halted` and `presence.session_ended` is recorded in the wiki.

## 7. Increments (each a lane)

1. **Schema + server** — lane `01M3TAKKMMSTV14A3NVVWFCJT8`: columns, standing refusal,
   halt/resume routes with authorizers, lease revocation, eviction, wake-candidate filter, claim
   refusal, audit — with the ADR.
2. **Gate + CLI** — lane `01M41DRSVEHVMEVY96NG5JF08S`: `musterd halt` / `resume`, the gate
   deny, status and next lines, Figma frames.
3. **/live** — lane `01M41DRWWY4EE5CGRCJMZGDNVF`: `can_halt`, the button pair, the badge.
4. **Dogfood read** — lane `01M41DRZTYJ2R5X41CCCT0EXF1`: one real halt on revive, window
   measured, wiki page.

## 8. Not in this spec

- Esc-into-the-harness (the second build; a live channel into a process is a new security
  surface and needs its own argument).
- Halting a human seat; halting by an agent; a `team_halt` MCP tool.
- Any-human halt with attribution only — waits on the second-human dogfood.
- Auto-expiry of a halt. A halt is lifted by a human or it stays.
