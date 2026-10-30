# Seats ask, you answer — phase 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in your own seat, one lane per increment. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four quick actions (Start, Check inbox, Check PR, Resume) work from `/live` and the phone. A seat hears about its own PR merging or going red without being asked. Each person sets how loud questions are, per channel and per seat.

**Architecture:**
- **Quick actions:** a quick action is a human's `steer` carrying `meta.quick_action`. A steer already rings an idle session and is an immediate wake reason, so no new act and no new rail is needed. The daemon composes the line from the action, never from the body (ADR 088 §4).
- **PR events:** a hub sweep reads each live lane's PR through the hub's `gh`. On a merge or a red check it sends the owner a daemon-composed `message` carrying `meta.pr_event`, which the wake rail admits.
- **Notification preferences:** stored per member and applied wherever a question is delivered.

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), SQLite/pglite, the `gh` CLI on the hub (no new npm dependency), React (`/live`, miley), Swift (phone, cider).

**Spec:** `docs/superpowers/specs/2026-10-30-seats-ask-you-answer-design.md` — Quick actions; Notifications; How it works §4. Phase 1: `docs/superpowers/plans/2026-10-30-seats-ask-you-answer.md`.

## Increments

| # | Lane | Tasks | Owner |
| --- | --- | --- | --- |
| 2a | `01M67E3TYER5HKEEBBERH8FRYR` | 1–3 | fifty |
| 2b | `01M67E4EB8V9TT8KFG6PCK3MKV` | 4–5 | fifty |
| 2e | `01M67E5WWB24MVA2EF6NGV8BEC` | 6 | fifty |
| 2c | `01M67E4ZVYJ2ZM8X16AZ37V7VT` | 7 | miley |
| 2d | `01M67E5DM8H4EJJ5JVZ9RBNJG1` | 8 | cider |
| 2f | `01M67E6BEVGDG2AYQ0PTAEYST8` | 9 | miley |

Order: 2a → (2b, 2e) on the backend; 2c and 2d start once 2a's wire has merged; 2f starts once 2e's has. UI and phone work go to miley and cider by `handoff` (nick, 2026-10-30).

## Global Constraints

- Hard rule 1: the `meta.quick_action`, `meta.pr_event` and preference schemas land after their ADR (Task 1), in the same increment or later.
- **No body text enters a session.** A quick action's line carries only:
  - the action;
  - the person's name;
  - ids: lane, PR number, branch;
  - daemon-read states: the PR state and check conclusion.

  The memory headline is the seat's own text, but it is referred to, never quoted: the line says "read your seat memory".
- **Only a human member may send a quick action.** A seat sending `meta.quick_action` is refused with `forbidden`. There's no fan-out to other teams.
- **`gh` is optional.** Where the hub has no `gh` login, Check PR and the PR watch say so on the card and to the seat (`pr_state: 'unknown', reason: 'no_gh'`). They never fail silently.
- Run only the test file you touch. CI is the authority.
- Per increment: branch from `origin/main`, PR body line `` Lane `<id>`. ``, `gh pr merge --squash --auto --delete-branch`, `lane_submit`, then detach and `git branch -D`.
- New source files get a described line in their `docs/architecture` tree. Any byte the primer or the tool list gains is justified in `docs/perf/context-budgets.json`.

## Review Focus

1. **"Start everyone" with twelve seats**, half of them headless on the box. Each gets one immediate lease. The residency hourly cap still applies, and a capped seat shows "capped" on the card instead of silently not starting. Pinned in Task 3.
2. **A Check PR for a seat with no lane, or a lane with no PR yet.** The line says so ("no PR on your lane yet") rather than inventing one. Pinned in Task 2.
3. **The PR watch seeing the same merged PR twice** (two sweeps, or a fold): one event per (lane, PR, state), keyed so a restart never repeats it. Pinned in Task 5.
4. **A person who set "never buzz" for a seat, and that seat raises a blocking question.** The preference wins, but the card still lands in the list. Quiet hours hold non-blocking questions only. Pinned in Task 6.
5. **A quick action to a seat that is mid-turn.** It rides the steer's existing newest-wins rule (ADR 103): a second Resume replaces the first, never stacks. Pinned in Task 2.

