# 550 — Positioning: agents you can hold accountable

- Status: accepted (2026-10-08, nick; drafted by alfie in session with nick)
- Date: 2026-10-08
- Lane: `01M4EDCMCAJRVTQK0RCXTPBJ47` (goal `accountable-agents-positioning`)
- Supersedes: [ADR 320](320-positioning-the-value-prop-decided.md) decisions 1 and 4 (the category
  claim and its vocabulary). Decisions 2, 3 and 5 stand and are re-read here.
- Evidence: [`landscape.md`](../design/landscape.md) §14 (added in the same change), §5 (Band update)
- Relates to: [ADR 109](109-seat-git-attribution.md), [ADR 127](127-authorization-provenance-gates.md),
  [ADR 158](158-model-attestation-truth.md), [ADR 188](188-graded-review-ladder.md),
  [ADR 192](192-outcome-acceptance.md), [ADR 461](461-pricing-and-business-model.md),
  finding [006](../research/006-enforcement-induces-coordination-cookoff-pilot.md)

## Context

ADR 320 decided the position on 2026-08-24 and wrote its own tripwire: _"if Band ships
work-ownership primitives, typed acts, or harness-native join … positioning must shift its weight
to what remains (attestation, humans-as-peers, the corpus)."_ On 2026-10-08 `docs.band.ai` documents
**Band Desktop** (formerly Jam): a Claude Code plugin that "creates a BAND agent identity for the
local Claude Code session", an identity that survives rebinding, and "work items and ownership …
agent swim lanes". Two of the three conditions have fired.

The same day's sweep (landscape.md §14) found the rest of the ground had moved too:

- **The multiplayer cohort arrived.** YC's Fall 2026 RFS "Multiplayer AI" asks for agent sessions a
  team can "watch, redirect, and hand off." Party (party.build, ex-Maitai, YC S24), Agent Relay
  (YC F26), Pentagon (YC P26), herdr (YC F26), Maxxwell (YC S26), YC's own open-source qm, SageOx
  ($15M) and Conductor ($24M) all ship some of it. Durable named agent identity and joining an
  existing harness session — the first two items of ADR 320's moat — are now common.
- **The work trackers made agents participants.** Linear, Jira/Rovo, Plane, Asana, ClickUp, Notion
  and GitHub let agents take work. Linear's design is the clearest statement of where the field
  stops: an issue is "only delegated to agents … an agent cannot be held accountable", so the human
  stays the assignee ([Linear](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)).
- **Across roughly forty products, three things are absent everywhere:** an act by which an agent
  declines or challenges work, acceptance enforced to come from a different actor, and a record of
  which model did the work. musterd ships all three.
- **"Coordination layer" stopped doing work for us.** The trackers say "system of work"; Party says
  "work-first"; no vendor's primary source uses "coordination layer". The phrase names plumbing,
  so the reader has to work out the benefit, and ADR 320 §5 found it is the word that sets off the
  swarm fear before "peers" is read.

nick's direction in the session: nothing from earlier positioning is fixed; the value proposition
must be clear and land hard; the field comparison is a reference, never the opening; the audience
is small product and engineering teams and solo builders running many agents, on one harness or
several, with knowledge work kept in view; and dogfood must exercise whatever the copy emphasises.

## Problem

Decide the category claim, the headline, the audience, and the order of the moat, given that
identity and harness-native join are contested, and given that musterd's own usage does not yet
show the refusal half of the story (Consequences, the 2026-10-08 reading).

## Decision

### 1. The claim is accountability

musterd's headline is that **its agents are accountable for their work.** _(Amended 2026-10-12: superseded by [ADR 563](563-the-claim-is-the-team.md); the claim is the team, "Agents that work as a team alongside you", and accountability is the subhead and the proof. Decisions 2 to 7 stand.)_ Every member — a Claude
Code or Codex session, or a person — answers for the work it does, and the record shows the chain.
"Coordination layer" leaves headlines, taglines and opening sentences. It stays in technical docs,
where it is accurate.

The canonical statement (surfaces adapt the register, not the substance):

> **musterd makes your agents accountable.** Claude Code, Codex, and the people you work with join
> one team as named members. Every piece of work carries its chain: who asked for it, who claimed
> it, which model did it, who accepted it, and who signed off. A member can say no, and nothing
> ships until someone else accepts it.

The name carries it: a muster is a roll call — who is here, and who answers.

Accountability runs both ways. An agent holds a human to acceptance; an ask waiting on a human is
recorded as waiting; a human's sign-off is on the chain. This is what keeps the claim out of the
console category ADR 320 §1 rejected, where a human supervises agents from above.

