# Seats on Shift Implementation Plan

> **For agentic workers:** implement this plan task-by-task in your own seat with
> superpowers:executing-plans (write work stays in a seat; no writing subagents). Steps use checkbox
> (`- [ ]`) syntax for tracking. One lane per increment (table below); claim it before you build.

**Goal:** Start puts a seat on shift; on shift it works its claimed lanes and answers what is directed
at it without a wake-rate gate, within hours and a daily budget a person set, and every human act
wakes a seat whether or not it is on shift.

**Architecture:** One new wake derivation (`shift`) beside `immediate`/`batched`/`work_order`/`dream`
in `claimWakeLeases`, fed by a new `shifts` row per seat per day and three new residency-policy knobs.
The hourly-cap and cooldown gates stop being seat-wide: they filter *candidates*, and a human-sent act
or a shift candidate passes them. Everything is read by the existing roster, CLI and MCP readers.

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), SQLite/Postgres migrations, vitest, React
(`packages/web`).

**Spec:** `docs/superpowers/specs/2026-11-02-seats-on-shift-design.md`

## Increments

| Increment                                                         | Lane                         | Tasks |
| ----------------------------------------------------------------- | ---------------------------- | ----- |
| 0. Design doc and this plan                                       | `01M6FY99PHGGMW7NBH57NSPJ0M` | —     |
| 1. Human acts pass the wake caps                                  | `01M6FXRD8CS10SRNB5ZCAERG42` | 1–3   |
| 2. Shift settings, the shift row, the claimed-work wake, the stop | `01M6H8BPVDT88VGYP24750EZJP` | 4–10  |
| 3. Recommendation at `ask`, `claim`/`free`, `shift_start: auto`   | `01M6H8C17EYMMT8KMDC0QBH0PK` | 11–13 |
| 4. /live shift settings; the seat learns its bounds over MCP      | `01M6H8C6QGRZ7Z3D65AD33SZRE` | 14–15 |

Each increment is its own branch and PR; increment 1 ships alone so that answering a seat's question
works before any shift machinery exists.

## Global Constraints

- No new runtime dependency (spec §Constraints). Hours use the team's stored IANA timezone through
  `isWithinWorkingHours` / `workingDayStart` / `lastWorkingDayEnd` in
  `packages/protocol/src/working-hours.wire.ts`.
- Every `@musterd/protocol` change is ADR-gated (hard rule 1). Each increment that touches protocol
  writes one ADR: number from `pnpm adr:next`, draft PR pushed before the ADR is written (ADR 223),
  with an Observability & Evaluation section.
- Wakes are decided in one place: `claimWakeLeases` in `packages/server/src/store/residency.ts`. No
  second actuator; `musterd host` changes only in what line it prints.
- Spend gates (ADR 611/636) are untouched and still hold a seat whoever woke it. The attempt cap
  (`attempt_cap`) still binds every wake.
- Machine-to-machine acts stay rationed: an act from an agent to any seat rides ADR 131's lanes and
  counts against cooldown and `hourly_cap`.
- Defaults from the spec, verbatim: `shift_budget_usd` **10**, `shift_start` **manual**, `autonomy`
  **ask**; unpriced wake counted as the seat's median priced wake of the last 7 days, else **$0.50**;
  stop reasons `hours_end` | `budget` | `no_work` | `stopped`; shift states `on` | `off` | `ending`.
- Vocabulary: lane, seat, Member, act (`pnpm vocab:check`). Docs and code agree in the same commit.
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`. Run one
  package's tests while iterating, never the full suite locally.

## Review Focus

1. **A human act to a halted seat (ADR 501)** must still not wake it: the halt check runs before any
   candidate is read. Test in Task 2.
2. **A human act to a seat over the team spend cap** is still held (`applyWakeHold`), not leased: the
   pass bypasses rate gates, never spend gates. Test in Task 2.
3. **The day boundary** is the team's calendar day in its timezone, so a budget spent at 23:50 Pacific
   resets at 00:00 Pacific, not UTC; and a `working_hours` row with a different timezone from the
   team's uses its own. Test in Task 6.
4. **A late cost report**: `residency.wake_cost` can land after the lease settles. The next poll
   must count it (budget read is a live sum, not a cached number). Test in Task 6.
5. **Start while a wake is already running** (`lease_live`) puts the seat on shift and leases nothing
   extra; the running wake's end is followed by the first shift wake. Test in Task 7.

---

## Increment 1 — Human acts pass the wake caps (lane `01M6FXRD8CS10SRNB5ZCAERG42`)

### Task 1: The ADR

**Files:**

- Create: `docs/decisions/NNN-human-acts-pass-the-wake-caps.md` (NNN from `pnpm adr:next`)
- Modify: `docs/decisions/131-*.md` (Consequences, dated note), `docs/decisions/779-*.md`
  (Consequences, dated note: `capped` is gone from Start everyone)

- [ ] **Step 1:** `git fetch origin main && git checkout -b feat/human-acts-pass-caps origin/main`;
      `pnpm adr:next`; commit an empty ADR stub and push as a draft PR with `Lane
      \`01M6FXRD8CS10SRNB5ZCAERG42\`.` in the body (ADR 223).
