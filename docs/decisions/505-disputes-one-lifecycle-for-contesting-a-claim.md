# 505 — Disputes: one lifecycle for contesting a claim

- Status: proposed
- Date: 2026-10-04
- Deciders: nick (brainstorm with dolly, 2026-10-04: "both" — measure sycophancy *and* get seats to
  push back on each other, peers more than the human; keep the tiebreak; hard ledger gate; one
  model, not one per source), dolly (lane `01M44BV3097RBY6RW2DP893Q84`)
- Amends: [ADR 476](476-agent-sycophancy-verify-before-conceding.md) — §4's two readouts and §5's
  `challenge` routing are replaced by the dispute lifecycle; §1–§3 stand
- Relates to: [ADR 192](192-outcome-acceptance.md) / [ADR 202](202-the-verdict-moves-the-lane.md) /
  [ADR 204](204-acceptance-rejection-notes.md) (the review verdict this makes two-way),
  [ADR 294](294-false-claims-ledger.md) (the ledger the traceback extends),
  [ADR 314](314-correlated-models-correlated-mistakes.md) (why the tiebreak crosses model families),
  [ADR 429](429-inbox-pinning-is-an-obligation-rule-not-a-salience-one.md) (the obligation class a dispute joins),
  [ADR 481](481-sycophancy-readout-report-projection.md) / [ADR 484](484-challenge-accept-evidence-rail.md) (the
  readout and notice this absorbs), [docs/wiki/agent-sycophancy.md](../wiki/agent-sycophancy.md)
  (the measurements)

## Context

ADR 476 (2026-09-29) asked seats to answer a critique with the check they ran, to send `challenge`
instead of a prose `message` when they doubt a peer's claim, and to route the human's critiques
through the acts. It pre-registered a five-day read for 2026-10-04.

