# 482 — A challenge can be delivered blind: the addressee sees the claim, not who made it

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3QTE4FVJG6R8V5JFXJ64RNV` (goal `research-corpus`)
- Deciders: nick (direction, 2026-09-29), izzo
- Relates to: [ADR 476](476-agent-sycophancy-verify-before-conceding.md) (§3 deferred this),
  [ADR 103](103-steer-challenge-defer-acts.md) (`challenge`),
  [ADR 109](109-seat-git-attribution.md) (attribution survives),
  [ADR 481](481-sycophancy-readout-report-projection.md) (the readout that measures it)

## Context

ADR 476 §3 holds that a human's critique carries the weight of its evidence, not of its author, but
only as guidance. The literature ADR 476 cites finds identity is the main lever. A "team leader"
label moves agreement 28–30 points regardless of correctness. Models defer most readily to humans
and to their own family. Hiding who said what removes nearly all identity-driven distortion in
debate. On this team every `challenge` arrives with its sender's name, and nick's name carries the
most weight.

## Problem

The sender has to stay on the record, for accountability, git attribution (ADR 109), and the
claims ledger. The addressee should judge the claim without knowing whose it is. Hiding the
sender from the store would break the record; hiding it nowhere leaves the lever in place.

## Decision

1. **A new optional field, `meta.blind: true`, on `challenge` acts.** The envelope, including
   `from`, is stored unchanged, and audit and attribution still see the true sender.
2. **Surfaces mask the sender for the addressee only.** When a blind `challenge` is rendered to the
   member it addresses (MCP inbox, CLI inbox, the wake line), `from` shows as `a teammate` and the
   member kind is withheld. Every other reader, including `/live`, the report, and the sender
   themself, sees the real name.
3. **The mask lifts once the addressee answers.** After an `accept` or `decline` whose
   `in_reply_to` is the challenge, the addressee's own view shows the sender. The verdict comes
   first and the name after.
4. **For the evaluation period the server sets `blind` itself**, at random, on half of all
   `challenge` acts, and records which half. A sender cannot opt out during that period, so that
   the split is a real A/B. Afterwards the default is whichever arm the readout favours.
5. **Scope is `challenge` only.** Review notes on `lane_review` asks are left out: the acceptor's
   name is part of the acceptance record (ADR 202) and the reviewed seat needs it for follow-up.

## Consequences

- This changes the protocol (a new meta field, and a rendering rule every surface must follow), so
  `SPEC.md` and `05-mcp.md` change with the implementation.
- The mask is soft. A body can give its author away through style, a signature, or "as I said
  earlier", and a seat can look up the act on `/live`. The ADR claims only that the name is not
  handed over, not that it cannot be found.
- A blind challenge from nick removes the deference effect only for seats that don't guess the
  author. The A/B measures what actually happens, not what should.
- Building waits for ADR 476's five-day baseline, so that the A/B has a before to compare against.
  Follows-up: deferred — ADR 505's 2026-10-29 read (see the 2026-10-05 note)
- **2026-10-05 — re-keyed to the dispute lifecycle; waits for the 2026-10-29 read** (dolly; lane
  01M3QTE4FVJG6R8V5JFXJ64RNV). ADR 476's five-day read (2026-10-04) found 0 `challenge` acts in its
  window, so decision 4's 50/50 split would have had no traffic in either arm. [ADR 505](505-disputes-one-lifecycle-for-contesting-a-claim.md)
  then folded `challenge` into one dispute lifecycle (`via: review | challenge | dependency`) and
  named this ADR "not decided here", to be re-judged at the 2026-10-29 read against dispute data.
  When it is built, the mask is judged per dispute, not per `challenge`: decision 5's exclusion of
  review notes stands on ADR 202's grounds, and the eval reads ADR 505 §8's readout (held / conceded
  / named a check, by `via`) in place of ADR 481's channel rates. Nothing is built before the read.

## Observability & Evaluation

- **Traces:** none new. `meta.blind` on the stored act is the arm label.
- **Eval:** compare blind and named challenges on three counts: the challenge decline rate, the
  unverified-concession share (ADR 481 definitions), and ledger entries with `detection_channel:
  challenge` that later overturn a concession, meaning a wrong concession.
- **Success:** blind challenges get a higher decline rate with no rise in wrong concessions, so
  seats hold when they are right and still give way when they are wrong.
- **Failure:** no difference between the arms at n ≥ 20 per arm, or blind challenges get more
  declines that the ledger later shows were wrong (the seats became stubborn, not selective).
- **Experiment:** decision 4's server-randomised 50/50 split of `challenge` acts, blind vs named, for 5 days.
- **Falsifier for the whole ADR:** at n ≥ 20 per arm, blind and named challenges concede at the
  same rate.
