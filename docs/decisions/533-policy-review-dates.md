# 533 — Policy review dates: a stored policy doc carries `review_by`; past it, the admins are asked to re-confirm or drop it

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (the lane's brief: "a knob past its review_by raises one admin ask; re-confirming
  moves the date, unsetting restores the default")
- Lane: `01M46S472ZE7JWNHZXF5GHE4HG` (goal `memory-and-rules`)
- Design: [docs/design/memory-and-rules.md](../design/memory-and-rules.md) §The rule store, policy
  tier — principle 2, "every rule has an author, a scope, and an end — … a review date for policy"
- Builds on: ADR 185 (sparse team policy — the stored doc is the set of knobs an admin chose), ADR
  367 / 398 (policy is hub-owned and replicates as `policy.change`), ADR 172 (admins are human,
  enforced at the read since #2092), ADR 516 increment 3 (a human admin's `accept` on a daemon-marked
  ask IS the act — the shape this copies), ADR 225 (server-controlled meta is stripped off a client
  copy), ADR 232 (ledger seats: a service seat may author acts, never own a lane), ADR 443 (a
  non-directed `ask` rings the admin humans). Precedent for the stale date:
  `docs/controls/registry.ts` `staleAfterDays`.
- Protocol change: yes (hard rule 1) — `review_by` on `PolicyOverrideSchema`; the `policy_review`
  ask marker; audit verbs `policy.review_due` / `policy.review_answered` (local, not replicated).

## Context

Team policy is the rule store's top tier: `POST /teams/:slug/policy` by a human admin, enforced by
the server, replicated to every machine. Since ADR 185 the stored doc is sparse — only the knobs
somebody chose — so the doc is also the exact list of decisions a team is living under that nobody
re-derives from a default.

Nothing ever asked anyone to look at it again. The design doc's gaps list said it plainly: "a knob
set once stays forever without anyone looking again." The controls registry solved the same problem
for CI gates two months earlier with `staleAfterDays` — a declared date past which a control is
flagged until someone re-exercises it — and recorded why a date beats good intentions: the gap
between "a gate exists" and "someone looked" is where rot lives.

## Problem

A rule with no end is a rule whose author's intent cannot be checked against the present. Holds got
an expiry (ADR 516); halts end when a human resumes (ADR 501). Policy — the one tier that is
enforced on every call and copied to every node — had no end and no review, so the team could not
tell a knob nick chose last week from one he chose in July and forgot.

## Decision

1. **The stored doc carries `review_by`.** `PolicyOverrideSchema` gains `review_by?: number`
   (epoch ms). It is a property of the DOC — the sparse set of chosen knobs that one `POST /policy`
   replaces whole — not of each knob: the doc is the unit an admin writes, confirms or drops, so
   it is the unit that is reviewed. The effective policy (`PolicySchema`, what every reader
   consumes) never carries it; it is not a knob.
2. **The server stamps it on every write that stores a knob.** `applyPolicyChange` runs
   `stampReviewBy`: a doc with no `review_by` gets `now + 90 days` (`POLICY_REVIEW_DEFAULT_MS`);
   one named is kept if it is in the future and at most 365 days out (`POLICY_REVIEW_MAX_MS`), else
   `validation`. An empty doc (`{}`) carries none — defaults need no review, and "drop everything"
   is how a review ends with no. The stamp rides the same `policy.change` every machine folds, so
   every node agrees on the date.
3. **The CLI treats a knob write as a review.** `musterd team policy --review-by <YYYY-MM-DD |
   +<duration>>` names a date. Any other write DROPS the stored date from the read-merge-write doc so
   the daemon re-stamps the default window: an admin who read the whole readout and changed a knob
   has reviewed the doc, and carrying the old date through would let a just-reviewed doc fall due.
   The readout shows `review by: <date> · in Nd`, or `overdue — answer the policy ask, or set
   --review-by`.
4. **Past the date, one ask to the admins — asked once per date.** An hourly hub-side sweep
   (`policy_review` loop; a joiner never asks, since policy is hub-authoritative and two daemons
   would ask twice) finds every team whose stored `review_by` has passed and for which no
   `policy.review_due` audit row names that date, and raises ONE `ask` (species `approve`, tier
   `standard`) from the `policy` service seat (minted on first use, ADR 232; refused if the name is
   held by a non-service seat) to the Team — a non-directed ask rings the admin humans (ADR 443).
   The body names the date and the chosen keys and says what each answer does. `meta.policy_review
   = {review_by, keys}` marks it; a client copy is stripped (ADR 225), because a forged marker would
   let a seat mint an ask whose `accept` rewrites team policy. The audit row is the receipt, so the
   sweep is idempotent across restarts.
5. **A human admin's answer IS the act** (ADR 516 increment 3's shape). An `accept` naming the ask
   in `meta.in_reply_to` re-confirms: every knob stays and `review_by` moves to the default window
   from now. A `decline` drops: the doc becomes `{}` and every default comes back to life. Either
   rides `applyPolicyChange` as the human (forwarded to the hub when the answering daemon is a
   joiner), is audited `policy.review_answered {ask, verdict}`, and is announced once to the Team as
   the human (`[policy] re-confirmed by nick — next review 2027-01-04` / `[policy] dropped by nick —
   every knob is back at its default`). An agent's answer, a non-admin's, or a second answer changes
   nothing. Silence changes nothing either: the doc stands, overdue, and the readout says so — a
   review is a question, not a timer that unsets rules behind the admins' backs.