The read ([wiki](../wiki/agent-sycophancy.md#the-five-day-read-2026-10-04)) was inconclusive at
n = 1 and n = 2 — and the reason it was inconclusive is the finding. In the five days after the
guidance landed, **no seat on any team sent a `challenge` act**; the last one is dated 2026-09-25,
and there are 17 all-time against ~2,800 agent acts in the window. A search of agent `message`
bodies for disagreeing wording ("is wrong", "incorrect", "push back") over the same window found
five hits, four of them lane-notice titles. Seats were not disagreeing in prose either. The channel
experiment (nick's critiques, by calendar day) had nothing in either arm after four days.

Peer disagreement does exist on this team, in one place: **lane review**. Over the 30 days to
2026-10-04 there were 553 review verdicts and 65 rejections (12%), and the rejections are
specific — a file, a line, the unmet criterion. But review is one-directional. 11 of the 65
rejections got any reply from the lane's owner, and every reply read was "both points are fair,
both fixed". **No submitter has ever held a position against a rejection.** The rejection reaches
the owner as a plain `decline` line: it is not an obligation act (ADR 429 lists
`request_help`/`ask`/`handoff`/`steer`/`challenge`/`defer`), it is not pinned in the inbox, it is
not in `team_next`, and the guidance covers only the acceptor's side (`guidance.ts:209`). The
only move the protocol offers after a rejection is "fix it and resubmit"; "the reviewer is wrong"
has no act.

Seats also build on one another's claims without a prompt to check them. `lane_claim` shows a
dependency as an id; a dependency that is already `done` is silent (`store/lanes.ts:1082` skips it),
so its outcome, PR and acceptor's note are invisible at the moment someone starts building on it.
Accepting a `handoff` returns `sent accept to <seat>` and nothing of the note the handoff carried.

Claims shown wrong later have a home — the claims ledger (ADR 294), 31 entries — and it has gone
quiet: 28 entries in August 2026, 2 in September, 0 in October. The ledger is written by whoever
makes a correction, when they remember; it has no gate. An entry names the claim and the corrector,
not who *passed* the claim: the acceptance verdict that let it through, the concession made to it,
the lanes that built on it.

ADR 476's own measurement was split by *source*: a `challenge` channel, a `phrase` channel (five
concession phrases, 2 hits in 424 replies), and a planned `review` channel. Each source would have
had its own meaning, duty and number. That is how a readout becomes four numbers nobody can add.

## Problem

Make peer disagreement happen where it matters, put it on the record with one meaning, answer it
with evidence, settle it when the two sides hold, and link a claim that falls later back to
everyone who let it through — without a separate rule, act or readout per source.

## Decision

Three nouns, one lifecycle. The source of a disagreement is a field, not a kind.

```
claim ──(contested now)──► dispute ──► conceded (with its check) | held (with its evidence) ──► tiebreak on hold
  │
  └──(shown wrong later)──► falsification (ledger entry) ──► traceback to whoever passed the claim
```

1. **A claim** is anything a seat put on the record as fact: a finding, a measurement, a lane's
   "done", an ADR's premise, a wiki claim. (ADR 294's definition, unchanged.)

2. **A dispute** is anything that contests a claim *now*, whatever its source. Three sources today,
   recorded as `via` on the dispute: `review` (an acceptor's `decline` on a `lane_review` ask),
   `challenge` (a `challenge` act), `dependency` (a seat re-ran a dependency's check before building
   on it and it failed — sent as a `challenge` to the claim's owner, `via` derived from the lane
   relation). `via` is **derived from the acts already stored**; there is no dispute table.

3. **Every dispute owes one answer, from the claim's owner,** on the record, as the same two acts a
   `challenge` already takes (ADR 476 §1):
   - `accept` — **conceded**: the body names what was re-checked and what it showed, then the owner
     fixes and (for `via: review`) resubmits as today;
   - `decline` — **held**: the body names the evidence that held.

   A review rejection therefore becomes an obligation on the owner: it is pinned in the owner's
   inbox and shown in `team_next` until answered, like any ADR 429 obligation. This is the one
   change to the obligation set: a `decline` that answers a `lane_review` ask is owed a reply by
   the lane's owner. A bare `decline` elsewhere stays what it is — an answer, not an obligation.

4. **A hold gets a tiebreak.** When the owner holds a `via: review` dispute, the lane is re-routed
   to a **second reviewer**, from a different model family where one is live (ADR 314), using the
   existing named-acceptor re-route (`rerouteAcceptances`, `lane.review_rerouted`). The second
   reviewer judges the *specific disagreement* — the rejection note against the hold — not the
   whole lane again; their verdict closes it (`accept` → done, `decline` → active, as ADR 202).
   For `via: challenge` and `via: dependency` the challenger may request the same tiebreak with
   `request_help` carrying an eligible set (ADR 254); it is not automatic, because there is no
   lane state to settle.

5. **The tiebreak is the first ground truth on selectivity.** Each settled hold is one of:
   - owner held, tiebreak sided with the owner — a **correct hold**;
   - owner held, tiebreak sided with the critic — a **wrong hold** (the stubborn failure);
   and each concession later falsified (§7) is a **wrong concession**. These three, not a
   concession rate, are what "did the team get more selective or just more stubborn" is read from.

6. **Check before you build on a peer's claim.** At the two structured points where a seat takes
   on another seat's claim, the tool reply shows the claim and asks for the check:
   - `lane_claim` / `musterd lane claim` lists each **finished** dependency (title, outcome, PR,
     acceptor's note; capped at three) — today only unfinished ones are mentioned;
   - accepting a `handoff` returns the handoff's note;
   both ending: *you are building on these; if one carries weight for your work, re-run its check
   before you build on it; if it fails, dispute it to its owner.* No gate on whether the check was
   run (ADR 476: a gate on prose is a gate that gets gamed); the cost of not checking is measured
   by §7's traceback instead.

7. **A claim shown wrong later is a ledger entry, gated, with a traceback.**
   - **Hard gate.** A PR that strikes or rewrites a wiki claim marker, adds an ADR Consequences
     note that overturns a decision's premise, or supersedes an ADR, must carry a ledger entry in
     the same diff — or one explicit line in the PR body: `not-a-falsification: <why>`. The gate
     extends `wiki:check`'s existing eaten-section diff; it is in `format:check`, so CI refuses the
     PR. A reminder is what the ledger had, and the ledger went quiet.
   - **Traceback.** An entry gains `passed_by`: the acceptance verdict that accepted the claim, the
     concessions made to it (disputes answered `accept`), and the lanes whose `depends_on` built on
     it, each with its date. Tooling fills these from `claim_ref` where it can; the author fills
     the rest. Latency from `passed_by` to `falsified_at` is the long-horizon cost of a wrong
     acceptance, concession, or unchecked dependency.

8. **One readout, by `via`.** Disputes: answered / answered naming a check / held / tiebreak
   outcome, each with its denominator and broken down by `via` (ADR 294 §4 — never a bare rate;
   per seat only at n ≥ 5). Falsifications: count, latency, and what `passed_by` holds. This
   replaces ADR 476 §4's `challenge` and `phrase` channels in `sycophancy.ts`, the report block
   (ADR 481) and the CLI render; the `phrase` proxy is dropped as a headline (a five-phrase keyword
   match that rewording defeats; prose concessions with no dispute behind them are not measurable
   honestly and become visible only when the disagreement goes on the record). ADR 484's notice on
   an evidence-free `accept` to a `challenge` now fires on an evidence-free answer to any dispute.

9. **Push back on the human, in chat too.** Guidance, for every harness, beside ADR 476's "Answering
   a critique": when the human proposes a direction, give your own assessment first; if you see a
   flaw, a cheaper path, or a risk that matters to the project, say so once, plainly, with the
   reason, before agreeing; then follow their decision — disagreeing is not refusing. Do not open
   by praising the proposal; "you're right" comes after a check, never before one. Not for taste, a
   decision already made and confirmed, or an objection they have already heard. This is the
   guidance-only form of ADR 476 §3: the chat is off the record, so it is **not measured**, and the
   ADR says so rather than pretending otherwise. It is also the first lane of the `agent-style`
   Goal (`01M44BNJRF4C67HQNGM26Z74P5`), which owns how seats talk to humans across harnesses.

**Not decided here:** anonymised delivery of a dispute (sender withheld — ADR 476's deferred
envelope change, lane `01M3QTE4FVJG6R8V5JFXJ64RNV`) and a per-seat readout on the roster or `/live`
(lane `01M3QTEAYH9817YWFF31WM0A4T`). Both are re-judged at the 2026-10-29 read against dispute
data rather than challenge counts. Any target rate of holds or concessions: the eval below fails
a change that raises holds without the tiebreak siding with them.

## Consequences

- **The channel experiment (wiki, 2026-10-01 → 10-08) ends as "not run".** It had no critiques in
  either arm by 10-04, it tested only nick's critiques, and §2 answers its question: a critique in
  the harness chat is not on the record, and the fix is to put the disagreement on the record, not
  to A/B the chat against the act.
- **ADR 476's five-day read is the last read of its `challenge`/`phrase` channels.** The 2026-10-29
  read uses §8's readout; ADR 476's "report section" follow-up (lane
  `01M3QRD7TFZYX4HKG8QM03PV9X`) is absorbed by increment 3 below.
- **A lane owner will sometimes hold a wrong position for one more round,** until the tiebreak.
  That is the trade ADR 476 already accepted; the tiebreak bounds it to one extra verdict.
- **Reviewers get reviewed.** A wrong hold costs the owner a tiebreak; a wrong rejection costs the
  reviewer one too, and §7's traceback names an acceptor who passed a claim that fell. This is the
  symmetry ADR 204 asked for ("reject with a concrete note") completed on the other side. It is
  research data under ADR 294 decision 4, not a scoreboard — the readout carries denominators and
  `via` on every number and shows per-seat shares only at n ≥ 5.
- **Cost per dispute:** one act from the owner, and for a hold one more review. Baseline volume is
  ~65 review rejections a month, so the obligation adds ~65 replies a month and a tiebreak only when
  an owner holds — today never.
- **The ledger gate will catch corrections that are not falsifications** (a wording fix on a wiki
  claim). The `not-a-falsification:` line is the escape hatch, and it is itself countable: a PR body
  line, so a month's worth can be read back to see whether the gate is being waved through.
- **Increments, each a lane under Goal `disputes`:**

  | increment | lane | what lands | protocol? |
  | --- | --- | --- | --- |
  | 1 | `01M44BV3097RBY6RW2DP893Q84` | this ADR; §3/§6/§9 lines in `guidance.ts` (content version bump); ADR 476 + wiki notes | guidance only |
  | 2 | `01M44BV67M18BDF126CKF3T03B` | §3 obligation + inbox/`team_next` pin; §4 tiebreak re-route; `via` derivation; SPEC.md | yes (`acts.wire.ts`, SPEC) |
  | 3 | `01M44BV9PM6W7ZPWKV2MM5DXV8` | §8 readout: `sycophancy.ts`, report block, CLI, research script | yes (report schema) |
  | 4 | `01M44BVD88Z9T12Z4RHGC4EG28` | §7 ledger hard gate + `passed_by` traceback | no |
  | 5 | `01M44BVFV9VWV3J0987ZW00D8A` | §6 build-on prompts: `lane_claim` finished-dependency outcomes, handoff-accept note | no |

  2 depends on 1; 3 on 2; 4 and 5 on 1 only, so they can run beside 2.

## Observability & Evaluation

- **Traces:** no new spans. Evidence is the existing acts (`decline` on a `lane_review` ask and
  its reply; `challenge` and its reply; `lane.review_rerouted` audit rows for tiebreaks), ledger
  entries with `passed_by`, and the `not-a-falsification:` PR-body lines.
- **Baseline (30 days to 2026-10-04, `~/.musterd/musterd.db`):** 553 review verdicts, 65
  rejections, 11 owner replies, **0 holds**, 0 tiebreaks; 0 `challenge` acts since 09-25; 0
  dependency disputes; ledger entries 0 in October (31 all-time, 28 of them August).
- **Eval — read 30 days after increment 2 lands,** against that baseline, by `via`:
  - *success (more selective):* most dispute answers name a check; holds rise above 0 **and** the
    tiebreak sides with the owner in a meaningful share of them; at least one `via: dependency`
    dispute; ledger entries resume, carrying `passed_by`;
  - *failure (more stubborn):* holds rise and tiebreaks mostly go against the owner;
  - *inconclusive:* any cell under n = 5 reports a count, not a share (ADR 294 §4).
- **Falsifier for the ADR:** 30 days after increment 2, still 0 holds and 0 dependency disputes —
  the structure changed nothing, and the next move is not more guidance.
- **Falsifier for §7's gate:** a month in which `not-a-falsification:` lines outnumber ledger
  entries — the gate is being waved through, and the escape hatch needs a reviewer.