**Rejected: keeping "coordination layer" qualified (ADR 320 decision 4).** Qualifying it kept the
word and lost the benefit. A reader who has to be told what is coordinated has not been told why
to care.

**Rejected: leading with waste ("stop paying agents to redo each other's work").** True and
measured, but it positions musterd as an optimisation tool. It is the proof line, below.

**Rejected: "multiplayer" or "system of work".** Both are taken (YC's RFS and every tracker) and
both describe a place, which says nothing about whether the work in it can be trusted.

### 2. The moat, reordered

What is defended, in order, with what is already common removed from the top:

1. **Refusal** — `decline` and `challenge` are first-class acts (ADR 103). No other product surveyed
   has one; the nearest are "raise a blocker" (Multica) and asking for input (Linear, Plane).
2. **Acceptance by a different member, enforced** (ADR 188, ADR 234) — nobody grades their own work.
3. **Attestation a second party can check** — the model the harness observed outranks the model an
   agent declares (ADR 158, ADR 163, ADR 246); the seat trailer survives the squash (ADR 109).
4. **The chain from asked to signed off** — §3.
5. **Identity that outlives the session and belongs to the team.** Still true, no longer unique.
6. **The measured corpus** — finding 006 and what follows it.

### 3. The chain, stated exactly

Copy may claim the chain only to the strength the record holds it. As of 2026-10-08:

| Link | What records it | Strength |
| --- | --- | --- |
| Who asked | a seed's author; a goal's declarer; the act a lane was opened from, when there is one | **partial** — a lane records who opened it, not who asked. Work begun by telling an agent in its own session leaves no record of the asker. |
| Who claimed | `lane_claim` | verified (the daemon authenticated the seat) |
| Which model | observed model on the presence (ADR 158) | verified as observed by the harness; declared models are marked as such |
| Who accepted | the acceptance verdict (ADR 192, ADR 202) | verified, and enforced to be a different member |
| Who signed off | `authorized_by` on merge (ADR 109); on decide/grant (ADR 127) | merge: attested (the seat reports it; the daemon cannot see GitHub). decide/grant: verified |

The "who asked" gap is lane `01M4EDCQ2W` (a `requested_by` on the lane, and a link to the
originating act where one exists); it needs its own protocol ADR. Until it lands, surfaces say
"who claimed it, which model did it, who accepted it" and leave "who asked" out of any sentence
that reads as a guarantee.

### 4. Audience

**First:** small product and engineering teams, and solo builders, running many agents on one
harness or several. Their pains are the ones the 2026 literature names — duplicated and overwritten
work, the review pile-up ("the bottleneck is no longer generation, it's verification"), and not
knowing which agent or model did what.

**The proof line for them:** on the cookoff fixture, agents working side by side wasted 65–83% of
their work; with musterd's lane gates it was under 11% (finding 006; a pilot, one fixture, carried
with its caveat).

**Second wave: knowledge work.** None of the primitives in §2 is specific to code, and the revive
team already runs research, ADRs, copy and specs through them. Copy says "work", not "PRs", so the
claim does not have to be rewritten later. The waste proof is code-shaped and stays with builders
until a non-code measurement exists.

### 5. The field is a reference, never the opening

