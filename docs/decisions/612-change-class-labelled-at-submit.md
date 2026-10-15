# 612 — The change class is labelled at submit and shown to the acceptor; it routes nothing yet

- Status: proposed
- Date: 2026-10-15
- Deciders: nick (asked for "acceptance tiering by diff shape" on 2026-10-15; this ADR is the form
  that request can take without reversing ADR 234)
- Lane: `01M50GE3ZDZW9GMJPAY4K7KQPQ`
- Builds on: ADR 234 (label before route: `stakes` was recorded for a window before anything routed
  on it, and §Decision's own history rejects a surface-path exemption), ADR 188 (the graded review
  ladder and what the acceptance ask carries), ADR 305/585 (the submit attests `{pr, sha}` and the
  seat verifies the SHA against origin/main), ADR 530 (a path-derived requirement exists once already:
  a scope that reaches `packages/web` must declare `risk`)
- Snapshot-debt: none — §Decision asserts no frequency; the rates it will yield are the eval.
- Protocol change: yes (hard rule 1) — `merged.change_class` and `merged.changed` on the lane's merge
  attestation, optional; the `lane.ready_for_review` audit row and the acceptance ask's
  `meta.lane_review` carry them.

## Context

musterd already splits review in two: CI judges the code (`gates`), and outcome acceptance judges
the landed result on intent, principles, usable and feel (ADR 192). The review ladder draws the
acceptor the same way for every lane: a cross-family peer, a human when the lane carries a risk tag,
a 1-in-5 sample when the worker declared `stakes: low` (ADR 234 inc 2).

Anthropic's source-control write-up (2026-10) describes a review tool whose approval rules are
semantic: a comment-only change is approved differently from a logic change, so reviewer attention
goes to intent. The analogue here would be acceptance that reads what the PR touched.

ADR 234 has already been there. Its §Decision records nick's own policy contradicting a path rule:
a `packages/web` exemption would have waived exactly the category his risk policy most wants eyes on,
and would not have waived the one change that week that needed nobody. Its conclusion stands:
**surface complexity predicts review cost, not review value**, and routing must not be derived from
the diff. The same ADR also set the method by which anything new earns a routing consequence: record
the label for a window, show that it predicts the outcome, then route on it.

## Problem

The acceptor opens an acceptance ask knowing the lane's title, branch, PR and SHA. They do not know,
until they open the diff, whether what landed is a one-line docs amendment, a test-only change, a
server policy change or a protocol change. The checklist asks them to judge "usable" either way.
And the question ADR 234's method needs answered first — does the kind of change predict how
acceptance goes — cannot be asked, because nothing records the kind.

## Decision

1. **The submitting seat classifies the landed diff and attests the class.** `lane_submit` and
   `musterd lane submit` already verify the SHA against `origin/main` in the seat's own clone (ADR
   585, `packages/mcp/src/tools/lanes.ts`, `packages/cli/src/commands/lane.ts`). In the same step they
   run `git diff --name-only <sha>^ <sha>` and derive `change_class` from the paths:
   - `docs` — every path under `docs/`, or a root `*.md`;
   - `tests` — every path is a test or fixture (`*.test.ts`, `__fixtures__/`, `scripts/**/*.test.ts`);
   - `web` — any path under `packages/web/` or `packages/mobile/`;
   - `protocol` — any path under `packages/protocol/src/`;
   - `server` — any path under `packages/server/src/`;
   - `code` — anything else.
   The first matching class wins in that order, except that `web`, `protocol` and `server` each
   outrank `docs` and `tests` (a PR that touches a schema and its ADR is `protocol`). Alongside the
   class the seat sends `changed: { docs, tests, code }` — three counts, never the path list. A
   cross-repo lane (`verification: unknown_object`) sends no class.
2. **The class is recorded and shown; nothing reads it to route.** The `lane.ready_for_review` audit
   row carries `change_class` and `changed`, unconditionally — including `code`, the common value,
   for the reason ADR 234 §Observability gives. The acceptance ask's `meta.lane_review` carries the
   class, and the ask body opens with it: `[lane] acceptance requested (docs-only, 3 files): …`. The
   picker, the grade, the tiers and the risk rule are untouched.
3. **The routing decision is deferred to a second ADR, gated on the eval below.**
   Follows-up: deferred — the routing ADR is opened only when the eval's decision rule is met, by
   whoever reads the 30-submit result (2026-11-15).
   Candidates that ADR would weigh, named now so they cannot be argued into existence later: `docs`
   lanes join the `stakes: low` 1-in-5 draw unless they carry a risk tag; `tests` lanes draw a
   same-family peer; `protocol` lanes draw cross-family as now. None of these is decided here.

### Rejected

- **Classify on the daemon from the lane's declared `scope`.** The scope is what the worker said
  they would touch, not what landed; ADR 530 uses it to demand a declaration, never to describe a
  diff. Only the seat has the clone.
- **Route on the class now.** ADR 234 §"Increment 2 shipped before its own gate" records what that
  costs and why it was wrong. This ADR takes the method, not the shortcut.
- **Send the path list.** Three counts answer the eval; a path list on every ask is content the
  acceptor can read from the PR, carried twice.

## Consequences

- `merged` gains two optional fields; a pre-612 seat sends neither and the row records nothing, the
  same abstention every ADR 217 field makes.
- The acceptor's first line says what kind of landing they are judging. For a `docs` lane "usable"
  reads as "does the text say what the code does", which is what acceptors already do by hand.
- The eval has a dataset from the day this lands. The second ADR has a decision rule before anyone
  wants it to say yes. Follows-up: none — the routing ADR is opened only if the eval meets its rule.

## Observability & Evaluation

- Traces: `change_class` and `changed` on every `lane.ready_for_review` row; the class in the ask
  body. Falsifier: a ready row from a seat on a post-612 build with `verification: ancestor` and no
  `change_class`.
- Eval: `lane.ready_for_review` joined to `lane.closed` by lane, over the post-612 window, split by
  class: (1) class composition of submits; (2) accept / decline / self-close rate within class; (3)
  time from ask to verdict within class, measured from the acceptor's first presence after the ask
  (ADR 234's correction). Decision rule for the routing ADR: a class may route differently only if
  its decline rate is materially below the blended rate over at least 30 submits — a class nobody
  ever sends back is one whose acceptance is buying nothing. If `docs` lanes are declined at the
  blended rate, the class predicts cost and not value, exactly as ADR 234 found for paths, and no
  routing ADR is written.
- Experiment: n/a — a label on an existing row; the eval is the experiment.
