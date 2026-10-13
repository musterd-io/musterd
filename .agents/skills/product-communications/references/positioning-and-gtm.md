# Positioning and GTM: proposals for a decision someone else makes

Open for a positioning proposal, messaging, a GTM or launch plan, a landscape or
battlecard entry, or pricing advice.

Every artifact here is an input to an ADR or to nick. Label it **Proposal**, link
the ADR it would amend, and never ship its strings to a surface until that ADR is
accepted.

## Positioning proposal: Dunford's five, in order

April Dunford's components, worked in this order because each depends on the one
before ([Dunford quickstart](https://www.aprildunford.com/post/a-quickstart-guide-to-positioning)):

1. **Competitive alternatives** — what the best-fit customer would do without us,
   including doing nothing (one agent at a time, a shared doc, a Slack channel).
2. **Differentiated capabilities** — what we have that those alternatives lack.
   Each one links its PR or ADR.
3. **Value** — what each capability lets the customer do, in their terms.
4. **Best-fit customers** — who cares most about that value (ADR 550 §4 and ADR
   578 set ours today).
5. **Market category** — the frame that makes the value obvious. Proposing a new
   category is its own ADR.

Check the result against Geoffrey Moore's positioning statement: For (customer) who (need),
musterd is a (category) that (benefit). That is a consistency check on a finished
proposal. It is not a way to write one.

## Messaging hierarchy

One page: the claim (the tagline, from brand.md), three supporting messages, and
under each the proof (a PR, a number with a ledger row, a capture). A supporting
message without proof is cut or marked "not yet".

## Message test

Score candidate strings with real readers, in this order: clarity (can they say
back what it is), relevance (does it describe their problem), differentiation
(could a competitor say it) ([Peep Laja on Wynter](https://saas.group/podcasts/saas-unbound-interview-peep-laja-wynter/)).
Report the readers as k of n with their words (`references/research.md`). A test
run on LLM "readers" is grade D and decides nothing.

## One-page GTM plan

Richard Rumelt's kernel, from summaries: a **diagnosis** of the situation, a
**guiding policy** for dealing with it, and **coherent actions** that carry the
policy out. Pair it with Amazon's PR/FAQ: a press release dated on launch day and
an internal FAQ that includes the top three reasons it could fail
([Working Backwards PR/FAQ](https://www.workingbackwards.com/resources/working-backwards-pr-faq)).
The PR/FAQ's customer quote is imagined; it stays in the internal doc and never
reaches a public surface (hard rule 2).

## Design-partner brief

For recruiting and running design partners: who qualifies, what they get, what we
ask for (a fixed meeting rhythm, access to the work, consent to quote), and a hard
date to decide whether they convert. Bessemer's 2026 guidance: 5–12 partners,
recruited cold as well as warm, with conversion as the signal
([BVP](https://www.bvp.com/atlas/design-partners-the-pre-launch-edge-most-ai-founders-ignore)). Record every commitment in writing; a
conversation is not a partner (hard rule 2).

## Landscape and battlecards: stay fresh

Every entry in `docs/design/landscape.md` or a battlecard carries `as_of`,
`source_url` and `review_by` (60–90 days out). Keep stable facts (what a product
is) apart from volatile ones (pricing, features, funding). An entry past its
`review_by` date is not quoted until it is re-read. We describe what other
products do from their own docs; "I have not tested anyone else's version" stays
true until we have (ADR 550 §5: the field is a reference, never the opening).

## Claims, the PostHog rule

PostHog's handbook: marketing claims "must be genuine and verifiable", promising
nothing beyond what is in GitHub ([PostHog handbook](https://posthog.com/handbook/growth/marketing)).
Ours is hard rule 1: each capability claim links a merged PR, doc or ADR.

## Pricing advice (advisory only)

A checklist to raise with nick, never to decide:

- The value metric: what the customer pays more for as they get more value.
- The free self-hosted boundary, stated so it never shrinks for existing users.
- Predictability for the buyer: can they forecast next month's bill?
- The expansion path from one team to an organization.
- Model-compute credits: hosted teams carry "credits for model compute that
  musterd runs" (`docs/demo/pitch/script.md`); your own keys use none.

Dated context: in Growth Unhinged's 2026 survey of 230+ companies, 37% use hybrid
pricing and companies under $5M ARR lean toward flat fees
([Growth Unhinged](https://www.growthunhinged.com/p/the-state-of-b2b-monetization-in-2026)).
Re-read it before quoting; benchmarks age fast.
