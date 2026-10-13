# 585 — Verification as protocol: a seat's claims at submit are checked against git, GitHub and the ledger

- Status: accepted
- Date: 2026-10-13
- Builds on: [ADR 192](192-outcome-acceptance.md) (two-stage close: submit is the worker's claim,
  accept is the counterpart's verdict), [ADR 202](202-the-verdict-moves-the-lane.md) (the accept act
  moves the lane), [ADR 300](300-awaiting-acceptance-means-landed.md) (the SHA is checked against origin/main
  at submit), [ADR 169](169-two-stage-close.md) (verified-ness is derived at close,
  never stored), [ADR 109](109-seat-git-attribution.md) (the seat → PR → SHA join),
  [ADR 583](583-metering-gateway-not-a-loop.md) (the sibling rail: what a wake cost)
- Lane: `01M4VNFG0PGBS8N2TA7CPW4551` · Goal: `verified-work`
- Input: [own model, native harness, or neither — research readout](../design/2026-10-13-own-model-vs-native-harness.md) §3;
  the retired native-harness phase-2 spec §3 (`docs/superpowers/specs/2026-08-12-native-harness-phase-2-design.md`)

## Context

Every agent harness surveyed in October 2026 verifies work by trusting the agent's own
transcript. Anthropic's long-running-agent guidance and Fowler's harness-engineering memo both
name the gap: nothing independent checks that what the agent said it did, happened. The readout
found no shipped product that audits an agent's work claims as a primitive. musterd already holds
the facts such an audit needs — the lane, its attested PR and SHA, the acceptor, the audit log —
and has one check in place: ADR 300's merge-verified submit, which classifies the attested SHA
against origin/main in the submitting seat's clone and refuses a `not_ancestor`.

That check has three limits. It covers one fact (the SHA), it lives in one door (the MCP
adapter; `musterd lane submit` filed no verification at all), and it is run by the seat making the
claim. A reviewer's `accept` (ADR 202) closes the lane on the reviewer's judgement of intent,
principles, usability and feel — but the reviewer's own clone is never asked whether the commit,
the PR or the CI are what the submitter said.

The retired native-harness phase-2 spec designed this as a chain gate inside a loop musterd would
own: typed claims at a checkpoint, host as field arm, daemon as judge, a closed vocabulary that
widens one deterministic checker at a time. The loop is gone (ADR 583); the design survives
without it, because the facts live in git, GitHub and the daemon, not in any loop.

## Problem

A lane's submit and accept must carry typed, machine-checked claims about what landed — checked
once by the submitter's clone and again, independently, by the acceptor's clone — recorded on the
lane and in the audit log with each claim's verdict and checker, on every harness, with no model in
the verifier, and with nothing a seat can forge about who checked what.

## Decision

1. **A closed claim vocabulary, v1.** A claim is `{kind, ref, verdict, checked_by, checked_at,
   evidence}`. Kinds: `commit_landed` (the SHA is reachable from origin/main), `branch_pushed`
   (the branch exists on origin), `pr_merged` (the PR is merged and its merge commit is the
   attested SHA), `ci_green` (every required check on the PR concluded success). Verdicts:
   `confirmed`, `unconfirmed`, `unverifiable`. Anything outside the vocabulary is not a claim.
   The vocabulary widens one kind at a time, each with a deterministic checker; nothing is ever
   half-verified. The schema is `LaneClaimSchema` in `@musterd/protocol`.
2. **The verdict rule lives in one place.** `claimsFromEvidence` in `@musterd/protocol` turns
   what was attested and what the checkers observed into claims. The checkers — git for the SHA
   and branch, `gh` for the PR and its checks — run in whichever package owns a clone (`@musterd/mcp`,
   `@musterd/cli`); a checker that cannot run abstains and the claim records `unverifiable` with
   the reason. A `not_ancestor` SHA still refuses the submit (ADR 300); the claim records the
   refutation when a submit carries one anyway through the CLI.
3. **The submitter files, the acceptor re-checks.** `lane_submit` / `musterd lane submit` (and a
   self-`resolve` carrying an attestation) file the claims this seat checked in its own clone. An
   `accept` answering a `lane_review` ask (ADR 202) carries this seat's re-check of the same refs —
   read from the ask's `lane_review.merged` and `branch` — as `meta.claims`. The daemon merges the
   two readings side by side on the lane: a seat's fresh reading of a (kind, ref) replaces its own
   earlier one; other seats' readings stay.
