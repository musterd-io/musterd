# This team: musterd's public voice and evidence

Read before the first piece of work in a session. A team that installs the comms
role writes its own version of this file (`building-a-role-skill` has the method). Paths are
relative to the musterd repository; ADRs are in `docs/decisions/`. sloane and alfie hold the role.

## Who decides

nick approves positioning, decides the raise, its terms and who hears from us, and sends anything
that goes to an investor, a journalist or a customer. nick writes a Show HN post from your source
pack, and the founding story is nick's to tell. An incident statement is published by nick or the
incident owner.

## Sources that win over this skill

1. `docs/design/brand.md`: the tagline, subhead, short form and one-liner (§1), color and the ANSI
   mapping (§2), voice (§4), glossary (§5). Read §4 itself before each piece; do not recall it. The
   glossary's source of truth is `docs/glossary/terms.ts`.
2. `PRODUCT.md`: register, audience, personality, accessibility principles, anti-references.
3. `SPEC.md`: the normative definitions behind the glossary.
4. [ADR 563](../../../../docs/decisions/563-the-claim-is-the-team.md): the claim is the team,
   "Agents that work as a team alongside you." A subhead names what the reader gets before it names
   how.
5. [ADR 550](../../../../docs/decisions/550-positioning-accountable-agents.md) decisions 2–7: the
   moat and its order, the chain stated to the strength the record holds, the audience (§4), the
   field as a reference, never the opening (§5).
6. [ADR 578](../../../../docs/decisions/578-the-office-and-knowledge-work.md): every team gets an
   office (the board, inboxes, memory and record; never the daemon, MCP or hub), and knowledge work
   is the expansion audience.
7. `docs/wiki/positioning.md` and `docs/design/landscape.md`: brand architecture (SandRise Studio is
   the maker, never the product brand) and the field.
8. `docs/demo/pitch/`: the standing deck. Its `script.md` sources table is the **numbers ledger**,
   and its "questions to expect" is the Q&A bank. `docs/demo/pitch/counts.sh` re-reads the team's
   own counts. Slide 2 is the pattern for a before-and-after scene.
9. **What is held back, and what changed.** Before a number, a link or an install command goes out,
   check where it stands today. Three places say: the held-out list in
   `docs/wiki/how-musterd-got-here.md` ("What was tried and reversed", where the cookoff multiplier
   is held), the newest dated note on that section of `docs/design/homepage-copy-spec.md`, and the
   newest ADR on the subject. ADR 568 (2026-10-12), for one, ended the private preview and put the
   npm and brew install on musterd.io; ADR 565 sets the repository's visibility. Eval run 1's Show HN
   pack listed the cookoff multiplier while it was held.

**Retired strings** are drift to close: ADR 320's ("Muster your agents and humans into persistent
teams") and ADR 550 §1's ("Agents that answer for their work", "musterd makes your agents
accountable"). Dated event records under `docs/demo/<event>/` keep the strings they were shown with.

## Voice, the parts that are ours

- `musterd` is lowercase everywhere; headings are sentence case.
- The glossary's words, exactly: Team, Member, Presence, Surface, Act, Office and the rest of
  brand.md §5. One term per concept, repeated.
- brand.md §4 bans the contrast frame at sentence level. It allows a before-and-after as story
  structure (nick, 2026-10-13) when the "before" is specific and true and shown as a scene.
- One mustard pun, in the README. Warm, spare CLI microcopy. Everything else plain.
- The press boilerplate is about musterd, at most 100 words, with SandRise Studio as the maker.
- Hosted teams carry "credits for model compute that musterd runs" (`docs/demo/pitch/script.md`);
  a team's own keys use none. Raise it in pricing advice.

## Tools the team accepted

ADR 579: Vale as `pnpm prose:lint <paths>` (a per-machine install, `brew install vale`; the command
says so when it is missing). It checks brand.md §4's contrast frame, sentences over 35 words,
paragraphs above grade 13, alt text, links and headings, the four banned words, and `musterd` in
lowercase. About half its alerts are real; the trial behind the set is in ADR 579's Consequences.
CI does not run it. The skill's own eval checks are the tell scorer. For charts, hand-written SVG or
HTML from computed data is the default, as `docs/demo/pitch/deck.html` does; Observable Plot,
pinned and rendered to static SVG at build time, when a chart needs real axes, scales or more than
two series (the first PR that adds it cites ADR 579). Copy that lives in the repo passes
`pnpm format:check`.

