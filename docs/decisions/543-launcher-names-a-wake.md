# 543 — The launcher names a wake: the roster carries why a woken Presence exists

- Status: accepted
- Date: 2026-10-07
- Deciders: nick (asked for it), dolly (lane `01M4BX170H69XCENEWXVX7N14A`)
- Relates to: ADR 491 Decision 6 (a live seat is launched again only after a warning), ADR 092 (a
  same-workspace successor ends its predecessor), ADR 241 (the wake lease on a Presence), ADR 262
  (work-order board edges), ADR 236 (absence is not an assertion)

## Context

On 2026-10-07 nick ran `musterd dolly` and got:

```
dolly is live here (claude-code) since 09:24. Open a second session in the same folder? (y/N)
```

nick had no dolly session open. The live session was a headless `claude -p` that the wake actuator
had started five minutes earlier to carry on with lane `01M46YWG8Y`. The prompt was true, but
nothing in it said the session was a wake, why it existed, or what answering `y` would do to it.

Two decisions meet here. ADR 491 Decision 6 chose a warning, not a block, for a seat that is
already live. ADR 092 says a same-workspace successor that stays attached past a short grace (5 s by
default) disconnects its predecessor. So `y` does not open a second session beside the wake: it
replaces the wake and cuts its work off.

The roster already said the session was a wake (`provenance: 'wake'`) and carried its lease id
(`wake_lease`, ADR 241). The reason sits on the lease row: the board `edge` that derived it, the
`lane_id` it was for, and the `act_id` it delivered. The roster carried none of that, and the lane
board needs authentication, which the launcher's roster read deliberately avoids (an authenticated
read can claim the seat and write Presence).

## Problem

How does `musterd <seat>` tell a person that the live session is a wake, why it exists, and that a
second session would replace it, without an authenticated read and without exposing more than the
anonymous roster already does?

## Decision

1. **A Presence that attests a wake lease carries `wake_for`** on the roster:
   `{ edge, lane_id, act_id, act, from }`. The daemon joins it at read time from the lease row, the
   act's message row (its kind) and the sender's member row (its name). This is an additive,
   optional `@musterd/protocol` field on `Presence`.
2. **Ids and names only.** There is no message body and no lane title, because the roster answers
   anonymous reads and the lane board does not. A lane is shown by its id prefix.
3. **Absence is not "not a wake".** `wake_for` is null when the lease has no row on the answering
   daemon (a lease minted on another node, or a pruned row) and absent from older daemons.
   `provenance: 'wake'` stays the wake signal (ADR 236).
4. **The live-seat question names a wake.** When the live Presence is a wake, `musterd <seat>` and
   the picker ask:

   ```
   dolly is live here (claude-code) since 09:24 — a wake: musterd started it headless to carry on
   with lane 01M46YWG8Y. That's expected; it exits when the work is done. A second session replaces
   it within seconds and cuts that work off. Open one anyway? (y/N)
   ```

   The reason clause follows the edge: `to judge lane X for acceptance` (review), `to carry on with
   lane X` (dispatch_continuation), `for lane X, handed over from Y` (dispatch_handoff), and `to
   answer an ask from Y` for an inbox wake. If the daemon cannot say why, the clause is dropped and
   the question still says it is a wake. Without a TTY, the refusal names the wake the same way.
5. **A session a person opened keeps today's question, word for word.**

## Consequences

- A person can tell routine musterd work from a forgotten session of their own, and knows that `y`
  ends the wake's work rather than joining it.
- The roster read gains three LEFT JOINs (`wake_leases`, `messages`, `members`), each by primary
  key, and they only find rows for presences that attest a lease.
- Alternatives considered: (a) **CLI only, no protocol field.** It could say "a wake" from
  `provenance` but not why. nick asked for the why. (b) **An authenticated lease read from the
  launcher.** Rejected: an authenticated read can claim the seat and write Presence, which the
  launcher's roster read avoids on purpose (`fetchRosterPage`). (c) **The lane title on the
  roster.** Rejected: the lane board is behind authentication, and the anonymous roster must not
  widen what it shows.
- This does not change what `y` does. Whether a person's session should be allowed to replace a
  wake at all (ADR 092 × ADR 491) is a separate question. This ADR makes the trade visible.

## Observability & Evaluation

n/a — a human-facing CLI prompt fed by a read-time join. It changes no agent behaviour, so there is
nothing to trace or eval. The roster's `wake_for` is directly inspectable (`GET
/teams/:slug/members`), and the unit and integration tests pin both the prompt wording and the join.
