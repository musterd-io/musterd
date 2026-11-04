# 801 — A blocking ask holds: the gate withholds the asked-for action until a human answers

- Status: proposed
- Date: 2026-11-04

## Context

ADR 147 gives every ask a tier, and the top tier (`blocking`, 15 minutes) has the no-answer policy
`hold`: "you wait, and if the timeout elapses you do not proceed" (`guidance.ts`). ADR 150's Gate B
already makes that true for actions the team policy declares as `costly-action` classes: the gate
raises the ask itself, denies the call, and releases it only on a human accept (`gateB`,
`packages/server/src/protocol/gate.ts`).

A seat can also raise a blocking `approve` ask on its own, for an action no class declares. That ask
names its action only in free text. The gate cannot see it, so nothing stops the seat from going
ahead while the ask is open. The [prompted vs structural approval](../wiki/prompted-vs-structural-approval.md)
audit (2026-11-04) lists the hold as prose only. The radar's W44 consider-ADR item, Concordat
(arXiv 2610.37461), measures why that matters: agents break confirmation rules under social
pressure, and outcome-scored checks miss most of the breaks.

## Problem

The one tier whose contract says "do not proceed" is the one tier the system does not enforce for
seat-raised asks. A seat that convinces itself the action is fine, or is pushed by a teammate's
message, meets nothing but its own instructions.

## Decision

1. **A blocking `approve` ask can name what it withholds.** A new optional ask field,
   `meta.withhold`, holds command globs and path globs, in the same shapes as an ADR 150 class
   `match` (command flavor and path flavor, `normalizeCommand` applied). The daemon validates it at
   raise time through `@musterd/protocol`. A seat sets it to the action it is asking about, for
   example `{commands: ["gh release create *"]}`.
2. **While the ask is open, the gate denies the asking seat any call that matches it.** The gate
   reads the seat's open withholds together with the enforcement table, in the same request and
   under the same cache. A match denies, and the reason names the ask and its contract, as Gate B's
   `denied_awaiting` does. The withhold applies only to the seat that raised the ask; other seats are
   unaffected.
3. **A blocking `approve` ask with no `meta.withhold` withholds the seat's mutating calls.** These
   are file writes and Bash commands that are not read-only, except `musterd` and git read
   commands. Reads, inbox calls and `team_*` tools stay open, so the seat can wait, answer and hand
   off. This matches what the contract already asks the seat to do, which is wait. The daemon
   answers the raise with a one-line notice saying the seat-wide form is in force and how to narrow
   it.
4. **It ends on a human answer, on withdrawal, or after 12 hours.**
   - A human accept releases it; a decline keeps the matching calls denied for that ask, as
     Gate B's `denied_declined` does. Which answers count follows ADR 623: `approve` is privileged,
     so an A1 channel answer does not release.
   - The seat may withdraw its own ask with `resolve` and `meta.ask_outcome: 'held'`. That lifts the
     withhold, and the record shows the action was never approved.
   - The 15-minute timeout does not lift it, because the contract at timeout is "do not proceed".
     Like an ADR 516 hold, a withhold ends at 12 hours at most.
   - The strand terminal (ADR 153) is unchanged: the seat releases its lane, and the withhold lasts
     until the ask ends.
5. **On outage it fails closed from the cache.** When the daemon is unreachable, a cached open
   withhold still denies its matches. With no cache, the call proceeds `unenforced`, as ADR 150's
   other gates do today.
6. **Advisory and standard asks are unchanged.** Their policy is proceed-with-risk, so they withhold
   nothing, and `meta.withhold` on them is refused at raise time.

## Consequences

- The `blocking` tier becomes structural for seat-raised asks, at the same strength as the rest of the
  PreToolUse gate. The hook runs from the seat's own workspace settings, so a seat that edits them
  first walks past it (the ADR 658 courtesy wall). This ADR closes the pressured-seat case Concordat
  measures, not the self-editing one.
- The seat-wide form of decision 3 can stop work the human never meant to stop. The notice in
  decision 3 and the narrow form in decision 1 exist so a seat can scope the hold. If seat-wide
  withholds show up mostly as noise in the first week's read, narrowing is the fix, not removal.
- `meta.withhold` is a protocol change (hard rule 1); this ADR is its record.
- Follows-up: lane 01M6M4R80S builds this once this ADR is accepted.

## Observability & Evaluation

- **Traces:** each denial writes the existing `action.gate` audit row, with `cause: 'ask_withhold'`
  and the ask id. The row carries the class name and fingerprint only, never the raw command
  (ADR 051).
- **Eval:** before the change ships, measure from the transcript tap (ADR 445) how often a seat made a
  call matching its own blocking approve ask between the raise and the human answer. Run the same
  read for the two weeks after it ships. The expected result is zero matching calls that succeed.
  Also count seat-wide withholds and how many the seat narrowed.
- **Experiment:** none; the change is uniform. Falsifier: in the after read, a matching call that
  succeeds while its ask was open and the daemon was reachable.
