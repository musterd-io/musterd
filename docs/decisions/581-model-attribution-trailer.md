# 581 — Model attribution: daemon-attested, not a commit trailer

- Status: accepted (amended 2026-10-13 — izzo declined #2509 with three concrete problems; amended per docs/wiki/amending-an-adr.md; authorized_by: nick, on record in chat)
- Date: 2026-10-13
- Builds on: ADR 101 (attested, not verified), ADR 106 (unified git workflow), ADR 109 (seat-level git attribution)

## Context

The lane that raised this (01M4BVZV0KZ4F2WN0F668EBHGW, originally sloane's finding, 2026-10-07) noticed that `git log` can't
tally models: Claude-family seats carry a `Co-authored-by: Claude <model>` trailer (the harness adds one); every other
harness carries only the musterd seat trailer, or a harness-specific one like "Cursor". 612 Claude-seat commits on
`main` are model-tagged in a 30-day window; ~70 of 74 non-Claude-seat commits are untagged. Any attempt to answer
"which model did how much of the work?" from `git log` therefore returns a Claude-only result.

The obvious fix on paper: stamp every commit, on every harness, with a `Musterd-Model: <model>@<harness>` trailer from
the daemon's attestation (ADR 109 / 101 say the attestation already owns this), and add a gate so a commit from an
attested seat without such a line fails.

## Problem with that fix

1. **Git is the wrong carrier.** ADR 106 squash-merges; the model is not known at the git layer for non-Claude
   harnesses at commit time, and would have to be reverse-engineered from CI or attestation lookups.
2. **Two sources of truth for the same fact.** ADR 550 (accountable agents) and the homepage copy spec
   (`docs/design/homepage-copy-spec.md` §0.4) already state the in-product model line comes from the *presence record*
   ("`claude-sonnet-5-5`, `claude-code` read on 2026-10-09, not a commit trailer"). A second, git-derived answer to the
   same question has to be reconciled with it, forever.
3. **The analysis that motivated the lane has a correct source.** Mustering any model-share number should read the
   daemon's occupancy attestation (the same place the audit log and `musterd report` already take from), not `git log`.

## Decision

1. **The seat trailer (ADR 109 §2) is identity only.** `Co-authored-by: <seat> <seat@<team>.musterd>` answers
   "which seat". Harnesses *may* add their own model line alongside it; musterd does not require, parse, or verify it.
2. **Model attestation is daemon-side.** `occupancy.model_attested` _(Amended 2026-10-13: no `occupancy` table and no `model_attested` column exist in packages/server; the correct, live homes are `presence.model` / `presence.model_source`, `audit.actor_model` / `audit.actor_model_source`, and the act stamp `meta.model` / `meta.model_source` — see the Consequences amendment below)_ (ADR 101, ADR 158, ADR 246) is the single
   home for "which model did seat X run". Every readout, tally, or report that needs model attribution — including any
   "model share" or percentage number published anywhere — reads from the attestation table or the snapshot tooling,
   never from `git log`.
3. **No hook, no gate.** The deferred `prepare-commit-msg` trailer hook in ADR 109 §3 stays deferred; it is not
   the mechanism for model attribution, and no new one is added. A missing or wrong model line on a commit is neither
   a gate failure nor a review blocker.
4. **AGENTS.md is updated** (git workflow section) to state this explicitly, so no seat reinvests a session in
   trying to make every harness stamp a model line.

## Consequences

- External analytics that scrape `git log` for model share will still under-count non-Claude seats by design. That is
  the expected answer; the documented source of truth lives in the daemon's attestation store and the audit log already
  has the join (`musterd audit`, `musterd report`).
- Nothing changes in commit, PR, or merge plumbing. `per-worktree` seat identity (ADR 109 §1) and the seat trailer
  survive as before.
- The optional follow-up — a `musterd report` readout or dedicated command that produces the "model share of work" number
  from attestation — is out of scope for this ADR.

### Amendment 2026-10-13 — correction of the attestation source name (izzo, decline of #2509)

The original text of Decision 2 named `occupancy.model_attested` as the single home for model attestation. There is
no `occupancy` table in packages/server and no `model_attested` column; the event family is itself recorded under
the audit action label `occupancy.model_attested`, which is a *log entry*, not a table. The live and ride-along homes are:

- `presence.model` / `presence.model_source` (the attested model id and the tier that produced it, per ADR 101/158/246);
- `audit.actor_model` / `audit.actor_model_source` (the model recorded on each audited act, per ADR 101 audit-row attribution);
- the act stamp's `meta.model` / `meta.model_source` (the model attested on the sending occupancy at act time, per ADR 101/301).

Decision 2's wording in `## Decision` is frozen and is annotated in place with a dated marker rather than rewritten; the substance of the correction lives here and in the amended AGENTS.md line. No runtime, schema, or test change is implied by this correction — it names the columns readers should already be using.

### Authority

The decline reversed an agent-authored lane that descoped the lane's own acceptance criteria and changed an AGENTS.md norm, so it carries a human's yes: nick, on the record in chat (this amendment records it; the merge is re-attested `authorized_by: nick`). Izzo accepted the reasoning in Problems 1–3 and the call of "no hook, no gate."

## Observability & Evaluation

- Traces — attestation rows remain the observable: `presence.model` / `presence.model_source`, `audit.actor_model` / `audit.actor_model_source`, and the act stamp `meta.model` / `meta.model_source`; no new rows (`occupancy.model_attested` is the audit action label that names this event family, not a table or column).
- Eval — the invariant being protected: **zero** places in musterd (product or docs) cite a commit trailer as the
  authority for model attribution. Check by grep: no retired/legacy sources should name it; homepage-copy-spec §0.4 is
  the canonical note, and AGENTS.md gains a one-liner.

- Experiment — land ADR 581 on its own docs PR and re-run `git log` on `main` to confirm the 612 vs ~70 count is
  still recognisable as harness-asymmetry rather than per-seat; the absence of a `change-adr:check` (or other code)
  change is the signal that nothing runtime was expected to move.

## Follow-up / parking

The lane's original ask for "machine-readable model line per commit + a check so missing it fails" is explicitly
*declined* by this ADR: it would add a second, unverifiable source of a fact that already has a home. Anyone who wants
the tally should build the read-side (attestation report), not the write-side (commit trailer).
