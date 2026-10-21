# 693 — A hold lapses when its holder has left

- Status: accepted
- Date: 2026-10-21
- Lane: 01M5FQBC8JFAFH1ZHEP6XKZXK8 (goal `cooperbench`)
- Amends: [ADR 691](691-named-file-is-held-first-claim-wins.md) decision 2 (when a hold ends)

## Context

ADR 691 made a lane that names a file hold it, first claim first, and under `block` the gate
refuses another seat's edit of a held file. A hold ends when its lane leaves the contending states
or drops the entry. Nothing else ends it.

Planning the second CooperBench pilot (lane 01M5FQBPHB) showed what that misses. A CooperBench
agent writes its patch and exits; it never closes its lane, because the run ends. Its partner is
then refused the shared file for the rest of the run, by a seat that is no longer there to hand it
off, narrow, or answer. Every exit the refusal names ("ask them to hand it off… wait for that lane
to finish") needs the holder present.

The same happens on a real team whenever an agent session ends with its lane open: a Claude Code
window closed at the end of a day, a crashed run, a seat whose machine went to sleep. The lane is
still worth showing on the board (the work is not done), but the file is held by nobody who can
release it, and only a human closing the lane frees it.

nick's rule for the goal (2026-10-21): no gaming the bench; a gap the bench reveals is fixed in the
product for every team.

## Problem

A hold is a promise that someone is editing the file now. ADR 691 ties it to the lane's state,
which says the work is unfinished, not to the seat's presence, which says someone is there. When
the two come apart, the hold outlives the person or agent it protects and blocks the one seat that
could finish the work.

## Decision

1. **A hold whose holder is an agent seat that has left lapses.** "Left" is the presence model's
   own answer: no live presence and no released presence still inside its reclaim grace
   (`isPresentOrReclaimable`, ADR 010's single-active hold). A reload, a reconnect, or a daemon
   bounce stays inside that grace and does not drop the hold; a session that has ended, past it,
   does.
2. **A lapsed hold is the advisory, under either posture.** The gate allows the edit with
   `outcome: 'warned'` and a reason that names the holder, their lane, when they claimed, and that
   the hold lapsed because they left, and asks the editor to tell them what changed. The lane is
   untouched: it stays claimed, on the board, with its owner. No new state, no release, no act.
3. **The hold resumes when the holder returns.** The check is live at each gated edit, so a holder
   that reconnects holds the file again from its next presence.
4. **A human's hold stands.** A person's presence is not a reliable sign they are working (they
   edit in an editor with no musterd session; the CLI's lease dies with the command). Only an
   agent seat's absence lapses its hold.
5. **No new setting and no new number.** The grace is the existing reclaim grace and presence
   timeout (`MUSTERD_RECLAIM_GRACE_MS`, `MUSTERD_PRESENCE_TIMEOUT_MS`; 45 s each by default), so a
   hold lapses about a minute and a half after its holder's session ends.

### Rejected

- **Release the lane when its agent leaves.** The lane records unfinished work and who owns it;
  releasing it loses that and invites a claim race. Only the edit refusal needs to stop.
- **A hold time limit.** A long, present edit is the case a hold exists for; time says nothing about
  whether the holder is there.
- **Tell the bench agents to close their lane before submitting.** That is the prompt change
  finding 015 already showed is not enough, and it would help the benchmark and nobody else.

## Consequences

- `packages/server/src/store/presence.ts`: `isPresentOrReclaimable`.
  `packages/server/src/protocol/gate.ts`: the lapse check in Gate A, after the holder is found and
  before the refusal. A lapsed hold is a `warned` `lane.gate` row with `detail.hold = 'lapsed'`
  and `detail.holder` _(corrected 2026-10-21, lane 01M5FR8Y26: the row carried no reason, so the
  fields were added)_.
- The claim-time `surface_overlap` note still says the other lane holds the file; that is true at
  claim time, and the gate decides at the edit.
- CooperBench's musterd arm: the second agent to name the shared file is refused while the first is
  working, and can edit it with the advisory about a minute and a half after the first exits.
  Whether that is enough to pass pairs is pilot 2's question.
- An agent seat that leaves for lunch with its lane open stops holding its files for that time.
  That is the trade: it cannot answer a request to hand off while it is gone either.

## Observability & Evaluation

- **Traces:** `lane.gate` rows with `detail.hold = 'lapsed'`, by team and week, beside ADR 691's
  `detail.hold = 'held'` rows.
- **Eval:** on this team, 30 days after landing: for each lapsed-hold edit, whether the holder came
  back and its own branch then conflicted with the edit on that file. The rule holds if fewer than
  one in five lapsed-hold edits ends in such a conflict. Above that, a holder's absence is shorter
  than the grace makes it look, and the grace is re-read.
- **Experiment:** CooperBench pilot 2 (lane 01M5FQBPHB), pre-registered: per pair, count lapsed-hold
  edits and whether the pair's patches still conflicted on that file.