---

## Increment 2a — quick actions on the wire

### Task 1: ADR — quick actions, PR events, notification preferences

**Files:** Create `docs/decisions/NNN-quick-actions-and-pr-events.md` (NNN from `pnpm adr:next`; push a draft PR first, ADR 223). Modify `SPEC.md` (a new Appendix A section) and `docs/architecture/02-protocol.md`.

**Decision content:**
- `meta.quick_action: 'start' | 'check_inbox' | 'check_pr' | 'resume'` on a `steer` from a human member to one seat. The body is ignored for the line.
- The daemon composes the wake line and the idle-seam line per action (`composeQuickActionLine`, Task 2). Every other steer is unchanged.
- **Start everyone:** `POST /teams/:slug/quick-actions/start-all` sends one `start` steer per enrolled agent seat, from the caller. It is audited once, as `quick_action.start_all`, with the count.
- **PR events:** `meta.pr_event: { lane, pr, state: 'merged' | 'ci_red' | 'ci_green', checks_url? }` on a daemon-composed `message` from the board seat (ADR 649) to the lane's owner. It is a wake reason on both rails.
- **Preferences:** `question_notify` per member:
  - `channels: { app | slack | browser | email: { on, level: 'buzz' | 'quiet' } }`;
  - `seats: { [seat]: 'always' | 'never' }`.
  - Defaults: phone buzzes for `blocking` only; quiet otherwise; nothing buzzes while the person is on `/live`; quiet hours come from the away-channel settings.
- **Observability:** audit `quick_action.sent {action, seat}`, `pr_event.sent {lane, pr, state}`, `question.notify_suppressed {reason}`. Falsifier: Check PR used more than once a day per seat after 2b lands, which would mean the automatic watch isn't doing its job.

- [ ] **Step 1:** Run `pnpm adr:next`, open a draft PR, write the ADR, and run `pnpm format:check`.

### Task 2: protocol + line composition

**Files:** Create `packages/protocol/src/quickAction.ts` (+ `.wire.ts`, + test); modify `envelope.ts` (rules), `doorbell.wire.ts` (a `pr_event` message rings its owner).

**Interfaces — Produces:**
- `QUICK_ACTIONS`, `QuickActionSchema`, `PrEventSchema`
- `composeQuickActionLine(p: { team: string; seat: string; person: string; action: QuickAction; lane?: string; branch?: string; pr?: { number: number; state: string; checks: string } | { unknown: 'no_pr' | 'no_gh' }; actId: string }): string` — passes `isPushableLine`

**Tests:**
- The envelope accepts `steer + meta.quick_action:'resume'` and refuses `message + meta.quick_action`.
- Each action's line is exact (pin all four).
- `check_pr` with `{unknown:'no_pr'}` reads "no PR on your lane yet".
- No line contains the steer's body.
- A newer `resume` steer supersedes an older one in `pendingInterrupts` (the existing steer rule; a regression pin).

- [ ] Steps: write the failing tests, run `pnpm --filter @musterd/protocol test quickAction`, implement, re-run, commit.

### Task 3: server — route check, line on both rails, Start everyone

**Files:** Modify `packages/server/src/protocol/route.ts` (refuse a non-human `quick_action`), `packages/server/src/store/residency.ts` (the order builder uses `composeQuickActionLine` when the act carries one), the idle interrupt-check composer, and a new route for start-all (outside `transport/http.ts` if that file is still held; add a small `transport/quickActions.ts` mounted from it otherwise). Create `packages/server/src/store/quickActions.ts`.

**Interfaces — Produces:** `quickActionContext(db, teamId, seat): Promise<{ lane?: string; branch?: string; pr?: … }>` (lane from the seat's one live claim; PR state from Task 4's cache when present).