4. **The checker is the authenticated sender, never the body.** The daemon stamps `checked_by`
   from the seat that made the request — the PATCH's member on submit, the verdict act's sender on
   accept — whatever the body said. A seat cannot file a reading under another seat's name.
5. **Recorded where the ledger already reads.** The lane carries `claims`. The audit log gains
   `lane.claims_filed` (at submit) and `lane.claims_verified` (at accept), each with the counts and
   the (kind, ref, verdict) triples; `lane.ready_for_review` and `lane.closed` carry the claims
   summary. Verified-ness stays what ADR 169 derives — closer ≠ owner — and is not redefined by
   this ADR; the claims are evidence beside it, not a replacement for it.
6. **Degrade, never wedge.** A submit or accept without claims is accepted exactly as before. A
   checker failure (no `gh`, offline, not a clone) files `unverifiable`, never blocks. Claims on
   an older daemon are ignored by its schema and nothing else changes.

## Consequences

- `@musterd/protocol`: `claims.ts` (schema, `claimsFromEvidence`, `mergeClaims`,
  `summariseClaims`, `claimsLine`); `claims` on `LaneSchema` and `UpdateLaneSchema`. Hard rule 1
  satisfied by this ADR.
- `@musterd/server`: migration v95 (`lanes.claims_json`); the PATCH handler stamps `checked_by`;
  the verdict path (`applyAcceptanceVerdict`) reads `meta.claims`, stamps, merges and audits
  `lane.claims_verified` in the same guarded transaction as the close; `recordLaneClose` carries
  the summary. Federation: the hub's arbitration stores the joiner's stamped claims as it stores
  `merged`.
- `@musterd/mcp`: `mergeVerify.ts` grows `gatherClaimEvidence` / `checkClaims`; `lane_submit`,
  `lane_resolve` file claims and print `claims: …`; `team_send` with `act: accept` on a
  lane_review ask re-checks and reports `Your re-check recorded: …`.
- `@musterd/cli`: `commands/laneClaims.ts`; `lane submit` / `lane resolve` file claims and print
  them. `musterd send --act accept` does not yet re-check (the agent door is the adapter; a human's
  CLI accept files no claims — recorded as a gap, not a design).
- **What is NOT verified yet, by design:** tests re-run by the verifier (`ci_green` reads the PR's
  checks instead — one paid test run per PR, already paid), lane-state claims (the daemon's own
  record needs no claim), and anything about the diff's content. The vocabulary's next kinds need
  their own deterministic checker and a dated note here.
- The confirmed/unconfirmed outcomes are the first machine-produced quality labels on this team's
  lanes — the input the coordination-judge question (lane `01M0FS6J5AYBAT47MERMZTMC3N`) has been
  waiting on since ADR 110.

## Observability & Evaluation

- **Traces.** `lane.claims_filed` and `lane.claims_verified` audit rows (lane, by, counts,
  triples); `claims` summary on `lane.ready_for_review` and `lane.closed`; the claims themselves
  on the lane row. Spans: none new — these ride the existing lane transition events.
- **Eval.** Over lanes closed after this lands: the share of closes whose `lane.closed.claims`
  carries two checkers (submitter and acceptor); the share of claims `unverifiable` per kind and
  per harness (a high `unverifiable` on `pr_merged` means seats without `gh`); and the count of
  `unconfirmed` claims on lanes that nonetheless closed `done` — the number nobody else can
  print, and the one a human should read weekly. **Baseline:** before this ADR, 0 lanes carry any
  claim; ADR 300 verification tiers exist on `merged.verification` for MCP-door submits only.
- **Experiment.** One adversarial probe on the dogfood daemon: a seat submits a lane with a SHA
  that is on origin/main and a PR number that is NOT that SHA's PR. Expected: the submitter's
  `pr_merged` reads `unconfirmed` ("merged as …, not the attested SHA"), the acceptor's re-check
  agrees, and both rows show on the lane before anyone accepts. Confirms the rail refutes, not
  only confirms.
