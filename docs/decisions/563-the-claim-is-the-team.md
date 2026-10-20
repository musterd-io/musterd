# 563 — The claim is the team: "Agents that work as a team alongside you"

- Status: accepted (2026-10-12, nick; drafted by alfie in session with nick, who gave the line)
- Date: 2026-10-12
- Lane: `01M4RK12F7M6023B0C7W7KAJDX` (goal `home-page-cut`)
- Supersedes: [ADR 550](550-positioning-accountable-agents.md) decision 1, the claim and the
  canonical statement. ADR 550 decisions 2 to 7 stand.

## Context

ADR 550 (accepted 2026-10-08) made accountability the claim: the tagline became _"Agents that
answer for their work."_, the subhead _"On musterd, every member answers for its work: the agents
and the people they work with."_, and the canonical statement listed the chain (who asked, who
claimed, which model, who accepted, who signed off) and the refusal (a member can say no). Those
strings went onto musterd.io, the three READMEs, PRODUCT.md, the tour's first step and the CLI
banner over the following days.

The 2026-10-12 home page audit ([homepage-audit-2026-10-12](../design/homepage-audit-2026-10-12.md))
measured what that produced: the page says "a different member accepts" five times and "which
model did it" four times, and a reader is told what the record holds before being told why they
would want it. On the same day, reading the page, nick named the problem in the tagline itself:
"answer for their work" describes a duty the agent owes. What the reader buys is a team of agents
that works alongside them, and that was only ever in the subhead. He also named two sentences that
carry no value as copy: "which model did it" and "any member can say no" are mechanisms, and the
subhead that uses them has to say what they buy the reader instead.

## Problem

"Accountable" is the proof's language used as the claim. On a first read it sorts musterd into
oversight and compliance, the console category ADR 320 §1 rejected, and ADR 550 had to spend its
subhead keeping the human on the team so the reader would not take it that way. The thing the
product does that a reader wants, agents that are members of one team with them, is a sentence
nobody leads with.

The chain is still the moat (ADR 550 §2) and still what the record shows (ADR 550 §3). It has not
become less true. It has the wrong job: it is why a reader can trust the team, not why they want
one.

## Decision

1. **The tagline is _"Agents that work as a team alongside you."_** It is canonical on every
   surface that carries a tagline. "Alongside you" claims that the person is a member on the same
   roster, which the record holds (ADR 550 §4); it does not claim that the person supervises the
   agents, and no surface may read it that way.
2. **The claim is the team. Accountability is the subhead and the proof.** The sentence under the
   tagline carries the chain, and it carries it as an outcome for the reader, not as a list of
   mechanisms. The rule for every subhead, one-liner and section heading that states the chain: it
   names what the reader gets (what landed, who stands behind it, that nothing counts as done on an
   agent's own word) before it names how (claimed, model, accepted, declined). "Which model did
   it" and "any member can say no" appear in a headline string only when the same sentence says
   what that buys the reader.
3. **The strings below the tagline are the copy owner's.** sloane writes the subhead, the short
   form, the one-liner and every surface's register in lane `01M4RCBNZ3P5SGG1ERDEC05H0B`, which
   widens from the home page to every surface in the table. The candidate strings in Consequences
   are a starting point, not the decision.
4. **Every surface carrying the old tagline changes in that one lane**, and the tests that pin the
   strings move with them.

   | Surface                                      | Where                                                                 |
   | -------------------------------------------- | --------------------------------------------------------------------- |
   | musterd.io meta and hero                     | `packages/web/src/brand/siteMeta.ts`, `packages/web/src/content/site.ts`, `LightHero` |
   | "Members who answer for their work" heading  | `packages/web/src/components/site/WhatIs.tsx` (the audit's §5 removes the section; its heading goes with it) |
   | Root README, CLI README, npm-reserve README  | `README.md`, `packages/cli/README.md`, `npm-reserve/musterd-cli/README.md` |
   | PRODUCT.md                                   | the opening paragraph                                                 |
   | Tour step 1                                  | `content/tour.data.ts` ("musterd makes your agents accountable."), which the CLI and the web both render |
   | CLI banner short form                        | `packages/cli/src/render/rows.ts` `renderBanner`                       |
   | Tests                                        | `packages/web/scripts/site-files.test.ts`, `packages/web/src/routes/landing.test.ts` |

   The demo-day deck and script under `docs/demo/` are a dated record and keep ADR 550's strings.
5. **Claim discipline is unchanged.** brand.md §1's rule stands: copy says "the record shows",
   never "proves" or "guarantees", and "who asked" stays out of any sentence that reads as a
   guarantee (ADR 550 §3).
6. **ADR 550 decisions 2 to 7 stand**: the moat and its order, the chain stated exactly, the
   audience, the field as a reference and never the opening, what carries forward from ADR 320,
   and the security floor under the claim.

## Consequences

- brand.md §1 is rewritten in this change: the tagline, and a dated note on the subhead, short
  form and one-liner saying they are being rewritten under decision 2 in sloane's lane. Until that
  lane lands, a surface carrying ADR 550's strings is drift to close, not a second position, as
  brand.md already says.
- Candidate strings for sloane, written to decision 2's rule:
  - subhead: _"Claude Code, Codex and the people you work with are named members of one team. Every
    piece of work shows who did it and who accepted it, so you know what landed and who stands
    behind it."_
  - short form (banner, bio, package description): _"Your agents, on a team with you."_
- The home page audit's §5 said the hero keeps its H1. It does not; the H1 is the tagline and
  changes with it. The record card under it is unchanged and is where the chain is shown.
- ADR 550 carries a dated marker on decision 1 and a note in its Consequences pointing here.
- No code changes in this lane. No glossary changes.
- **2026-10-19, the subhead and one-liner drop "your" and "you"** (lane
  `01M5AWZ95YKDHBM4BJ14CDXAG2`, under ADR 665 §4 row 4). nick cut the GitHub repository
  description to _"Agents that work as a team alongside you: named members across any harness, and
  every piece of work shows who did it and who accepted it."_ because the subhead leaned on the
  reader twice after the tagline already had; brand.md §1, the hero, `SITE_ONE_LINER` and llms.txt
  took the same pass the same day. Decision 2's rule is unchanged and the new strings keep to it:
  what the reader gets (what landed, who stands behind it) still comes before how.

## Observability & Evaluation

**Traces.** n/a — positioning copy; nothing is emitted or logged.

**Eval.** Dataset: the surfaces in decision 4. Baseline on 2026-10-12: nine files outside
`docs/decisions`, `docs/demo` and the audit carry "answer for their work" or "makes your agents
accountable". After sloane's lane: zero, and every tagline occurrence reads "Agents that work as a
team alongside you." Pinned by the two tests in decision 4 once they move.

**Experiment.** n/a — one tagline at a time, as with ADR 550.

## Falsifier

After lane `01M4RCBNZ3P5SGG1ERDEC05H0B` lands, find a tagline on any surface in decision 4 that
still reads "Agents that answer for their work", or a subhead under the new tagline that names a
mechanism (model, decline, acceptance) in a sentence that says nothing the reader gets from it.
Either falsifies this ADR's application; a reader who takes "alongside you" to mean the person
supervises the agents falsifies decision 1's reading and is a copy defect to fix.
