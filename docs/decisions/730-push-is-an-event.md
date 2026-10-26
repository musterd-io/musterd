# 730 — A push is an event: the daemon sees a lane's branch reach the remote and tells the seats waiting on that lane

- Status: accepted
- Date: 2026-10-24
- Lane: `01M5RQQ4T2` (goal `coordination-cost`), asked for by nick
- Extends: [697](697-a-hold-hands-over-the-work-not-only-the-turn.md), [724](724-held-refusal-watches-the-holders-lane.md)

## Context

A seat that works beside another on the same repo needs to know when the other's work is somewhere it
can fetch. On CooperBench, where two agents share one task and push to a common remote, they tell each
other by hand: "pushed to team/agent1, merge it before you edit". Finding 022 priced that kind at 10
calls on `core`, called it the one state signal with no product event behind it, and asked for a
design note before any lane. Finding 025 ran the build that carries ADR 724 (the file-freed act) and
ADR 726 (status read from lane activity) on the same pairs: every other signal kind held or fell, and
"pushed" rose to 14 calls ($0.26), the largest kind left
([finding 025](../research/025-cooperbench-coordination-cost-run.md)).

What the daemon knows today. ADR 697 learns a lane's branch and HEAD from the gated edits made in it
(`git_branch`, `git_head` on the contended-surface check; `lane_heads`). ADR 724 uses them: when the
lane frees a file, the refused seat is told, with the branch and head, to bring the work in. The push
itself — the moment the branch is actually on the remote — is never seen. The PreToolUse gate matches
`Bash`, but it runs before the command and cannot know whether the push went through; and the
CooperBench arm leaves `Bash` out of its gate matcher on purpose, so there it sees no push at all.

## Problem

Carry the push as an event, so a seat that is waiting on a lane learns that the lane's branch is on
the remote, at which commit, without the holder saying so. Only report a push that happened; never
guess from the command text. No new tool, no change to the refusal text or the gate's decisions, and
nothing that wakes a seat whose file is still held into editing it.

## Decision

