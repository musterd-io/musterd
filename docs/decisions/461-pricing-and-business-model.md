# 461 — pricing and business model: the team layer free and uncapped on your own computers, org features and musterd Cloud on a musterd account, Cloud free up to an allowance

- Status: accepted (nick, 2026-11-06, the 2026-11-06 revision as written; first proposed 2026-09-28)
- Date: 2026-09-28; revised 2026-11-06
- Lane: `01M08Y95JDB42EPWR6GXHZSZNZ` (goal `launch`; opened by dolly 2026-08-17 as "the one
  unwritten piece of the launch arc")
- Builds on: [ADR 320](320-positioning-the-value-prop-decided.md) (the positioning, not
  re-litigated here), [ADR 122](122-cookoff-value-experiment.md) / [ADR 123](123-cookoff-measurement-protocol.md)
  (the value proof and its measurement), [ADR 039](039-cross-network-topology.md) and
  [`deployment-topology.md`](../design/deployment-topology.md) (Topology C, the hosted relay),
  [`traction-plan.md`](../design/traction-plan.md) §3 (the north star and the first user),
  [`landscape.md`](../design/landscape.md) §5/§12/§13 (Band, Multica, the seed money),
  [`PRIVACY.md`](../../PRIVACY.md) (no phone-home, no usage analytics in the product).
- Revised by: lane `01M6S2X5F9W5VA2XP7ZF6ZWYKD` (goal `unified-sign-in`), from the unified sign-in
  design ([spec](../superpowers/specs/2026-11-06-unified-sign-in-design.md) §10) and three answers
  from nick on 2026-11-06 (questions `01M6S3SCJQ`, `01M6S3SEV9`, `01M6S3W9Y5`).

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
   an obstacle to route around. *(Revised 2026-11-06: musterd Cloud now exists (ADR 475) and the
   unified sign-in design gives a person one musterd account across every surface. A local team
   still needs no account. When a person signs in, the account is a fact the console holds, and
   Cloud's own roster and usage are server facts. The boundary moves to: nothing is counted or
   enforced on a computer you own.)*
4. **The market has priced the cell.** Band raised $17M on a hosted room where cross-framework
   agents converse; Multica has ~47k stars on "Apache 2.0 + hosted-service conditions"; Pilot
   Protocol and xpander raised $4.5M and $7.5M in adjacent cells; three labs sell hosted
   "teammates". Every one stops at the wall musterd is built past (one owner's walls, no teammate
   who can decline), and every one of the funded ones is a **hosted** product.

**The 2026-11-06 revision.** The unified sign-in design made the musterd account the identity a
person carries to every surface, and the home billing attaches to. nick then settled three things
that move this ADR. Some features on your own computers may be paid, and the free line is drawn now.
nick doesn't know of any user besides himself, and the record agrees. The repository had 1 star and
0 forks. `@musterd/cli` had 662 npm downloads from 2026-10-07 to 2026-11-05, most of them likely our
own machines (`api.npmjs.org`, read 2026-11-06). musterd Cloud starts with a free allowance, then
paid. A free local team needs no account even when a teammate or a second computer is on another
network.

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

### 1. The team layer is free and uncapped on your own computers, from this revision on, for good

Everything that runs on a machine you own or an overlay you operate: the daemon, the CLI, the MCP
adapter, `/live` and the other served surfaces, every act, lane, seat, report and trace view, invites
across networks, and federation between your own machines (ADRs 325–360). Any number of humans, any
number of agents. None of it needs a musterd account.

**This line never moves inward.** What is free on the day nick accepts this revision stays free. A
later feature may be paid (§3); nothing on this list becomes paid. The line was drawn now because it
costs nobody anything now (Context, the 2026-11-06 revision).

**No seat cap lives in the repository.** A cap in MIT code is unenforceable, invites the fork, and
puts a wall into the first thing a funder reads. The open-source track is what the raise reads;
it stays whole.

### 2. musterd Cloud: free up to an allowance, then paid, on the musterd account

The hosted product is musterd Cloud ([ADR 475](475-cloud-hosted-teams-postgres.md)): hosted teams
and agents in musterd Cloud, reachable across people and networks with nothing to run. It is the
"just works" path, and it is what the funded comparables say buyers picture.

- **The billing home is the musterd account.** A person on three paid teams is one paying person.
  Billing, the allowance and plan limits attach to the account, never to a member, a seat or a
  machine (sign-in design §3).
- **Free: an allowance.** Every account starts on Cloud free, up to an allowance measured in people
  on the team, agent hours in musterd Cloud, or both. The allowance's unit and size are set with
  design partners (§5), recorded here as a dated Consequences note, and never invented in advance.
- **Paid: past the allowance.** Past it, the account pays.
- **Agents are not taxed for existing.** An agent you run on your own computer and connect to a Cloud
  team counts for nothing. An agent musterd Cloud runs uses compute, and that compute is what the
  allowance and its credits pay for; a team's own model keys use none
  (`docs/demo/pitch/script.md`).
- **Enforceable where it is charged.** Cloud knows its roster and the agent hours it runs; the
  allowance is a server fact, never a number in a binary.

### 3. Org features: paid, on your own computers or in Cloud, unlocked by the musterd account

For a team that needs what a governance buyer asks for (`landscape.md` §13a: Gartner's "only 13% of
organizations believe their agent governance is adequate"): SSO, signed and exportable audit,
retention and content-trace policy packs (ADR 445 §3's `trace.content` and the 30-day lifecycle
become policy an org can set and prove), multi-team administration, and support.

Same binaries. A signed-in musterd account with an org plan unlocks them, on a team you host or on
Cloud. The first time a person reaches for one, musterd asks them to sign in, once (sign-in design
§2). The plan gates *org* capabilities, never the team layer, and never the seat count: §1 holds
with or without it. This is the second revenue line, and the one that survives if hosted turns out
not to be the buyer's shape (§Falsifiers).

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

So the price rule, not a price: **a paid Cloud person is priced well under one hour a month of the
agent compute it saves that team.** A small team already paying for two or three agent harnesses
spends more per week on duplicated and discarded work than a person costs per month, if the pilot's
gap holds even at a fifth of its size. Concrete figures, and the allowance in §2, are set with
design partners (`traction-plan.md` §6), recorded here as a dated Consequences note when they exist,
and never invented in advance. An invented number in a pricing page is the one lie a stranger can
check.

### 6. What this does not decide

Billing mechanics (Cloud increment 7, lane `01M3TTZJGX`), a pricing page, the allowance's unit and
size, the org plan's exact feature list at launch, and the launch post. The lane's brief says pricing
does not gate the post, and it does not.

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
- **Cloud free for two humans, paid from the third** (this ADR's own 2026-09-28 Decision §2).
  Replaced on 2026-11-06 by nick's choice of a free allowance: the allowance can count agent hours
  in musterd Cloud, which is the compute Cloud actually spends, and a people count alone never could.
- **A license key for org features** (the 2026-09-28 Decision §3). Replaced by the musterd account:
  one identity already carries the person to every surface, and a second secret to paste is what the
  unified sign-in design removes.
- **A musterd account for a free team that reaches across networks** (sign-in design open question
  1). nick, 2026-11-06: no. A person can see "you're using Cloud" coming, and can't predict "another
  network" until a join fails.
- **Services / design partners as the model.** Paid pilots are how the price gets set (§5), not what
  is sold; the traction plan carries them as a fallback outcome, and this ADR does not make them
  the product.

## Consequences

- `PRODUCT.md` gains one line pointing here under a new "Business model" heading; `ROADMAP.md`'s
  hosted-relay item is the build that makes §2 real and is not re-described here.
- The open-source repo does not change: no cap, no key check, no telemetry. *(Revised 2026-11-06:
  the org features are unlocked by a signed-in musterd account, and the license key is gone (§3).
  Account gating is a build for a later ADR, scoped to org capabilities only.)*
- Named risk, accepted: a competitor forks the MIT daemon and hosts it. The counter is execution
  (§4); the trigger to revisit the license is in §Falsifiers, and it is a separate ADR if pulled.
- Named risk, accepted (revised 2026-11-06): the Cloud allowance is generous enough that a small
  team never leaves it. Its unit and size stay open until design partners set them (§2, §5), and
  falsifier 1 measures whether an account that uses it up converts. *(Historical: the 2026-09-28 form
  of this risk named the two-human free tier and the third human converting. The revision replaced
  that rule; it no longer applies.)*
- **`PRIVACY.md` changes before two things ship, each in its own PR.** The first is linking a local
  team to a musterd account (sign-in lane `01M6S2WB7D`): a linked team checks in with musterd.io for
  sign-in keys. The second is Cloud's allowance meter, which counts people and agent hours on Cloud. The
  sentence "Self-hosted musterd does not phone home" stays true for a team nobody signed in to.
- Revised 2026-11-06 (lane `01M6S2X5F9`): §1 drawn as the line that never moves inward; §2 an
  allowance on the account; §3 the account in place of a license key. The copy for the free /
  account / paid lines is [`sign-in-copy-spec.md`](../design/sign-in-copy-spec.md) §11, held until
  nick accepts.
- Dated notes go here as design-partner figures, conversions and the cookoff refresh land.

## Observability & Evaluation

- **Traces:** none in the product — `PRIVACY.md` holds. Cloud's own roster and its agent hours
  (people per team, accounts past the allowance) are the record, aggregated, on the hosted side only.
- **Eval / falsifiers, each with a date:**
  1. *The line is wrong* if, in the 60 days after Cloud billing ships, no account that uses up the
     allowance converts, or if every serious design-partner conversation wants the org features
     before Cloud. Then the org features lead and Cloud follows.
  2. *The price story collapses* if the cookoff refresh (`01M1VDRC6B`) on a September build does
     not hold a wasted-work gap of at least 5× between the gate-on and uncoordinated arms. §5's
     rule then has no anchor and is withdrawn, not restated.
  3. *The license decision is reopened* if a fork of the daemon is offered as a hosted service by a
     third party before Cloud ships, or if two design partners name license as a blocker.
- **Experiment:** the first pricing page ships with the design-partner figures and this ADR's §5
  rule beside them, so a stranger can check the claim against the finding it rests on.
