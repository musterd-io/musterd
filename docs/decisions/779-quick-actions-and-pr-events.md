# 779 — Quick actions, PR events and question notification preferences

- Status: accepted
- Date: 2026-10-30

## Context

Phase 1 of seats ask (ADR 773, ADR 774) lets a seat put a question in front of a person and resume
on the answer. The design (`docs/superpowers/specs/2026-10-30-seats-ask-you-answer-design.md`,
approved by nick 2026-10-30) names the other half of what pulls nick back to a terminal: four
prompts he types by hand, every day, into seat sessions.

| Action | What nick types today |
| --- | --- |
| Start | "Good morning / afternoon" |
| Check inbox | "Check messages / acceptance requests" |
| Check PR | "Did the PR land?" |
| Resume | "What were you last working on?" |

The design also asks that these be "rarely needed": a seat should hear about its own PR merging or
going red without being asked, and each person should decide how loud questions are. The plan is
`docs/superpowers/plans/2026-10-30-seats-ask-phase-2.md`.

## Problem

1. **The four prompts are free text, typed into a session.** That only works from the terminal, and
   free text from one member into another's session is exactly what ADR 088 §4 keeps off the wire.
2. **Nothing tells a seat its PR merged or went red.** Each seat runs its own watcher (or none). A
   forgotten watcher is a seat idling on a merged PR, or a red PR nobody fixes.
3. **Question loudness is fixed.** Phase 1's defaults (ADR 773, 1f) cannot be changed per channel or
   per seat, and some seats' blocking questions matter more than others.

## Decision

1. **A quick action is a `steer` carrying `meta.quick_action`**, one of `start`, `check_inbox`,
   `check_pr` or `resume`, from a human member to one seat.
   - A steer already rings an idle session and is an immediate wake reason. Its newest-wins rule
     (ADR 103) means a second Resume replaces the first, never stacks. No new act, no new rail.
   - A server refuses `meta.quick_action` on any other act, and from any sender that is not a human
     member (`forbidden`).
   - The body is ignored for the line.
2. **The daemon composes the line** for both rails (`composeQuickActionLine`). It is ids-only under
   ADR 088 §4: the action, the person's name, the lane id, PR number, branch, and daemon-read states
   (PR state, check conclusion). Seat memory is referred to, never quoted.
   - `start`: orient (the musterd-orient skill) and take what is addressed to you.
   - `check_inbox`: read your inbox and act on what is addressed to you.
   - `check_pr`: your lane's PR is `<state>`, checks `<conclusion>`; or "no PR on your lane yet";
     or "musterd could not read GitHub here".
   - `resume`: pick up lane `<id>` on branch `<branch>`; read your seat memory first.
3. **Start everyone.** `POST /teams/:slug/quick-actions/start-all` from a human sends one `start`
   steer per enrolled agent seat, and answers per seat: `started`, `capped` (the residency hourly
   cap held it), or `offline` (no host can wake it). Audited once, `quick_action.start_all {count}`.
4. **PR events.** The hub reads each live lane's PR through its own `gh` (no new credential) every
   60 s. On a merge, a red check, or green after red, it sends the lane's owner one
   `message` from the board seat (ADR 649) carrying
   `meta.pr_event {lane, pr, state: merged | ci_red | ci_green, checks_url?}`.
   - It is a wake reason on both rails.
   - Each (lane, PR, state) is sent once, kept in a `pr_watch` table, so a restart never repeats it.
   - Where the hub has no `gh` login, nothing is sent, the card says so, and
     `pr_watch.unavailable` is audited at most hourly.
5. **Question notification preferences**, per member, `question_notify`:
   - `channels`: per channel (`app`, `slack`, `browser`, `email`), `{on, level: buzz | quiet}`;
   - `seats`: per seat, `always` or `never` buzz.
   - Defaults, unchanged from phase 1: buzz for blocking only; quiet otherwise; nothing buzzes while
     the person is on `/live`; quiet hours (from the away-channel settings) hold non-blocking only.
   - "Never buzz" for a seat mutes even its blocking questions, but the card still lands in the list.

## Consequences

- `SPEC.md` gains an Appendix A section for `quick_action`, `pr_event` and the start-all route.
- `/live` (miley, lane `01M67E4ZVY`) and the phone (cider, lane `01M67E5DM8`) render the four
  actions; Settings → You (miley, lane `01M67E6BEV`) edits the preferences.
- The hub runs `gh`. A daemon without it degrades visibly, never silently.
- Seat-side PR watchers become unnecessary; they can be retired once the watch has run a week.
- 2026-10-30 (lane `01M67E3TYE`): the `gh` reader (`readPrState`) landed with the quick actions
  rather than the watch, so Check PR reads the real PR from day one.
  - A headless wake reads no GitHub inside its lease transaction (a `gh` call can take 5 s). Its
    line points the seat at `gh pr view <branch>` instead, unless the lane already carries a merge
    attestation.
  - The idle-seam line reads GitHub live.
  - A seat's quick action is refused, and a client-supplied `pr_event` is stripped.
  - From the commit security review: a seat sets its lane's branch, so the branch is checked
    before it reaches `gh`. It must use git's branch characters, with no leading `-` and no `..`.
    It is passed after `--`, so `--repo=…` can never be read as a flag.
- 2026-10-30 (lane `01M67E4EB8`), decision 4 as built:
  - Each (lane, PR, state) is remembered by its `pr_event.sent` audit row, not a `pr_watch` table.
    That gives the same once-only guarantee without a migration.
  - The watch makes one `gh pr list` call per team per sweep, not one per lane.
  - A red after a green is told again, so a flapping PR reaches its owner each time it turns.
  - The loop is named `pr_watch` and does not run on Cloud.
  - From the commit security review:
    - A team is watched only when it is mapped to its repository in `MUSTERD_PR_WATCH_REPOS`
      (`revive=musterd-io/musterd,…`). Every `gh` call names that repository with `--repo`, so one
      team's lanes are never matched against another's. An unmapped team is not watched, and Check
      PR tells the seat so (`no_repo`).
    - A PR from a fork is ignored, since anyone can name a fork's branch the same as a lane's.

## Observability & Evaluation

- **Traces:** audit `quick_action.sent {action, seat}`, `quick_action.start_all {count}`,
  `pr_event.sent {lane, pr, state}`, `pr_watch.unavailable`, and `question.notify_suppressed {reason}`.
- **Eval:** `quickAction.test.ts` pins each action's exact line and that no line carries the steer's
  body; `prWatch.test.ts` pins once-only events across sweeps and a restart; `questionNotify.test.ts`
  pins the decision table.
- **Experiment:** count Check PR quick actions per seat per day once the watch has run a week.
  **Falsify:** more than one a day per seat, which would mean the automatic watch is not telling
  seats what they need.