- [ ] **Step 2:** Write the ADR. Decision, in full: a wake candidate whose sending Member is `kind =
      'human'` (a verified answer, ADR 774; a quick action, ADR 779; a steer, ask, request_help or
      message a person sent) passes `hourly_cap` and `cooldown_ms`; `attempt_cap`, ADR 434's spent-act
      rule and the spend gates still bind; an act from an agent or service seat is unchanged; "Start
      everyone" no longer reports `capped`. Context cites the 2026-11-03 finding (lane `01M67EBYQ1`:
      ryder's second answer never woke). Observability: the `residency.woke` audit row gains
      `detail.human_pass: true` when the pass was used; eval is the ADR 779 wake-count by cause.
- [ ] **Step 3:** Add the dated Consequences notes to ADR 131 and ADR 779. `pnpm format:check`.
- [ ] **Step 4:** Commit `docs: ADR NNN human acts pass the wake caps (lane 01M6FXRD8CS10SRNB5ZCAERG42)`.

### Task 2: Rate gates filter candidates instead of skipping the seat

**Files:**

- Modify: `packages/server/src/store/residency.ts` (the loop at ~2460–2500: `hourly_cap` gate,
  `cooled`, `dueCandidates` call)
- Test: `packages/server/src/store/residency.test.ts`

**Interfaces:**

- Produces: `async function humanSent(db: Driver, teamId: string, candidate: WakeCandidate): Promise<boolean>`
  in residency.ts — true when `candidate.sender` names a Member of `kind === 'human'` on this team.
  Work-order and dream candidates (no `sender`) are false.
