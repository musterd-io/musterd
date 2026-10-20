# 687 — The lane chain's model link is the claimant's model

- Status: accepted
- Date: 2026-10-20
- Lane: 01M5DR2F5H05MB0V981TD09NR3
- Amends: [ADR 629](629-lane-requested-by.md) (the 2026-10-16 reader note in Consequences)

## Context

ADR 629's reader prints a lane end to end as five links: asked, claimed, model, accepted,
authorized. The `model` link sits between `claimed` and `accepted`, and a reader takes it as the
model that did the claimed work. Its rule, recorded in ADR 629's Consequences on 2026-10-16, was
"the newest `lane.*` audit row that carries `actor_model`".

Every `lane.*` row carries the model of the seat that wrote it (ADR 581). A counterpart accept
writes the newest row: `lane.closed` by the acceptor.

## Problem

On every counterpart-accepted lane the newest row with a model is the acceptor's close, so the
`model` link always shows the acceptor's model, never the worker's. CooperBench 1b
(01M5B2SJG6) read on 2026-10-20:

```
claimed    lazara  verified
model      minimax-m3.1-flash-free  verified
accepted   dreamy · cross_family  verified
```

lazara did the work on a Claude model; `minimax-m3.1-flash-free` is dreamy's observed model on
opencode. The `verified` mark is honest about the measurement and wrong about whose work it
measures. The chain is the accountability record the positioning rests on; a model link that
names the reviewer defeats its purpose on exactly the lanes that have a reviewer.

## Decision

The `model` link is the claimant's model: the newest `lane.*` row **whose actor is the `claimed`
link's seat** and that carries a model other than `unknown`. The mark stays as ADR 629 has it:
`observed` is verified, a declaration or a sourceless model is stated.

Only when no row by the claimant carries a model does the newest row by any actor stand in, as
before — an older lane whose claimant's rows pre-date ADR 581 still reads something rather than
nothing. When the chain has no `claimed` seat at all, the rule is unchanged.

The `claimed` link is computed first and its value is what the `model` link filters on, so the
two links can never name different seats' work.

## Consequences

- `laneChain()` in `@musterd/protocol` changes behaviour, not shape: the same five links, the same
  marks; `/live`, `/board`, `lane show` and `lane_board` pick the change up with no wire change.
- A lane handed off mid-way reads the current (or latest-claimed) owner's model, which matches
  what `claimed` names. The previous owner's model is in the history, not the chain.
- The fallback is deliberately narrow. A counterpart close never satisfies the claimant filter,
  so the regression this ADR fixes cannot recur through it.
- ADR 629's 2026-10-16 note in Consequences carries a dated marker pointing here.

## Observability & Evaluation

- **Traces:** none new. The chain is a pure read over existing `lane.*` audit rows and their
  `actor_model` columns.
- **Eval:** `lane show` on any counterpart-accepted lane (CooperBench 1b, 01M5B2SJG6, is the
  reference) names the claimant's model on the `model` link and the acceptor on `accepted`. The
  unit test in `packages/protocol/src/laneChain.test.ts` pins the four cases: counterpart close,
  released lane, claimant's newer declaration over their older observation, claimant with no model.
- **Experiment:** n/a — a read bug with one correct answer.
