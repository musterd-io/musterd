# 726 — An agent reads working from the lanes it claimed and its recent actions

- Status: accepted
- Date: 2026-10-23
- Lane: `01M5N3TX8E` (goal `coordination-cost`), asked for by nick
- Supersedes in part: [057](057-ambient-agent-presence.md) Problem (d), [316](316-idle-becomes-active-and-agents-decay.md) Decision 1 and its "Deriving stays from `last_status_at` only"
- Amends: [215](215-quiescence-decision-signal.md)'s "neither reads the other"

## Context

An agent reads `working` on the roster only when it has sent a `status_update` within
`agentIdleMs` (15 min), or a live steering link holds it (ADR 316 Decision 1, `resolveActivity` in
`store/activity.ts`). ADR 057 made that the rule ("the `working: <x>` label … must keep coming
**only** from a self-reported `status_update`"). ADR 316 accepted the cost: "a heads-down agent
reads `active` with a stale claim — the claim *is* stale; hooks nudge status at task boundaries."

The nudge is what keeps the roster honest, and it is paid for in every session. Claude Code seats
get "musterd: finished a unit of work? team_send status_update (one line), then team_inbox_check."
on every prompt (`prompt_submit_ritual`). The primer tells every agent to send one "on start and
finish — this is what flips you to `working`". On CooperBench `core`, agents sent 40 status
updates per 10 pairs, $0.94 (finding 022). They were not instructed by the benchmark; the primer and
the join text asked for them.

The roster already has better evidence than a self-report. The audit trail timestamps every action
the daemon witnesses for a seat: tool calls, sends, lane operations. Quiescence (ADR 215) reads it
as `lastActionBySubject`. The board knows which lanes a seat has claimed. An agent that owns a
claimed lane and acted a minute ago is working on that lane. Asking it to say so costs a call and
proves less.

## Problem

Make `working` mean "this agent is doing the work it claimed" from what the daemon already sees,
so agents no longer need to be told to report it. Keep a self-report possible and keep it winning
when it is fresher. Do not let a stale claim read as work.

## Decision

1. **A second way to `working`, for agents.** A live agent seat reads `working` when it owns a lane
   in `claimed` or `active` state and its last audited action (`lastActionBySubject`, presence rows
   excluded as quiescence already does) is within `agentIdleMs`. Human seats are unchanged: their
   `working` still comes from a status update or steering.
2. **The label is the lane.** A derived `working` shows the lane's title. With several claimed
   lanes, it shows the one claimed most recently and says how many others. A `status_update` sent
   after that action still wins, so an agent can always say something more specific.
3. **The wire says which.** The roster member gains `state_source: 'status' | 'lane' | 'steering'`,
   with a feature epoch bump and a tolerant parse, as ADR 316 did for `active`. Renderers say
   "working on <lane>" for `lane`, and stay as they are for `status`.
4. **Decay is unchanged.** Past `agentIdleMs` with no action, the derived read decays to `active`
   with the claim kept and aged, as ADR 316 Decision 2 does for a status. A `blocked` lane does not
   make its owner `working`.
5. **What a status update is still for.** Free text when an agent wants to say more,
   `meta.blocked_by` reports (ADR 271), and ask outcomes (`meta.ask_ref`). None of these change.
6. **The instructions go, afterwards.** Once this ships, the primer's "on start and finish" line,
   the per-prompt nudge, the MCP join text and the skills stop telling agents to send status
   updates for the roster's sake (lane `01M5N3VG2D`). They are not removed before the roster reads
   lanes, or every agent would read `active` in between.
7. **ADR 215's split, restated.** ADR 215 says activity and quiescence must not read each other,
   so a wrong display can never steer a machine's decision. That holds: quiescence does not read
   activity. Activity now reads the same audit evidence quiescence reads. The evidence is shared;
   the verdicts stay separate, with their own windows (15 min for display, the consumer's line for
   decisions).

### Rejected

- **Evidence from allowed gate checks (`lane.gate` rows).** This lane's first draft. Gate A only
  runs where a team has declared contended surfaces, and most teams declare none, so the signal
  would be absent exactly where it is needed.
- **Evidence from the ADR 660 tool-call heartbeat.** It is an in-memory 60 s ring for `/live`'s
  desk animation, and only harnesses with hooks feed it. The audit trail covers every harness that
  talks to the daemon.
- **Drop the nudge and accept a stale roster.** ADR 316 already measured what a roster without
  reports looks like: every heads-down agent reads `active`.

## Consequences

- A heads-down agent with a claimed lane reads `working on <lane>` without sending anything. One
  that claimed and then went quiet decays as before.
- An agent that claims a lane and does unrelated work reads as working on that lane. That is the
  claim's own problem, and the board already shows it.
- The roster query gains a per-seat lane lookup and a per-seat last-action lookup. Both exist
  (`wakeContextBody.ts` lists a seat's claimed lanes; `lastActionBySubject` is quiescence's) and are
  batched the way the roster already batches status reads.
- Wake context's `lane.last_status_update` falls back to the lane's state and last action when no
  status names the lane.
- Build lanes: `01M5N3V9EP` (server, wire, renderers), then `01M5N3VG2D` (instructions).

Follows-up: 01M5N3V9EPHMZ08XJ4FDRN2DPX, 01M5N3VG2DG14Z81NRMHMXVFPC

## Observability & Evaluation

- **Traces.** `state_source` on every roster read. No new log line: the inputs are the audit rows
  and lane rows already written.
- **Eval.** Server tests on `resolveActivity`: a live agent with a claimed lane and an action 5 min
  ago reads `working` from `lane`; 20 min ago reads `active` with the claim kept; a fresher status
  wins; a `blocked` lane and a human seat do not derive; steering still outranks both.
- **Experiment.** On revive, before and after lane `01M5N3VG2D` ships, over one working week each:
  `status_update` sends per agent-hour, and the share of agent-minutes with an audited action in
  the last 15 min that read `working`. Prediction: sends fall by more than half, and the share
  rises. Falsify: the share falls, meaning heads-down agents read `active` more than they did with
  the nudge, or nick reports the roster as less true than before.