**Tests:**
- A seat sending a quick action gets `403`.
- A headless resident seat gets one lease whose `composed_line` equals the composed quick-action line.
- start-all over 3 agent seats writes 3 steers and 1 audit row.
- A seat over its hourly cap yields `capped` in start-all's per-seat result.

- [ ] Steps as above; commit; PR (lane 2a); auto-merge; `lane_submit`. Then **hand 2c to miley and 2d to cider** with the wire summary.

---

## Increment 2b — the PR watch

### Task 4: `gh` reader with a visible failure

**Files:** Create `packages/server/src/github/prState.ts` (+ test).

**Interfaces — Produces:** `readPrState(repoRoot: string, branchOrPr: string | number, run?: Runner): Promise<{ number: number; state: 'open' | 'merged' | 'closed'; checks: 'green' | 'red' | 'pending' | 'none' } | { unknown: 'no_pr' | 'no_gh' | 'gh_error' }>`. Shells out to `gh pr view --json number,state,statusCheckRollup` with a 5 s timeout; `Runner` is injected for tests.

**Tests:**
- Parses a merged PR, a red rollup, and a pending one.
- `gh` missing (ENOENT) returns `{unknown:'no_gh'}`.
- "no pull requests found" returns `{unknown:'no_pr'}`.
- A timeout returns `gh_error`.

### Task 5: the sweep

**Files:** Create `packages/server/src/protocol/prWatch.ts` (+ test). Hook it into the reaper beside the undelivered-answer sweep (hub only). Add a ladder rung for `pr_watch(team_id, lane_id, pr, state, sent_at, PRIMARY KEY(team_id, lane_id, pr, state))`.

**Behaviour:**
- Every `PR_WATCH_SWEEP_MS` = 60 s, read each lane in `claimed | active | blocked | awaiting_acceptance` that has a branch.
- On `merged`, `ci_red`, or `ci_green` after a red, send one `pr_event` message to the owner. The `pr_watch` key makes it once only.

**Tests:**
- A merged PR sends exactly one event across two sweeps and a restart.
- A red then green sends two.
- `no_gh` sends nothing and records one `pr_watch.unavailable` audit row per hour.
- A lane with no owner is skipped.

- [ ] Steps; PR (lane 2b); auto-merge; `lane_submit`.

---

## Increment 2e — notification preferences

### Task 6: store and apply

**Files:** Create `packages/server/src/store/questionNotify.ts` (+ test). Add a ladder rung for the `question_notify_json` member column. Add a GET/PUT self route beside the away-channel settings route. Apply the result in the phone delivery path (`appAdapter.ts`, cider's 1f, so coordinate) and in the `/live` doorbell sink.

**Interfaces — Produces:** `notifyDecision(prefs, ctx: { channel; seat; blocking; activeOnLive; inQuietHours }): 'buzz' | 'quiet' | 'hold'`.

**Tests (the table):**
- Defaults: blocking → `buzz`; non-blocking → `quiet`.
- Active on `/live` → `quiet`.
- Quiet hours: non-blocking → `hold`; blocking → `buzz`.
- A seat set to `never` → `quiet`, even when blocking. The card still lands.
- A seat set to `always` → `buzz`.
- A channel `off` → `hold`.

- [ ] Steps; PR (lane 2e); auto-merge; `lane_submit`. Then **hand 2f to miley**.

---

## Increments 2c, 2d, 2f — UI and phone (by handoff)

### Task 7 (miley, 2c): the quick-action bar on the triage card and each roster seat, plus Start everyone with per-seat results ("started", "capped", "offline"). Copy follows the brand glossary.

### Task 8 (cider, 2d): the same four actions on the phone, per seat and on the question card.

### Task 9 (miley, 2f): Settings → You, question notifications: channel toggles with buzz/quiet, per-seat always/never, and quiet hours. Uses Task 6's routes.

Each is handed off with the wire summary from its backend increment; acceptance is theirs.