- Produces: `WakeCandidate` gains `human_pass?: true` (set by the filter; written to the
  `residency.woke` audit detail where the lease's detail is composed, ~2920).

- [ ] **Step 1: Failing tests** (pattern: the `hourly_cap` cases at residency.test.ts ~1710).

```ts
it('ADR NNN: a verified answer to the seat\'s own question passes the hourly cap', async () => {
  const { db, team, nick, ada } = await seed();
  await enroll(db, team, ada, HOST, { hourly_cap: 1 });
  await wakeOutcomeRow(db, team, 'Ada', 'past-0', 'residency.woke', Date.now() - 10 * 60_000);
  // Ada asked; nick answered (an `accept` reply from a human — the ADR 774 shape used by the
  // existing 'answer rides the line' test in this file).
  await askAndAnswer(db, team, ada, nick); // reuse that test's helper
  const orders = await claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);
  expect(orders).toHaveLength(1);
  expect(orders[0]!.sender).toBe('nick');
});
it('ADR NNN: a human steer passes the cooldown and the cap; an agent message does not', async () => {
  // seat at cap, one `steer` from nick and one `message` from an agent seat → exactly one lease, the steer's
});
it('ADR NNN: a human act to a halted seat does not wake it', async () => { /* halted_at set → 0 leases */ });
it('ADR NNN: a human act to a seat over the team spend cap is held, not leased', async () => {
  /* breach fixture from the ADR 611 tests in this file → 0 leases, a residency.wake_held row */
});
it('ADR NNN: the woke row says human_pass when the cap was bypassed', async () => { /* detail.human_pass === true */ });
```

- [ ] **Step 2:** `pnpm --filter @musterd/server test -- residency.test.ts -t "ADR NNN"` → FAIL
      (0 leases where 1 expected).
- [ ] **Step 3: Implement.** In the seat loop: replace the early `hourly_cap` `continue` with
      `const capped = (await wakesSince(…, now - 3_600_000)) >= policy.hourly_cap;`. Call
      `dueCandidates` with `batched: policy.lane !== 'interrupt'` (no longer `cooled &&`). After the
      work-order unshifts (which stay gated on `cooled`), filter:
      `candidates = candidates.filter(c => human || (!capped && (cooled || c.lane === 'immediate')))`
      where `human = await humanSent(db, teamId, c)`; set `c.human_pass = true` when `human && (capped || !cooled)`.
      If the filter leaves nothing and `capped`, `gate('hourly_cap')`; if nothing and `!cooled`,
      `gate('cooldown')`; else `gate('passed')`. The `provisioned`, `present`, `reclaimable`,
      `lease_live`, `snoozed` and halt checks stay above, untouched. Write `human_pass` into the woke
      audit detail beside `lane_id`/`edge`.
- [ ] **Step 4:** Run the file's whole suite: `pnpm --filter @musterd/server test -- residency.test.ts`
      → PASS, including the ADR 735 test "the hourly cap still holds" (its sender is an agent).
- [ ] **Step 5:** Commit `server: human-sent acts pass hourly_cap and cooldown (ADR NNN)`.

### Task 3: Start everyone never says `capped`

**Files:**

- Modify: `packages/server/src/protocol/quickActions.ts:105-135`, `packages/web/src/live/quickActions.tsx`
  (the `StartAllResults` copy), `packages/web/src/live/quickActions.test.ts`
- Test: `packages/server/src/protocol/quickActions.test.ts`

- [ ] **Step 1:** Change the quickActions.test.ts case that expects `capped` to expect `started` for
      an enrolled seat at its cap; run → FAIL.
- [ ] **Step 2:** `StartAllResult = 'started' | 'offline'`; delete the `seatAtHourlyCap` branch and
      the `capped` count in the audit detail; `seatAtHourlyCap` stays exported (the report reads it).
      Update the web summary copy and its test so no string says "capped".
- [ ] **Step 3:** `pnpm --filter @musterd/server test -- quickActions` and `pnpm --filter @musterd/web test -- quickActions` → PASS.
- [ ] **Step 4:** Fast gates; commit; `gh pr ready`; `gh pr merge --squash --auto --delete-branch`;
      after merge `lane_submit` with `{pr, sha, authorized_by: 'nick'}` and follow its reply.

---

## Increment 2 — Shift settings, the shift row, the claimed-work wake, the stop (lane `01M6H8BPVDT88VGYP24750EZJP`)

### Task 4: Protocol — the knobs, the derivation, the shift state

**Files:**

- Create: `docs/decisions/NNN-seats-on-shift.md` (stub pushed first, ADR 223; one ADR for all of
  increment 2 — the spec is its design record)
- Modify: `packages/protocol/src/residency.ts` (`ResidencyPolicySchema`, `WAKE_DERIVATIONS`, the
  `WakeGateState` enum), `packages/protocol/src/member.ts` (`MemberSummarySchema`)
- Test: `packages/protocol/src/residency.test.ts`, `packages/protocol/src/member.test.ts`

**Interfaces (produces):**

```ts
// residency.ts
shift_budget_usd: z.number().positive().max(100).default(10),   // the day's spend, USD
shift_start: z.enum(['manual', 'auto']).default('manual'),
autonomy: z.enum(['ask', 'claim', 'free']).default('ask'),
export const WAKE_DERIVATIONS = ['immediate', 'batched', 'work_order', 'dream', 'shift'] as const;
// WakeGateState gains 'off_shift' and 'shift_budget'
export const SHIFT_STOP_REASONS = ['hours_end', 'budget', 'no_work', 'stopped'] as const;
export const ShiftStateSchema = z.object({
  state: z.enum(['on', 'off', 'ending']),
  since: z.number().int(),                      // when this state began
  until: z.number().int().nullable(),           // hours end for an on-shift seat started inside hours
  budget_left_usd: z.number(),
  stop_reason: z.enum(SHIFT_STOP_REASONS).nullable(),
});
export type ShiftState = z.infer<typeof ShiftStateSchema>;
// member.ts, beside `residence`:
shift: ShiftStateSchema.nullish(),
```

- [ ] **Step 1:** Branch `feat/seats-on-shift`, ADR stub, draft PR with `Lane \`01M6H8BPVDT88VGYP24750EZJP\`.`
- [ ] **Step 2: Failing tests:** `ResidencyPolicySchema.parse({})` yields the three defaults;
      `shift_budget_usd: 0` and `101` refuse; `WakeDerivationSchema.parse('shift')` passes;
      `MemberSummarySchema.parse({...summary, shift: null}).shift` is null and an `on` state round-trips.
- [ ] **Step 3:** `pnpm --filter @musterd/protocol test` → FAIL; implement; → PASS.
- [ ] **Step 4:** Write the ADR (Decision = spec §"The shift model", §"Human acts…", §"Shift
      settings", §"What counts as claimed work" and the stop semantics, condensed; Observability:
      `shift.started|stopped` audit rows and the stop-reason split in `musterd report`). Commit
      `protocol: shift knobs, the shift derivation, ShiftState (ADR NNN)`.

### Task 5: The `shifts` table

**Files:**

- Modify: `packages/server/src/db/migrations.ts` (append `version: 81`), the Postgres side the way
  the version-80 entry does it (`packages/server/src/db/pg/`)
- Test: `packages/server/src/db/db.test.ts` (the migrations-apply case covers the new version)

- [ ] **Step 1:** Add the migration:

```sql
CREATE TABLE IF NOT EXISTS shifts (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,            -- team-local YYYY-MM-DD (localDate)
  state       TEXT NOT NULL CHECK (state IN ('on','off','ending')),
  started_at  INTEGER NOT NULL,
  started_by  TEXT NOT NULL,            -- a Member name, or 'auto'
  inside_hours INTEGER NOT NULL,        -- 1 when the Start fell inside working hours
  stopped_at  INTEGER,
  stop_reason TEXT CHECK (stop_reason IN ('hours_end','budget','no_work','stopped')),
  PRIMARY KEY (team_id, member_id, day)
);
```

- [ ] **Step 2:** `pnpm --filter @musterd/server test -- db.test.ts` → PASS. Commit
      `server: shifts table (migration 81, ADR NNN)`.

### Task 6: The shift store

**Files:**

- Create: `packages/server/src/store/shift.ts`
- Test: `packages/server/src/store/shift.test.ts`
- Modify: `docs/architecture/03-server.md` (file-tree line for `shift.ts`; `arch-trees:check`)

**Interfaces (produces):**

```ts
export interface ShiftRow { team_id; member_id; day; state: 'on'|'off'|'ending'; started_at; started_by; inside_hours: 0|1; stopped_at: number|null; stop_reason: ShiftStopReason|null }
export function shiftDay(hours: WorkingHours | null, now: number): string;       // localDate(hours?.timezone ?? 'UTC', now)
export async function startShift(db, teamId, member: MemberRow, by: string, hours: WorkingHours|null, now): Promise<ShiftRow>;
  // upserts today's row to `on` (a fresh `since`), inside_hours = isWithinWorkingHours(hours, now); audit `shift.started` {by}
export async function stopShift(db, teamId, member, reason: ShiftStopReason, now, opts: { leaseLive: boolean }): Promise<ShiftRow>;
  // state = leaseLive ? 'ending' : 'off'; audit `shift.stopped` {reason}
export async function settleEnding(db, teamId, member, now): Promise<void>;  // 'ending' → 'off' once no live lease
export async function shiftSpentTodayUsd(db, teamId, seatName, dayStartTs, now): Promise<number>;
  // sum of residency.wake_cost since dayStartTs for leases not wake_deferred (the dreamNight query shape,
  // residency.ts ~1900); an unpriced lease counts the median priced wake of the last 7 days, else 0.5
export async function shiftOf(db, teamId, member, hours, policy: ResidencyPolicy, now): Promise<ShiftState | null>;
  // null for a human or a seat with no row today; `until` = today's hours end when inside_hours, else null
export function shiftStopDue(row: ShiftRow, hours, spentUsd: number, policy, now): ShiftStopReason | null;
  // 'hours_end' when inside_hours && !isWithinWorkingHours(hours, now); 'budget' when spentUsd >= policy.shift_budget_usd; else null
```

- [ ] **Step 1: Failing tests** (one `it` each, names as given): start sets `on` and `inside_hours`;
      stop with a live lease yields `ending` and `settleEnding` turns it `off`; `shiftStopDue` returns
      `hours_end` for a 17:59→18:01 Pacific crossing and null for a Start at 20:00; `budget` at
      $10.00 spent and null at $9.99; `shiftSpentTodayUsd` counts a `wake_cost` row inserted after
      the lease settled (Review Focus 4) and prices an unpriced lease at the 7-day median, at $0.50
      with no history; `shiftDay` for 23:50 Pacific and 00:10 Pacific are different days while both
      are the same UTC day (Review Focus 3); a member `working_hours` with its own timezone wins over
      the team's.
- [ ] **Step 2:** → FAIL; implement; `pnpm --filter @musterd/server test -- shift.test.ts` → PASS.
- [ ] **Step 3:** Commit `server: shift store — start, stop, spend, stop-due (ADR NNN)`.

### Task 7: The shift derivation in `claimWakeLeases`

**Files:**

- Modify: `packages/server/src/store/residency.ts` (seat loop; `dueCandidates` is untouched)
- Test: `packages/server/src/store/residency.shift.test.ts` (new, beside `residency.dream.test.ts`)

**Interfaces:**

- Consumes: Task 6's store; Task 2's `humanSent` / candidate filter.
- Produces: `async function dueShiftWorkCandidates(db, teamId, teamSlug, member): Promise<WakeCandidate[]>`
  — one candidate `{ lane: 'batched', derivation: 'shift', lane_id }` per owned lane in state
  `claimed` or `active`, skipped when `isAwaitingAcceptance`, `ready_for_review`, `blocked`, `parked`,
  terminal, or when `laneMovedSinceLastWoke` is false for a lane this seat was last woken for; none at
  all when the seat has an open question of its own (`openQuestions` in `store/questions.ts` filtered to
  asker = seat); bounded by `WORK_ORDER_CONTINUATION_SUCCESS_CAP` per day like the dispatch edge.
- Produces: `function shiftLineFor(shift: ShiftState, lane: LaneRow): string` — exactly:
  `` You are on shift until ${HH:MM} (budget $${left} left). Your lane `${id}` "${title}" is claimed and not done — continue it. Check your inbox first. `` (`until` omitted → `You are on shift (budget … left).`).

- [ ] **Step 1: Failing tests:** on shift + one claimed lane + seat at cap → one lease, `derivation:
      'shift'`, the composed line above; off shift + claimed lane → no lease (gate `off_shift`); on
      shift, lane `awaiting_acceptance` → no lease and the seat stops `no_work`; on shift, an open
      own question → no shift lease (the answer wakes it, Task 2); hours end reached → no lease,
      row `off`, reason `hours_end`, one `status_update` from the board seat whose body is
      `` ryder is off shift: hours ended at 18:00; 2 lanes still claimed. ``; budget reached → `budget`;
      Start during a live lease → row `on`, zero new leases this poll (Review Focus 5); an agent's
      `message` to an on-shift seat at cap → not leased (still rationed).
- [ ] **Step 2:** → FAIL. **Implement** in the seat loop, after the halt/present/lease checks and
      before the rate gates: read `shift = await shiftOf(…)`; if `shift?.state === 'on'`, compute
      `shiftStopDue`; on a reason, `stopShift` (with `leaseLive`), post the board-seat line
      (`boardSeat(db, team)` → `routeEnvelope`-free insert like `lanePush.ts:214` does) and
      `gate(reason === 'budget' ? 'shift_budget' : 'off_shift')`, `continue`. Otherwise unshift
      `dueShiftWorkCandidates` and mark them `human_pass`-equivalent (they pass `capped`/`cooled` in
      Task 2's filter: extend the filter's `human ||` to `human || c.derivation === 'shift'`). When the
      seat is on shift and the filter yields nothing and no own question is open → `stopShift('no_work')`
      + the line `` ryder is off shift: no work left; nothing claimed. ``. Compose the line at the
      `composed_line` site via `shiftLineFor`. Audit `residency.woke` detail gains `derivation: 'shift'`.
- [ ] **Step 3:** `pnpm --filter @musterd/server test -- residency` (all residency files) → PASS.
- [ ] **Step 4:** Commit `server: the shift derivation — claimed work wakes an on-shift seat; stops with a reason (ADR NNN)`.

### Task 8: Start and Stop put a seat on and off shift

**Files:**

- Modify: `packages/server/src/protocol/route.ts:887` (the `quick_action.sent` site),
  `packages/server/src/protocol/quickActions.ts` (`startAll`, `quickActionLineFor`)
- Test: `packages/server/src/protocol/quickActions.test.ts`

- [ ] **Step 1: Failing tests:** a `steer` with `meta.quick_action: 'start'` from a human to an
      enrolled agent inserts today's `shifts` row `on` with `started_by` the person; `'stop'` sets
      `off` (`ending` when a lease is live) with reason `stopped` and sends no wake; `startAll`
      starts every enrolled agent's shift; the `start` line composed by `quickActionLineFor` begins
      with the shift sentence from `shiftLineFor` when a shift is on.
- [ ] **Step 2:** Implement at route.ts:887: `if action === 'start'` → `startShift`; `'stop'` →
      `stopShift(…, 'stopped', …)` and the envelope is delivered but is **not** a wake candidate
      (add `quick_action === 'stop'` to the `pendingInterrupts` exclusion the same way a dream-sent
      act is excluded, `dreamSentIds`). Extend the `quick_action` meta enum where it is validated
      (grep `quick_action: z.enum` in protocol) to include `'stop'`.
- [ ] **Step 3:** → PASS. Commit `server: Start opens a shift, Stop ends it (ADR NNN)`.

### Task 9: Same state on the roster, the CLI and MCP

**Files:**

- Modify: `packages/server/src/transport/http.ts:~2799` (roster seat gains `shift`),
  `packages/cli/src/commands/residency.ts` (`POLICY_FLAGS_USAGE`, `RESIDENCY_FLAGS`, the sparse
  policy collector; `status` prints the shift line), `packages/cli/src/commands/status.ts` (one line
  per on-shift seat), `packages/web/src/live/RosterPanel.tsx` + `quickActions.tsx` (shift line; a
  **Stop** button beside Start when `shift.state === 'on'`), `packages/mcp/src/client.ts`
  (`team_status` row text)
- Test: `packages/server/src/transport/residency-http.test.ts`, `packages/cli/src/commands/residency.test.ts`,
  `packages/web/src/live/quickActions.test.ts`

- [ ] **Step 1: Failing tests:** roster JSON carries `shift: {state:'on', until, budget_left_usd,
      stop_reason:null}` for an on-shift agent and `shift: null` for a human; `musterd residency
      policy --shift-budget 25 --shift-start auto --autonomy claim` writes exactly those three keys;
      `--shift-budget 0` is refused with the schema's message; `residency status` renders
      `on shift until 18:00 · $4.10 left` and `off shift (hours_end 18:00)`; the web bar renders
      Stop only when on shift.
- [ ] **Step 2:** Implement. Flag names: `--shift-budget <usd>`, `--shift-start manual|auto`,
      `--autonomy ask|claim|free`. New CLI verbs `musterd start <seat>|--all` and `musterd stop <seat>`
      are thin aliases that send the quick-action steer (same envelope as `quickActions.tsx:32`).
      Roster: `shift: await shiftOf(…)` for agent rows. MCP `team_status` appends ` · on shift until
      18:00` / ` · off shift: budget` to the seat line.
- [ ] **Step 3:** Package tests → PASS; fast gates. Commit `cli/web/mcp: shift state and knobs on every surface (ADR NNN)`.

### Task 10: Docs, the seed and the hand-over

**Files:**

- Modify: `content/roadmap.data.ts:~800` ("Schedule & lifecycle enforcement": hours are now enforced
  for shifts; `pnpm roadmap:gen`), `docs/architecture/03-server.md` (residency.ts line: the `shift`
  derivation), `docs/decisions/494-*.md` (Consequences: dreams and shifts share `working_hours`),
  `ROADMAP.md` (generated)
- Ops, after merge: the revive seed's `working_hours` → `{ timezone: America/Los_Angeles, days:
  [mon..fri], start: '09:00', end: '18:00' }` via `team_seed_update` (nick's 2026-11-03 call).

- [ ] **Step 1:** Docs edits; `pnpm format:check && pnpm vocab:check && pnpm intents:check`.
- [ ] **Step 2:** Commit, `gh pr ready`, auto-merge, `lane_submit`, follow its reply. Then the seed
      change, and one `status_update` on the lane naming the new window.

---

## Increment 3 — Recommendation, `claim`/`free`, `shift_start: auto` (lane `01M6H8C17EYMMT8KMDC0QBH0PK`)

### Task 11: The recommendation at `ask`

**Files:**

- Create: `packages/server/src/store/shiftRecommend.ts`; Test: `shiftRecommend.test.ts`
- Modify: `packages/server/src/store/residency.ts` (Task 7's `no_work` branch)

**Interfaces (produces):**

```ts
export async function recommendFor(db, teamId, teamSlug, member): Promise<Array<{ id: string; title: string; why: string }>>;
  // up to 3 unowned, non-terminal lanes ranked by the same per-member relevance team_next uses
  // (the ranking in packages/server/src/store/ that team_next's "up next" reads — reuse, do not copy)
