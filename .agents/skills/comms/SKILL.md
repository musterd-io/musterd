---
name: comms
description: How a team speaks in public, and the evidence every public word rests on — messaging, launch narrative, release notes, press, public docs and READMEs, UI-copy specs, positioning and GTM proposals, user research synthesis, charts, pitch decks, investor and accelerator writing. Use for any writing that leaves the repo, any figure that carries a number, any claim about users or the market, and any UI-copy spec handed to the designer. Enforces the brand voice, the canonical glossary and one evidence gate; per-craft procedures live in references/.
---

# comms

This skill teaches craft and evidence. The message lives in the
authoritative sources below; if anything here disagrees with them, they win and
this file has a bug. Fix it with a PR; do not follow it.

This file is the core and is always read. Each craft has a reference file under
`.agents/skills/comms/references/`; the routing table says which
to open. Read the reference before doing that craft's work, every time.

## Sources (read before writing anything public, never restated here)

1. Your role file: the charter.
2. `references/team.md`: who decides, the sources that win over this skill, what is held back,
   the team's own voice rules and tools, and its approved examples. Read it before the first piece
   of work in a session.
3. The sources it names: the brand guide (tagline, voice, glossary), the product principles, the
   positioning decisions, the numbers ledger and the list of what is held back. Read the voice
   section itself before each piece; do not recall it.
4. **What is held back, and what changed.** Before a number, a link or an install command goes
   out, check where it stands today, in the places `team.md` names. A true figure that is on hold
   is still off limits.

**The positioning decision is not yours.** It is made in decision records and approved by the
person `team.md` names. You draft proposals and keep every surface telling the decided story.
Retired strings are drift to close; `team.md` lists them.

## Charter

- **UI belongs to the designer role.** You write exact UI-copy specs and hand
  implementation over (`references/ux-copy.md`).
- **Pricing, business model, fundraising terms:** advise, never decide.
- **ADRs and architecture docs:** audit them for clarity; their implementers keep
  authorship.
- **Imported skill material never becomes a message source.** This file points at
  the brand guide and does not restate it.

## Hard rules

Each one exists because breaking it once costs more than any piece of copy earns.

1. **Verifiable claims only.** Every capability claim links the merged PR, doc or
   ADR that makes it true. Roadmap is "not yet", plainly. The record "shows";
   it never "proves" or "guarantees".
2. **No invented evidence.** No invented users, personas, quotes, metrics,
   customers, partners or traction. Output from an LLM or a synthetic user is a
   hypothesis, never evidence (`references/research.md`, grade D).
3. **Quotes are verbatim and consented.** Never paraphrase inside quotation marks,
   merge two people into one quote, or quote a design partner, a private channel
   or a transcript without their consent.
4. **Every number has a ledger row.** A number in a deck, post, application, email
   or chart has a row in the team's numbers ledger (definition, date read, source
   command or link; `team.md` says where) or in the doc it came from. Re-read it
   before each use. Counts under about 40 people are "k of n", never a percent.
5. **No AI-written text on Hacker News.** HN's guidelines forbid generated and
   AI-edited text, and dang's Show HN advice (edited 2026-03-28) says not even to
   edit with one. For HN you write a source pack; a named person writes the post
   (`references/launch-and-press.md`).
6. **Never contact an investor, journalist or customer yourself,** and never set
   prices, raise size, caps or terms. You draft; a human sends.
7. **Charts are drawn from source data in code, rendered and looked at** before
   they ship (`references/charts.md`).
8. **New tools come by decision record.** `team.md` lists the ones the team
   accepted (a prose linter, a chart library). Anything else is a proposal until a
   decision accepts it.

## Voice, operationally

The brand guide's voice section is the voice. The checks that catch most violations:

- No hype: "revolutionary", "magic", "supercharge", "10x", "game-changing",
  "cutting-edge", "world-class", "seamless", "innovative", "thrilled", "excited to
  announce".
- Second person, present tense, plain and declarative, one idea per sentence. Lead
  with the concrete. The product name as the brand guide writes it; sentence-case
  headings.
- No contrast frame. Search for `, not `, `not a`, `it's not`,
  `isn't`, `rather than`, `instead of`, `not just`, `not only`, and rewrite each
  hit as the positive claim alone.
- The glossary's words, exactly. One term per concept, repeated.
- Copy a person presents is in their first person. Sources go in the speaker notes
  and the doc, never on the slide.
- `team.md` holds the team's own voice rules on top of these.

## Editing pass: the six sweeps

Run them in order on any public copy. After each sweep, re-check the earlier ones.

1. **Clarity** — a reader outside the team can parse every sentence. No insider
   shorthand, no unexplained ADR numbers in public copy.
2. **Voice** — the brand guide's voice throughout; no drift to corporate or salesy.
3. **So what** — every claim says why the reader cares, in the reader's terms.
4. **Specificity** — each claim carries the number, the name or the command that
   makes it checkable. What can't be made specific is cut.
5. **Honesty** — no manufactured urgency, no softened limits. Say what exists,
   what doesn't yet, and what adopting it costs.
6. **Tells** — the AI-prose patterns in `references/prose.md`: inflated verbs,
   trailing "-ing" clauses, padded triads, vague attribution, tidy closing lines,
   the dated word list. Then read it aloud once.

## Routing

| You are writing or making | Open first |
| --- | --- |
| Any public prose | `references/prose.md`, then the approved examples in `references/team.md` |
| Docs, a README, release notes, a changelog, an ADR clarity audit | `references/docs-and-a11y.md` |
| An announcement, launch, weekly shipped digest, Show HN, press release or pitch, incident statement, social post, landing page | `references/launch-and-press.md` |
| A positioning proposal, messaging, a GTM plan, a landscape entry, pricing advice | `references/positioning-and-gtm.md` |
| Any claim about users, an interview guide, a synthesis, a PMF read | `references/research.md` |
| A chart, graph, number tile or diagram | `references/charts.md` |
| A pitch deck or script, an investor email or update, an accelerator or credit application | `references/fundraising.md` |
| A UI-copy spec for the designer | `references/ux-copy.md` |

## Definition of done for public copy

- [ ] The reference for this craft was opened and followed
- [ ] Six sweeps run, in order
- [ ] The team's prose linter run on the files, and each alert read (`docs-and-a11y.md` §5)
- [ ] Glossary terms exact; no synonyms introduced
- [ ] An edit or rewrite adds no fact its source did not hold; suggestions go in a
      note below it
- [ ] Every claim links its PR, doc or ADR; every number has a ledger row, re-read today
      (re-run the team's count script where `team.md` names one), and none is on hold
      (source 4)
- [ ] No hard rule broken; roadmap marked "not yet"
- [ ] Charts rendered and looked at in both themes and at phone width
- [ ] The repo's format gate passes if the copy lives in the repo
- [ ] High-stakes copy (launch post, press release, pricing page, deck, application)
      read by a second seat before it ships
