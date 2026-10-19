# 665 — The accountability message: a person at both ends of every piece of work

- Status: proposed — 2026-10-19 (nick's acceptance; drafted by alfie in session with nick)
- Date: 2026-10-19
- Lane: `01M5AQENWA3HN55WPSRXNAV7YW` (goal `accountable-agents-positioning`)
- Amends: [ADR 550](550-positioning-accountable-agents.md) §2 (the moat is kept; its order stops
  being the message order) and §3 (the chain table, re-read on 2026-10-19). The claim stays
  [ADR 563](563-the-claim-is-the-team.md)'s.
- Relates to: [ADR 109](109-seat-git-attribution.md), [ADR 158](158-model-attestation-truth.md),
  [ADR 188](188-graded-review-ladder.md), [ADR 234](234-tiered-acceptance.md),
  [ADR 629](629-lane-requested-by.md), ADR 662 (human authority needs a device signature, decided
  2026-10-19), [ADR 571](571-day-in-the-life-replaces-the-chain.md)

## Context

nick pitched musterd twice in October (Demo Day 2026-10-09, and the standing deck since). The
questions that came back are the ones every room will ask: how is this different from Claude
calling Codex for a review, how is it different from the forty products in the same cell, who pays
and how much, why let you near my data, what survives the next model.

Drafting the answers on 2026-10-19 showed the problem. Every answer that distinguished musterd
did it with a mechanism: the model is on the record, acceptance comes from a different member, an
agent can decline. nick, in session: those are "not powerful enough on their own"; an investor does
not know what they mean, why they matter, or what they add for the user. ADR 563 made the same
finding for the tagline on 2026-10-12 (a subhead names what the reader gets before it names how)
and the rule never reached the deck's slide 12, the Q&A bank, or the spoken answers.

Two outside facts arrived the same day and give the message its ground:

- **The buyer's situation has a number.** SecurityHQ and Datadog surveyed 204 security leaders at
  midsize and large organisations (published 2026-10-15): 45% had already had an incident
  involving AI agents or automation "where accountability was unclear", and 49% could fully
  reconstruct every action an agent performed over the previous 30 days. After a critical incident,
  17% could reconstruct it within minutes. A vendor survey; it is quoted with its sponsor and date.
- **The trackers say the gap out loud.** Linear's agent guidelines: "an agent cannot be held
  accountable", so an issue is only delegated to an agent and a human stays the assignee
  (linear.app/now/our-approach-to-building-the-agent-interaction-sdk, read 2026-10-19).

And our own record, read on 2026-10-19 for the 30 days before it (`~/.musterd/musterd.db`,
team revive):

| Link in the chain                               | Last 30 days                      | Strength                                                 |
| ----------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| Who signed off on the merge                     | 922 of 967 done lanes name nick   | attested by the seat (ADR 109); the daemon cannot see GitHub |
| Who accepted, enforced to be another member     | 1,045 review verdicts on 742 distinct lanes: 942 accepted, 103 sent back (9.9%) | verified (ADR 188, ADR 234); of the 967 done lanes, 846 closed on a verified ancestor merge, 112 with no merge, 15 with a failed or unattested check |
| Which model                                     | every act and presence            | observed by the harness (ADR 158, ADR 163)               |
| Who asked for the work                          | 286 of 348 lanes opened since ADR 629 landed on 2026-10-16 (82%), 272 naming a person; 56 of 967 over the whole 30-day window | basis `stated` on all but 11: the seat's word, none verified against an act or seed (schmidt, 2026-10-19: the 30-day denominator spans 27 days before the column existed) |
| A human's signature on accept, approve, grant   | none                              | ADR 662 decided 2026-10-19, not built                    |
| Declines and challenges                         | 131 declines, 3 challenges, all agent to agent; nick answered 128 of 216 asks | real on review verdicts; rare as refusals of a handoff or a challenge to a person |

So today the record shows a person at the end of 95% of our landed work, attested; and since the
column exists, a person named at the start of 78% of lanes opened, on the seat's word.

The Dunford components, as this proposal reads them ([positioning-and-gtm](../../.agents/skills/product-communications/references/positioning-and-gtm.md)):

1. **Alternatives** the best-fit team has today: one agent at a time with the person reviewing
   by eye; Claude Code's Projects beta, where a coordinator splits a goal into threads and reviews
   their output itself (press coverage of the 2026-09-17 announcement); a tracker where the agent
   is a delegate and the person stays accountable (Linear, Jira); a relay that shows an owner and
   a harness and has no acceptance (Agent Relay, agentrelay.com, read 2026-10-19).
2. **Capabilities none of them has**, each with its record: acceptance enforced from a different
   member (ADR 188, ADR 234); the observed model on every act (ADR 158); a decline and a challenge
   as acts (ADR 103); who asked on the lane (ADR 629); a human signature the daemon will refuse an
   authority act without (ADR 662, not yet).
3. **Value, in the buyer's words.** When something goes wrong I can show who asked, who did it,
   who checked it and who signed it off, in one read. Nothing my agents do counts as done on their
   own word. When a model goes bad I can list every piece of work it touched.
4. **Best fit** is unchanged (ADR 550 §4, ADR 578): small product and engineering teams and solo
   builders running several agents; then any team doing knowledge work.
5. **Category** is unchanged (ADR 563: the team). This ADR is messaging under that position.

## Problem

Decide the accountability message so that it names what the buyer gets, carries the SecurityHQ
situation as its "before", and uses the mechanisms as proof under it; and decide how far the
message may go while the record holds a person at one end of the work and a signature at neither.

## Decision

### 1. The accountability message is one outcome, stated before any mechanism

The supporting message under the tagline, on every surface that argues the case (deck, Q&A,
investor notes, the site's record section), is:

> **Nothing your agents do counts as done until another member checks it.** The record shows who
> did it, who checked it, and which model.

Chosen by nick on 2026-10-19 from three candidates (Consequences). It rests on the verified link,
acceptance by a different member, and says the record's contents in the order a buyer asks for
them. "A person at both ends" is the section title only; it names where the message is going (§3),
never a sentence a speaker says. No sign-off, no approve, no reconstruct, no "in one read": each
of those is either a supervisor's verb, the survey's forensics word, or a surface that does not
exist yet (wanderer).

The SecurityHQ and Datadog figures (nearly half, 45%, of 204 security leaders had already had an
agent incident where nobody could say who was accountable; only half, 49%, could fully reconstruct
what an agent had done in the last month; published 2026-10-15) are proof for an enterprise room,
said under §2 with sponsor and date and never rounded up. They do not open the message: the
best-fit buyer is a small product team, and a security-leader scene selects the other room.

### 2. The mechanisms are the proof lines, each phrased as what it buys

Under the message, three lines, in this order, each with its number and its record:

1. **Nothing counts as done on an agent's own word.** Another member accepts it, and the daemon
   enforces that it is a different member. In the last 30 days on our own team, one landed piece
   of work in ten was sent back. (ADR 188, ADR 234; the 942 / 103 read.)
2. **You know which model touched what.** The model the harness observed is on every act, so when
   a model misbehaves you list its work. (ADR 158, ADR 163.)
3. **A person signs off what lands.** 922 of our last 967 landed lanes name the person who
   authorised the merge, on the seat's word. A signature the daemon refuses the sign-off without
   is decided and not built yet; it is said exactly so, never as "soon". (ADR 109; ADR 662.)

"An agent can decline" leaves the headline lines. It appears only where the record shows it: as
the one-in-ten review refusals, and as a fact about the protocol in technical docs. It returns to
a headline line when declines of handoffs or challenges to a person appear in our own record
(ADR 550's refusal test, still open).

### 3. How far the message may go, by what the record holds

"A person at both ends" is where the message is going. The record holds one end. So:

- **Until** `requested` (ADR 629) names a person, or carries a verified basis (`act`, `seed`), on at
  least nine in ten lanes opened in a 30-day window (a seat's `self` does not put a person at the
  start) **and** ADR 662's signature is enforced on `authorized_by`, and on human accept where a
  lane requires one (schmidt: on 95% of lanes the person at the end is the merge sign-off, so a
  gate on accept alone would never make "every" true), the spoken and written form is §1's
  sentence exactly. "Who asked" stays out of it and is said, when asked, as "recorded from this
  month, on the seat's word".
- **"In one read" is not yet.** `musterd lane show` and `lane_show` print the owner and the merge
  sign-off; who asked and the review verdict are not on the same page (checked 2026-10-19 against
  `packages/mcp/src/tools/laneShow.test.ts`). The phrase waits for a surface that shows the whole
  chain of one lane on one page, named in the ledger.
  Follows-up: a lane for the one-page chain on `lane show`, opened when this ADR is accepted.
- **From** both conditions, §1's second sentence gains the start of the chain: _"The record shows
  who asked, who did it, who checked it, and which model."_ The sign-off joins it only as proof
  line 3, attested, and the section title can then be said as a sentence.
- The record "shows" the chain; it never "proves" it (ADR 550 §7, brand.md §1), and the merge
  sign-off is said as attested, never as verified, until the daemon can see the merge.

### 4. What changes on which surface

| Surface                                                       | Change                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `docs/demo/pitch/script.md` slide 12 and "Questions to expect" | the mechanism lines become §2's proof lines under §1's message; the nine answers drafted 2026-10-19 are rewritten to it; new ledger rows for every number above |
| `docs/demo/pitch/deck.html` slide 12                           | the musterd row reads §1's message, the three proof lines under it                     |
| musterd.io record section (ADR 571's DayInTheLife captions)    | the three steps that state the record carry §2's phrasing; no new section              |
| `docs/design/brand.md` §1 "claim discipline"                   | gains §3's rule and the two conditions                                                 |
| `docs/design/landscape.md`                                     | the Linear quote and the SecurityHQ figure as dated entries with `review_by`           |

Strings stay off every surface until nick accepts this ADR. The surfaces change in follow-up
lanes, one per row, opened on acceptance.
Follows-up: a lane per row above, opened when this ADR is accepted; the deck and Q&A lane first.

### Rejected

- **Keeping the moat order as the message order** (ADR 550 §2): the order is still right for what
  is defended, and wrong for what a listener hears first. Refusal is the rarest thing in our own
  record and was the first thing we said.
- **Leading with the model on the record.** It is the most distinctive mechanism in the field table
  (landscape.md §14d) and the one a buyer least knows they need. It stays as proof line 2.
- **Saying "a person at both ends" as a sentence, now or later.** The record holds one end,
  attested, on 95% of lanes; the other is on the seat's word. Hard rule 1 of the
  product-communications skill forbids it as a guarantee, and three readers heard "signed off" and
  "reconstruct" as oversight (wanderer, sloane). It stays a section title.
- **Opening with the security survey.** It is the strongest number in the ADR and it selects the
  wrong room: the best-fit buyer is a small product team (ADR 550 §4). It is proof, under §2.
- **Making accountability the tagline again.** ADR 563 found it sorts musterd into oversight. The
  tagline is the team; this message sits under it.

## Consequences

- Two lanes opened the same day on the second half of the session: goal `cooperbench`, lanes
  `01M5AQE75KE5QVDX90W293AKXJ` (OpenHands adapter) and `01M5AQEG23ANGVWR5F9EQGHPPH` (the
  pre-registered pilot). CooperBench (arXiv 2601.13295) measures agent-to-agent coordination with no
  person on the team, so a score there is evidence for the team claim and none for this message.
- ADR 629 adoption and ADR 662's build are now preconditions of a public sentence, as the
  `security` goal already was for ADR 550 §7. The seats that own them should know a copy line waits
  on them; this ADR says so and asks nothing more of them.
- The deck's Q&A answers drafted on 2026-10-19 (nine questions) are rewritten to §1 and §2 in the
  first follow-up lane, with ledger rows for Band ($17.99), Party ($20 / $200), Conductor ($50 /
  $60), Agent Relay (free to start), CooperBench (0.48 → 0.28, 0.47 → 0.26), Claude memory import,
  the SecurityHQ figures and the 24,768-act count, each with its read date.
- landscape.md cites "When More Is Less" as arXiv 2609.19759; that identifier did not resolve on
  2026-10-19. It is not quoted until found.
- **2026-10-19, reviewed by sloane and schmidt at nick's ask** (acts `01M5ARFAZZJTF1QYCR45WZHMSA`,
  `01M5AS1ZG9ZGBBPT7KC42D6CAE`). Taken into the text the same day: the who-asked denominator
  (since ADR 629 landed, by basis and asker kind), the verdict unit (acts on distinct lanes) and the
  closure kinds, the signature condition on `authorized_by`, "in one read" marked not yet, the
  survey figures unrounded, "soon" removed. Left to nick: sloane's alternative sentence (§1) and
  weaker form (§3). The four queries are pinned in `docs/demo/pitch/chain.sh` so the monthly re-read
  is the same read (ADR 658 keeps agent seats off the database; the script is the human's).
- **2026-10-19, wanderer's review and nick's pick** (act `01M5AV72JRW60QAWZ2W1QKSCQX`). wanderer:
  §1 as first written ("a person at both ends", "signed it off", "reconstruct") is heard as
  oversight, ADR 550's console test fires on the sentence alone, and every candidate ended in "in
  one read", which §3 itself marks not yet. He proposed the shorter form. nick chose it over
  sloane's ("…and a person approves what lands…") and alfie's ("…a person who signed it off…") the
  same day; §1, §3 and Rejected are rewritten to it in this change, and the survey moves under the
  proof. wanderer's points on the CooperBench pilot (a frozen manifest, a solo arm so the gap is the
  pool's own, a per-task verdict, guardrails pinned to the paper's scorer) went into lane
  `01M5AQEG23ANGVWR5F9EQGHPPH`'s brief.
- No code changes. No glossary changes. No protocol changes.

## Falsifiers

- **The both-ends test (§3).** If `requested` fill stays under five in ten lanes opened by
  2026-11-30, "who asked" leaves every sentence, including the weaker form, until adoption moves.
- **The message test.** Score §1 with real readers in the next three rooms (clarity, relevance,
  differentiation; k of n with their words). If fewer than half can say back what the product does
  for them from §1 alone, the sentence is rewritten; if a listener describes musterd as oversight or
  a control plane after hearing it, ADR 550's console test has fired and §1 reopens.
- **The number test.** The SecurityHQ figure is re-read before each use; if the survey is withdrawn
  or restated, the "before" scene is dropped rather than paraphrased.

## Observability & Evaluation

- **Traces:** n/a — a positioning message emits nothing; the act log and the lanes table already
  hold what the falsifiers read.
- **Eval:** the chain table in Context, re-read monthly by running `docs/demo/pitch/chain.sh`
  (done lanes with `merged_json.authorized_by` and their verification; lane-review verdicts as acts
  and as distinct lanes; `requested_json` fill since ADR 629 by basis and asker kind; declines and
  challenges by sender and recipient kind; asks to humans answered), recorded here as dated notes.
  Baseline: the 2026-10-19 row. The message test above, reported k of n after each room.
- **Experiment:** none scheduled for the message. CooperBench is its own goal with its own
  pre-registration and does not test this ADR.