export async function askRecommendation(ctx, team, member, items): Promise<string /* question act id */>;
  // one team_question (ADR 773) from the seat to the team's humans:
  // `My claimed lanes are done. I can take: 1) … 2) … 3) …. Which, or none?` — choices are the lane ids plus "none"
```

- [ ] **Step 1: Failing tests:** on shift, nothing claimed, three open lanes → one question act and
      no `no_work` stop; an answer naming a lane → the seat is woken (Task 2's human pass) with the
      line `` nick picked `01M…` — claim it (lane_claim) and continue. ``; an answer "none" →
      `no_work` stop; a second poll with the question still open → nothing (no re-ask, no stop).
- [ ] **Step 2:** Implement; the `no_work` branch becomes: recommend if `autonomy === 'ask'` and
      items exist and no open recommendation; else stop `no_work`. Tests → PASS. Commit.

### Task 12: `claim` and `free`

- [ ] **Step 1: Failing tests:** `autonomy: 'claim'` with a goal allowlist (`meta.goals` on the
      enrollment override — add `autonomy_goals: z.array(z.string()).optional()` to the policy in this
      increment's ADR note) claims the top item on a listed goal and wakes with the claimed-work line;
      `free` claims the top item on any goal; neither claims a lane with a risk tag the seat's role may
      not take.
- [ ] **Step 2:** Implement with the lane store's claim function (the one `lane_claim` routes to in
      `packages/server/src/protocol/`); audit `shift.claimed`. → PASS. Commit.

### Task 13: `shift_start: auto`

- [ ] **Step 1: Failing test:** a seat with `shift_start: 'auto'` and no row today is started by
      `'auto'` on the first poll at or after `workingDayStart`; never outside hours; never twice a day.
- [ ] **Step 2:** Implement at the top of the seat pass (before `shiftOf`). → PASS. Commit; PR;
      `lane_submit`.

---

## Increment 4 — /live settings and the seat's own view (lane `01M6H8C6QGRZ7Z3D65AD33SZRE`)

### Task 14: /live shift settings

**Files:** `packages/web/src/live/` settings view where the residency knobs are edited today (the
`residency policy` form), `packages/server/src/transport/http.ts` (the policy PUT already accepts the
sparse override — the three new keys flow through the schema).

- [ ] **Step 1: Failing test:** the form renders budget / start / autonomy with the effective value
      and a starred override; saving sends only the changed keys.
- [ ] **Step 2:** Implement; `pnpm --filter @musterd/web test` → PASS. Commit.

### Task 15: The seat learns its bounds

**Files:** `packages/mcp/src/client.ts` (`team_next` preamble), `packages/server/src/transport/http.ts`
(the `next` route includes `shift`).

- [ ] **Step 1: Failing tests:** `team_next` for an on-shift seat opens with `On shift until 18:00,
      $4.10 left.`; for a seat whose row is `ending`: `Your shift is ending (stopped by nick): finish
      the step you are on and end your turn.`; nothing for a human.
- [ ] **Step 2:** Implement; package tests → PASS; fast gates; PR; `lane_submit`; close the goal's
      remaining lanes with `follows_up` naming anything left.

## Self-review notes

- Spec coverage: shift model (7), human acts (2), settings (4, 9, 14), Start/Stop (8), autonomy
  (11–12), hours reuse (6, 10), stop reasons and the board-seat line (7), same state everywhere (9,
  15), `ending` (6–8, 15), budget never unset and the raise-ask after a `budget` stop (4; the raise
  question is Task 11's `askRecommendation` shape with a single "raise to $20?" choice — add it there),
  unpriced wake pricing (6), agent acts still rationed (2, 7).
- Names used across tasks: `humanSent`, `shiftOf`, `startShift`, `stopShift`, `shiftStopDue`,
  `shiftSpentTodayUsd`, `dueShiftWorkCandidates`, `shiftLineFor`, `recommendFor`, `askRecommendation`.