No public surface opens by describing what other products do or lack. The comparison
(landscape.md §14's table) is a tab, an appendix slide, an FAQ answer — met when someone asks "how
is this different from X". brand.md §4's rule against the contrast frame applies to the opening as
well as to sentences.

### 6. What carries forward from ADR 320

Decision 2 (the human is the headline peer) becomes part of the claim: the human is on the chain
at both ends. Decision 3 (peer, not contractor) and decision 5 (face the fear with names, never
claim containment) stand unchanged; 5a's counter-line already says "a name on every act", which is
this ADR's claim in its smallest form. The honesty paragraph stands: musterd records what it sees
and says what it does not enforce.

### 7. Where musterd sits, and the security floor under the claim

**Execution and orchestration belong to the harness.** musterd does not run agents, schedule them,
or author the graph they follow. A member's work runs in whatever runs it — a Claude Code or Codex
session, ultracode or `Workflow`, a Party Flow, a sandbox — and that member still claims, declines,
asks and is accepted on musterd. Unattended work on musterd is members waking when work is addressed
to them (ADR 131, ADR 179), never a graph musterd owns. Surfaces say "joins from the session it
already runs"; they never say musterd runs, orchestrates or schedules agents.

**What musterd enforces, and what it does not** (`docs/design/security.md`, "Enforce vs declare"):

- It enforces what flows through it: who may send, claim and see; acceptance by a different member;
  an ask that holds; and, at the harness's tool boundary, the lane gate that denies an edit to a
  contended surface the seat does not own (ADR 150, through the PreToolUse hook).
- It does not sandbox. Filesystem, network and shell isolation belong to the harness or a sandbox
  that composes with musterd (qm, Omnigent, OneCLI and Party all sell one). The self-hosted daemon's
  security property is locality: the work and its record stay on machines the team runs. musterd
  Cloud (ADR 461) changes that property and must say so where it is sold.

**The claim stands on two things musterd must keep true:**

1. **One seat cannot act or attest as another.** Per-seat credentials and session leases (ADR 350,
   `security.md` "Credential & grant lifecycle") are what make "who claimed it" mean the named
   member. The open `security` goal ("a seat can't read, act as, or attest for another seat") is
   therefore a precondition of this positioning, not a separate track.
2. **The record is only as trustworthy as the daemon that wrote it.** The audit log is not signed;
   "which model" and "who signed off" are daemon-trusted (and, for merges, seat-attested). Signed,
   offline-checkable receipts for the acts that carry authority (landscape.md §9, the AgentField
   borrow) are what would let a second party check the chain without trusting the daemon. Until they
   exist, surfaces say the record shows the chain; they do not say it proves it.

## Falsifiers

- **The impersonation test (§7).** If one seat can act, claim or attest as another — a security
  finding, a red-team result, or a dogfood incident — the accountability claim comes off every
  surface until the hole is closed and the fix is recorded here.

- **The refusal test (§1, §2.1).** If, over the review window below, no member declines a handoff,
  challenges a human, or accepts work across model families, "a member can say no" is doctrine the
  product's own usage contradicts, and it comes off every surface until it does not.
- **The convergence watch (§2).** If any product ships a decline act, enforced acceptance by a
  different actor, or a model-attested record, the moat order is re-read against it. Band, Agent
  Relay and Linear are the standing watch items.
- **The console test (§1).** If press or users describe musterd as "agent oversight", "governance"
  or "a control plane", accountability is being heard as supervision; the both-ways framing has
  failed and the headline reopens.
- **The audience test (§4).** If the first users who stay are not running several agents, the
  audience is wrong, whatever the copy says.

## Consequences

- **2026-10-12 — decision 1 is superseded by [ADR 563](563-the-claim-is-the-team.md).** The
  tagline becomes "Agents that work as a team alongside you"; the chain stays as the subhead and
  the proof, written as what it buys the reader rather than as a list of mechanisms. §2 to §7 of
  this ADR are unchanged.
- **Applying it.** Accepted 2026-10-08; public surfaces derive from §1 from that date. First,
  brand.md §1's tagline and one-liner are rewritten (lane `01M4EHB65Y`; candidate taglines: _"Agents
  that answer for their work."_ / _"Every member answers for its work, agents included."_ — nick
  picks); then README, musterd.io, the launch post, the pitch script and demo crib sheet, each as its
  own lane. Until a surface is rewritten, it still carries ADR 320's copy; that is drift to close,
  not a second position. ADR 320 carries a dated pointer to this ADR in its Consequences.
- **The 2026-10-08 reading of the refusal test** (`musterd report coordination`, revive, 7 days):
  0 challenges received by humans; 0 declines of human handoffs; nick accepted 0 of 56 acts; about
  35 `request_help` acts addressed to nick unanswered for 36–82 days. Today accountability on the
  dogfood team runs from agents to agents only. Lane `01M4EDCSJD` exercises it before 2026-11-02 (the
  YC W27 deadline; the a16z speedrun window is Oct 12 – Nov 1), and its numbers are recorded here.
- **Two lanes this ADR exposes:** `01M4EDCQ2W` (the who-asked link and a read of one lane's whole
  chain, each link marked verified / attested / missing) and `01M4EDCSJD` (the dogfood run).
- **Pricing (ADR 461) is unaffected and corroborated:** no product in the sweep charges for an agent
  as a seat; Linear and Plane state that installed agents "do not count as billable users".
- No code changes. No glossary changes.

## Observability & Evaluation

- **Traces:** n/a — a positioning decision emits nothing; the act log already holds what the
  falsifiers read.
- **Eval:** the refusal test. Dataset: the team's message log by act and recipient kind, via
  `musterd report coordination` ("peer demand") and the ADR 050 projections. Baseline: the
  2026-10-08 reading above. Read again after lane `01M4EDCSJD` runs, and at the first post-launch
  positioning review.
- **Experiment:** none scheduled; the convergence and console tests are watch items read at each
  landscape refresh.