6. **No MCP tool writes policy**, as before. Agents see the ask like any Team ask and may say what
   they think in prose; only a human admin's `accept` / `decline` moves anything.

### Rejected

- **Per-knob review dates.** A parallel `{knob → date}` map alongside a doc that is replaced whole
  on every write; two shapes to keep aligned for a question ("is this team's policy still what
  someone meant?") that is asked of the doc.
- **Expire policy like a hold.** A knob that silently reverts at a date is a rule the team was
  under one minute and not the next, with no human in the loop — the surprise the rule store exists
  to prevent. Policy ends by a human's answer; the date only asks.
- **A default review date of "never" (opt-in).** Then the gap stays for every team that never opts
  in, which is every team. Principle 2 says every rule has an end; the default has to be a date.

## Consequences

- _Dated note (2026-10-06):_ nick set revive's first date the hour the build landed (`--review-by
  +90d` → 2027-01-04), then asked whether 90 days was right. Assessment: 90 was a prior by analogy
  (the controls registry's 90–120 days), not a measurement; revive's knobs were set during specific
  arcs (dispatch loop for ADR 199, trace content for ADR 445) that end faster than a quarter, and one
  approve ask per cycle costs seconds, while a stale enforced rule costs weeks. Decision: the default
  stays 90 for teams in general; revive runs at 30 (`--review-by +30d` → 2026-11-05) as the
  experiment this ADR's eval names — if the first ask surprises nick, 30 was right; if two reviews in
  a row are boring, stretch it. The counter-risk is ask fatigue turning the review into a reflex.
- revive's stored doc gains a `review_by` on its next policy write; until then it carries none and
  is never asked (a doc with no date is not overdue — the stamp is the server's, on write). A
  one-time `musterd team policy --review-by +90d` gives it one without changing a knob.
- The ADR 185 tests that pinned the stored doc's exact shape now expect `review_by` beside the
  chosen knobs; the audit's `policy.change` detail carries it too, so a reader of the ledger can see
  when each doc was due.
- `musterd team policy --review-by` is the first policy flag that is not a knob. The readout line
  is the only place a date shows; `/live` does not render it (the ask is what a human sees).
- A team that never answers accumulates exactly one open ask per overdue date, never one per hour.
  The digest's "unanswered asks" will carry it, which is the intended pressure.
- Follows-up: none — the lane's accept criterion is met in full.

## Observability & Evaluation

- **Traces:** audit rows `policy.review_due {review_by, ask, keys}` (actor none) and
  `policy.review_answered {ask, verdict, review_by}` (actor the human); the `ask` act carrying
  `meta.policy_review`; the human's `policy.change` with the new `review_by`; the `[policy]` Team
  message; log lines `policy_review_asked` / `policy_review_sweep_failed`.
- **Eval:** the design doc's gap closes when every team with a stored knob also has a `review_by`
  and no doc stays overdue past one working week without an answer. Read: `SELECT policy FROM teams`
  for `review_by` presence; `musterd report delivery` for open `policy` asks older than 7 days.
  Baseline 2026-10-06: revive's doc has knobs and no date.
- **Experiment:** the first revive review falls due 90 days after the next policy write; record
  whether nick answers it from the inbox or from `--review-by`, and whether a knob in the doc
  surprised him — a yes is the finding this ADR exists to produce.