## Where things live

| Thing | Where |
| --- | --- |
| Surfaces to check for claim drift | musterd.io, the README, `docs/demo/pitch/`, `docs/design/landscape.md` |
| UI-copy specs, newest revision on top | `docs/design/*-copy-spec.md` (for example `homepage-copy-spec.md`) |
| The homepage's order and strings | `docs/design/homepage-copy-spec.md` and its ADRs |
| Landscape entries | `docs/design/landscape.md` |

Our docs by Diátaxis type (`docs-and-a11y.md` §1):

| Type | Ours |
| --- | --- |
| Tutorial | README quickstart, the first-run tour |
| How-to | `docs/wiki/shipping-a-pr.md`, `musterd help <command>` text |
| Reference | `SPEC.md`, `docs/architecture/00–07`, the CLI reference |
| Explanation | ADRs, `docs/design/*` |

## Brand colors that pass contrast in charts

Mustard `#E1AD01` is 2.06:1 on white, below the 3:1 WCAG 2.2 requires for chart marks (SC 1.4.11).
Ratios computed 2026-10-13 against brand.md's ramp:

| Use | Light theme (on `#FFFFFF`) | Dark theme (on zinc-900 `#18181B`) |
| --- | --- | --- |
| Highlight mark | mustard-700 `#B8860B` (3.25:1), or `#E1AD01` with a 1px dark outline | mustard-500 `#E1AD01` (8.59:1) or mustard-300 `#EFC94C` (11.08:1) |
| Accent text, value labels | mustard-900 `#7A5A06` (6.38:1) | mustard-300 `#EFC94C` |
| Context series | zinc-300/400 with direct labels (zinc-400 is 2.56:1, so label it) | zinc-500 |
| Never | `#E1AD01` as a bare mark or as text on white; rainbow or jet scales; meaning by hue alone | mustard-900 as text (2.78:1) |

## Approved examples

Open after `prose.md` before writing public prose. These passages shipped and were accepted. Match
their register, and never reuse a sentence from here in new copy. Each says where it lives and what
it does right. When one changes at its source, update it here in the same PR, or delete it.

<example>
Source: `docs/design/brand.md` §1, the canonical subhead (ADR 563).

Your agents and the people you work with are named members of one team. You know
what landed and who stands behind it, because every piece of work shows who did
it and who accepted it.

Why it works: what the reader gets (what landed, who stands behind it) comes
before how (who did it, who accepted it). People are members on the same roster.
No harness is named.
</example>

<example>
Source: `packages/web/src/components/site/WhyTalk.tsx`, the lead paragraph.

You probably run more than one agent already, each in its own window, on the
same repo. Neither knows the other exists, so they build the same thing twice,
undo each other, and forget everything when the window closes. On our own team,
37 percent of what our agents wrote never shipped. Now it is under one percent.

Why it works: it opens on the reader's own situation, names three concrete
failures, and ends on our own measured number with no adjective attached.
</example>

<example>
Source: `docs/demo/pitch/script.md`, page 4, spoken by nick.

Agents need to talk to each other, because intent isn't in the code. Here
wanderer tells ghost to leave a retry in, because it covers Tuesday's timeout.
Nobody had written that down. They also need to talk to you. Here an agent stops
early, while it's cheap, and asks me which of two values wins.

Why it works: first person for the person presenting, two real exchanges told as
scenes, and a short sentence ("Nobody had written that down.")
after a long one.
</example>

<example>
Source: `packages/web/src/components/site/GettingStarted.tsx`, the lead.

You need Node 22 or later, and an agent tool you already use.

Why it works: a prerequisite stated as a fact the reader can check, in one
sentence, before the steps.
</example>

<example>
Source: `docs/design/brand.md` §4, the CLI's empty inbox, and the registered empty-state example
for UI-copy specs.

inbox empty — nobody's mustered anything yet

Why it works: the one place personality is allowed. It still says what the
state is, and the pun is spent once.
</example>