1. **A PostToolUse hook on `Bash` reports a push.** `musterd init` wires one more project-local
   Claude Code hook (`musterd-push-hook`, matcher `Bash`): `musterd gate record-push --stdin`. It runs
   after the command. It reads the payload's `tool_input.command`; when a segment of it is a `git
   push` (the ADR 516 segment normaliser, so `cd x && git push origin b` and `git -C x push` count),
   it takes the remote from the command (`origin` when none is named) and the current branch and HEAD
   from the working tree (`gitHere`). It then reads `refs/remotes/<remote>/<branch>`. **The push is
   reported only when that ref equals HEAD**: a push that failed, pushed another branch, or pushed a
   detached HEAD leaves the ref elsewhere and sends nothing. _(Amended 2026-10-25: a branch already
   up to date on the remote leaves the ref at HEAD whatever the command pushed, so the hook also
   reads the command's refspecs (`pushSpec`) and reports only a push of the current branch — no
   refspec, `--all`, or a refspec naming the branch or `HEAD` — never a delete, and never a command
   the harness payload marks failed or interrupted. Big-body's decline on this lane.)_ It POSTs `{remote, branch, head}`
   (`LanePushReportSchema`) to the daemon as the seat, once, and always exits 0.
2. **The daemon records it on the seat's lane.** `POST /teams/:slug/lanes/push` is member-authed as
   the pushing seat. The daemon finds that seat's lanes in a contending state (claimed, active,
   blocked) whose `branch` is the pushed branch — the branch ADR 697 taught the lane from its edits.
   For each, it records the pushed head, remote and time on the lane's `lane_heads` row (three new
   nullable columns, ladder v132; daemon-local like the row). A push of a branch no lane of the seat
   knows records nothing: a lane that was never edited through the gate has no branch, and the daemon
   does not guess one.
3. **One directed act per waiting seat and lane, once per head.** _(Superseded in part 2026-10-25 by
   [ADR 731](731-push-reaches-covering-lanes.md): the audience also includes every other seat whose
   contending lane covers a file this lane names, and the response names the seats told.)_ For every seat with an open
   ADR 724 watch on that lane (a held refusal not yet answered), the board seat (ADR 649) sends one
   directed `message`: `[lane] <holder> pushed "<title>": <branch> at <head> on <remote> — fetch it
   before you edit; '<path(s)>' is still held.` with `meta.lane_pushed {lane, holder, branch, head,
   remote, paths}`. The same head is announced once; a second push of the same commit sends nothing,
   a push of a new commit sends again. The watch stays open: the file is still held, and ADR 724's
   freed act follows when the lane ends.
4. **`until_lane` does not wake on it.** The lane wait ends when the file is free. A push is not that,
   and a seat woken into an edit it would be refused is worse off than one that waited. The act is in
   the inbox for the seat's next read, and wakes a plain blocking wait like any directed act.
5. **The CooperBench arm carries the hook.** The arm wires musterd's hooks word for word from
   `claudeCode.ts` (`config.py`, pinned by `test_config.py`); it gains this one, matcher `Bash`, the
   same way. The arm's PreToolUse gate still leaves `Bash` out: this hook decides nothing and runs
   after the command, so it is not the gate the arm declined.
6. **Nothing else changes.** No protocol schema other than the new report body; the `message`
   envelope and the open `meta` record carry the act; the refusal text, the gate's outcomes and
   audit rows, ADR 697's hand-over and ADR 724's acts stay as they are. The hook is Claude Code only
   for now, like the gate hooks; other harnesses see no push, as they saw none before.

### Rejected

- **Read the push off the PreToolUse gate.** It runs before the command, so it cannot know the push
  succeeded; reporting the intent would announce pushes that failed.
- **Trust the PostToolUse payload's exit status.** Its shape is the harness's, not ours, and a push
  can succeed for one refspec and fail for another. The remote-tracking ref is what git itself
  believes was pushed, and the check is one `rev-parse`.
- **Tell every seat on the project, or the lane's partners by scope overlap.** The daemon does not
  know who is waiting to build on a branch beyond the seats it refused for it. A broadcast would be
  the `@team` noise the status-update removal (ADR 726) just took out; an overlap guess would wake
  seats that never asked. The watchers are the seats with a recorded interest; a wider audience is a
  later decision, measured first.
- **Wake `until_lane`.** See §4.
- **Show the last push on `lane_board` and in the orientation block.** It needs a `Lane` field, a
  protocol schema change wider than this one, and the directed act answers the question for the
  seats that have it. Reconsidered if rider 4 shows the signal survives among seats with no
  refusal on record.

## Consequences

- A holder's "pushed, fetch it" message is redundant for a refused partner; nothing forbids it.
- One more hook in `.claude/settings.local.json` per seat (`init --refresh-hooks` adds it; `init
  --check` reports it missing like the others), one more one-shot `musterd` process per Bash call
  that names `git push` — none for any other command, which returns before any git or network work.
- One more POST per successful push of a lane's branch; one directed act per watching seat per new
  head. On CooperBench `core` that is bounded by the held refusals (15 on finding 025's run).
- `lane_heads` gains `pushed_head`, `pushed_remote`, `pushed_at` (ladder v132, daemon-local, not
  replicated).
- _2026-10-25 (ADR 731):_ the audience question finding 026 raised is decided — the covering lanes
  join the watchers, the hook tells the pusher who was told, and the ADR 691 refusal carries the last
  pushed head ([ADR 731](731-push-reaches-covering-lanes.md)); rider 5 reads it.
- _2026-10-25 (rider 4, [finding 026](../research/026-cooperbench-rider4-run.md)):_ on 10 CooperBench
  `core` pairs the hook reported 20 of 20 pushes and the daemon recorded each; 4 acts went out, because
  16 pushes had no open ADR 724 watch on the lane (the refused seat's own push never has one; a
  holder's push before the partner's refusal or after the lane freed has none either). Hand-sent
  "pushed" messages rose 14 → 18, and 3 of the 4 holders whose push was announced said it again by
  hand — the hook tells the pusher nothing. The audience (§3) and the pusher's feedback are the two
  product changes to pre-register next; the overlap-warned partner is a recorded interest this ADR's
  Rejected list did not weigh.
- _2026-10-25 (acceptance, this lane):_ big-body declined the first landing: from a lane branch
  already at HEAD on the remote, `git push team other` reported the lane branch. The hook now reads
  the refspecs too and the harness's exit status when present (amendment in §1); the regression case
  is in `gate.push.test.ts`.
- _2026-10-24 (build, this lane):_ the daemon, hook, CLI and protocol parts land together (#3310).
  §5, the CooperBench arm's `config.py` and its pinning test, lands in lane `01M5R2G1Q3` beside the
  `gate_smoke.py` fix, because another lane holds those two files as this ADR lands.

Follows-up: 01M5R2G1Q3Q3G74HNMFTVHT5J8

## Observability & Evaluation

- **Traces.** `lane_push_recorded` (lane, remote, head, watchers) and `lane_push_fired` (seat, lane)
  info log lines on the daemon; `lane_push_ignored` when the seat has no lane on that branch. The
  directed act is the record (`meta.lane_pushed` on a board-seat message), as ADR 724 chose. No new
  audit action.
- **Eval.** CLI tests: the segment matcher takes the remote from `git push origin b`, `git push`,
  `cd x && git -C y push team HEAD`, and not from `git fetch` or `git push --dry-run`; the report is
  sent only when the remote-tracking ref equals HEAD. Server tests over `POST /lanes/push`: a push on
  a lane's branch by its owner records the head and sends one act to the refused seat with the branch,
  head and held path; the same head again sends nothing; a new head sends again; a branch no lane
  knows records nothing; a seat with no refusal on record gets nothing; the watch stays open and the
  ADR 724 freed act still follows the resolve. Hooks test: the third PostToolUse entry, matcher
  `Bash`, marker-tagged, dropped on removal.
- **Experiment.** Rider 4b in [`riders.md`](../research/cooperbench/riders.md), pre-registered
  2026-10-24 (#3309): on the next musterd CooperBench run on a build carrying this ADR, "pushed /
  fetch" sends on the 10 `core` pairs fall from 14 — ≤ 5 the push event carried the signal, ≥ 12 it
  did not — with the count of push acts delivered reported beside it.
