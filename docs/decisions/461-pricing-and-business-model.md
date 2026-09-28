# 461 — pricing and business model: self-hosted free and uncapped, hosted free for two humans, then paid per human seat

- Status: proposed — 2026-09-28 (nick's acceptance; the team argues with it first)
- Date: 2026-09-28
- Lane: `01M08Y95JDB42EPWR6GXHZSZNZ` (goal `launch`; opened by dolly 2026-08-17 as "the one
  unwritten piece of the launch arc")
- Builds on: [ADR 320](320-positioning-the-value-prop-decided.md) (the positioning, not
  re-litigated here), [ADR 122](122-cookoff-value-experiment.md) / [ADR 123](123-cookoff-measurement-protocol.md)
  (the value proof and its measurement), [ADR 039](039-cross-network-topology.md) and
  [`deployment-topology.md`](../design/deployment-topology.md) (Topology C, the hosted relay),
  [`traction-plan.md`](../design/traction-plan.md) §3 (the north star and the first user),
  [`landscape.md`](../design/landscape.md) §5/§12/§13 (Band, Multica, the seed money),
  [`PRIVACY.md`](../../PRIVACY.md) (no phone-home, no usage analytics in the product).

## Context

Every other piece of the launch arc is written down: the positioning (ADR 320), the value proof
(ADR 122/123, finding 006), the install path (ADR 156/298), the site (ADR 302), the traction plan.
Nothing says how musterd makes money. The lane's brief asks for an ADR the team can argue with:
options weighed, one recommended, falsifiers named.

Four facts constrain the answer, and the decisions below were reached in a design conversation
with nick on 2026-09-28 by settling each in turn.

1. **What revenue is for.** It funds the work. The traction plan's north star is "a path to getting
   paid to keep building musterd, with open-source visibility and collaboration as a hard
   constraint". Of the four paid outcomes that plan names, the one this ADR designs for is a
   **funded company**: the model is what a round is raised on, and product revenue follows.
   Services-first and the PM track stay as fallbacks the plan already carries.
2. **The users are known and small.** ADR 122: "first target: solo builders and small teams, where
   the user is the buyer". The traction plan's first user is one developer running two harnesses;
   the second is a team of 2–5 on one repo, and "the first is the same person who later brings it
   to the second".
3. **The product is local-first and does not phone home.** `PRIVACY.md`: no account, no musterd
   cloud, no usage analytics in the product. A seat cap in the self-hosted daemon is therefore a
   number in code, and usage-based billing has nothing to bill from. That is a design boundary, not
   an obstacle to route around.
4. **The market has priced the cell.** Band raised $17M on a hosted room where cross-framework
   agents converse; Multica has ~47k stars on "Apache 2.0 + hosted-service conditions"; Pilot
   Protocol and xpander raised $4.5M and $7.5M in adjacent cells; three labs sell hosted
   "teammates". Every one stops at the wall musterd is built past (one owner's walls, no teammate
   who can decline), and every one of the funded ones is a **hosted** product.

Two things nick settled that this ADR would otherwise have got wrong. The traction plan's hard
constraint is open-source *visibility*, not the MIT license itself — the license was a live option
here, and it stays MIT by decision, not by inheritance. And the free/paid line is a **team-size
line**, not a hosted-vs-local line: the free tier is the solo developer and the one colleague they
bring; the third human is where a team has formed.

## Problem

Write down a model that (a) a round can be raised on, (b) keeps the open-source track load-bearing
for that raise, (c) charges for something musterd can actually enforce, given no account and no
phone-home in the product, (d) does not penalise the thing the product exists to multiply (agents on
the team), and (e) anchors its price to the value proof rather than to a guess — with the proof's
own caveats carried, not hidden.

## Decision

### 1. Self-hosted musterd is free forever, and uncapped

Everything that runs on a machine you own or an overlay you operate: the daemon, the CLI, the MCP
adapter, `/live` and the other served surfaces, every act, lane, seat, report and trace view, and
federation between your own machines (ADRs 325–360). Any number of humans, any number of agents.

**No seat cap lives in the repository.** A cap in MIT code is unenforceable, invites the fork, and
puts a wall into the first thing a funder reads. The open-source track is what the raise reads;
it stays whole.

### 2. musterd Cloud: free for two humans, paid from the third, per human seat

The hosted product is Topology C from `deployment-topology.md`: a musterd-operated relay and hosted
teams, so that a team is reachable across people and networks with nothing to run — no daemon, no
overlay, no port — and a phone joins by OAuth (ADR 446/450, built for the demo). It is the "just
works" path, and it is what the funded comparables say buyers picture.

- **Free: a team with up to two human members.** The solo developer, and the one colleague they
  bring. Neither pays. This is the whole first-to-second-user path of the traction plan, kept free
  so the product travels.
- **Paid: from the third human member**, per human member, per month. The third human is where a
  team has formed, and a team is what a budget is for.
- **Agents are never counted.** Members are the ontology's unit (a Member is an identity, not a
  session), but the human seat is the *billing* unit. Charging per agent would tax the thing the
  product exists to multiply, and "executions vs seats" is already the contrast this project draws
  against Band (`landscape.md` §5) — a seat is a durable identity, so the count that matters is how
  many people are in the room.
- **Enforceable where it is charged.** Cloud knows its roster; the cap is a server fact, not a
  number in a binary. Self-hosted carries no cap because nothing there could hold one.

### 3. Org tier: governance features by license key, hosted or self-hosted

For teams that cannot use hosted, or need what a governance buyer asks for (`landscape.md` §13a:
Gartner's "only 13% of organizations believe their agent governance is adequate"): SSO, signed and
exportable audit, retention and content-trace policy packs (ADR 445 §3's `trace.content` and the
30-day lifecycle become policy an org can set and prove), multi-team administration, and support.

Same binaries. Features unlock by a license key the org holds; the key gates *org* capabilities,
never the team layer, and never the seat count — §1's "uncapped" holds with or without a key. This
is the second revenue line, and the one that survives if hosted turns out not to be the buyer's
shape (§Falsifiers).

### 4. The license stays MIT; the hosted product is protected by execution

Considered and declined: a Multica-shaped source-available license with a hosted-service clause,
and a time-delayed fair-source license (FSL/BUSL). Both protect the hosted line; both cost the
"open" that the raise reads first, and both need a relicense announcement at exactly the moment the
launch post goes out. The decision is to compete on being first, best-run and integrated, and to
accept a fork-and-host competitor as a named risk (§Falsifiers) rather than a licensed-away one.

### 5. The price is anchored to the value proof, as ranges with a falsifier

The pitch-to-price story is finding 006's: on the cookoff fixture, wasted work fell from **65–83%
uncoordinated to 0.6–10.6%** with musterd's gate on, across three model configurations. The
finding's own caveat is carried verbatim: this is a *pilot*, and the spread "is suggestive, not
yet the controlled comparison" ADR 122 asks for, and the cookoff refresh lane (`01M1VDRC6B`) exists to
re-date it on today's build.

So the price rule, not a price: **a Cloud seat is priced well under one hour a month of the agent
compute it saves that team.** A small team already paying for two or three agent harnesses spends
more per week on duplicated and discarded work than a seat costs per month, if the pilot's gap
holds even at a fifth of its size. Concrete figures are set with design partners (`traction-plan.md`
§6, weeks 3–6), recorded here as a dated Consequences note when they exist, and never invented in
advance — an invented number in a pricing page is the one lie a stranger can check.

### 6. What this does not decide

Billing mechanics, a pricing page, the hosted product's build order (it is `ROADMAP.md`'s "Hosted
rendezvous relay (Topology C)"), the org tier's exact feature list at launch, and the launch post —
the lane's brief says pricing does not gate the post, and it does not.

## Considered and rejected

- **Hosted paid, local free, no seat cap on hosted.** The first draft of this ADR. It charges every
  hosted team from the first human, which taxes exactly the free path the traction plan needs — the
  solo user bringing one colleague. The team-size line keeps that path free where it matters.
- **The two-human cap everywhere, by license key.** One story instead of two, but the cap would sit
  in MIT code where it cannot be enforced, and a wall in the repo is the wrong first page for a
  raise. Rejected on enforcement, not on principle.
- **Per-agent pricing.** Simple to meter, and the wrong incentive: it charges for the thing the
  product multiplies, and it is Band's unit (executions) wearing a seat's name.
- **Usage-based pricing.** Nothing to bill from: `PRIVACY.md` promises no usage analytics in the
  product, and a hosted product that metered acts would be re-deciding that promise through a
  price. If it is ever wanted it is its own ADR, and `PRIVACY.md` changes in the same commit.
- **Relicensing** (source-available or fair-source): declined in §4.
- **Services / design partners as the model.** Paid pilots are how the price gets set (§5), not what
  is sold; the traction plan carries them as a fallback outcome, and this ADR does not make them
  the product.

## Consequences

- `PRODUCT.md` gains one line pointing here under a new "Business model" heading; `ROADMAP.md`'s
  hosted-relay item is the build that makes §2 real and is not re-described here.
- The open-source repo does not change: no cap, no key check, no telemetry. The org tier's key
  gating is a build for a later ADR, scoped to org capabilities only.
- Named risk, accepted: a competitor forks the MIT daemon and hosts it. The counter is execution
  (§4); the trigger to revisit the license is in §Falsifiers, and it is a separate ADR if pulled.
- Named risk, accepted: the two-human free tier is generous enough that a 2-person shop never
  pays. That is the intended shape — the buyer is the team of 3–5 and the org — and the falsifier
  below measures whether the third human converts.
- Dated notes go here as design-partner figures, conversions and the cookoff refresh land.

## Observability & Evaluation

- **Traces:** none in the product — `PRIVACY.md` holds. Cloud's own roster (humans per team, paid
  seats) is the record, aggregated, on the hosted side only.
- **Eval / falsifiers, each with a date:**
  1. *The line is wrong* if, across the design-partner window (`traction-plan.md` §6, through
     2026-11-20), no team that reaches a third human on Cloud converts, or if every serious
     conversation wants the org tier before hosted. Then the org tier leads and Cloud follows.
  2. *The price story collapses* if the cookoff refresh (`01M1VDRC6B`) on a September build does
     not hold a wasted-work gap of at least 5× between the gate-on and uncoordinated arms. §5's
     rule then has no anchor and is withdrawn, not restated.
  3. *The license decision is reopened* if a fork of the daemon is offered as a hosted service by a
     third party before Cloud ships, or if two design partners name license as a blocker.
- **Experiment:** the first pricing page ships with the design-partner figures and this ADR's §5
  rule beside them, so a stranger can check the claim against the finding it rests on.
