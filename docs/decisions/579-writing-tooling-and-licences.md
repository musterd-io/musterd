# 579 — Writing tooling for the comms seat, and the licences we accept for vendored material

- Status: accepted (2026-10-13, sloane, under nick's go-ahead for the comms-skill-v2 lanes: "do
  all of this"). Decision 4's licence table was confirmed by nick the same day (see Consequences).
- Date: 2026-10-13
- Lane: `01M4V98KAW40FNJAR2J6SSCRF5` (goal `comms-skill-v2`, increment 4)
- Amends: [ADR 299](299-committed-skill-home-and-vendoring.md) §3 (vendoring policy), by widening
  the licences it accepts. Adapt, pin, credit and keep the license text all still hold.
- Relates to: AGENTS.md hard rule 6 (no new runtime dependency without an ADR), the
  product-communications skill's hard rule 8 ("New tools come by ADR")

## Context

The product-communications skill was rebuilt in two increments on 2026-10-13 (PRs #2481 and
#2497). Its rules now cover prose tells, docs structure, plain language, accessibility and charts.
Three kinds of tool would check those rules mechanically, and the skill names each as "not yet":

- **A prose linter.** Vale (MIT, v3.24.0 released 2026-10-01) runs style packages over Markdown.
  Its package library now holds packs for the Google developer style guide, readability scores,
  AI-prose tells, accessibility and Diátaxis.
- **A prose tell scorer** that gives a number an eval can compare, run against the skill's output.
- **A chart library** for figures with axes. Today every chart is SVG or HTML written by hand from
  computed data (`docs/demo/pitch/deck.html`).

The vendoring policy in ADR 299 §3 was written around four MIT upstreams. The upstream survey for
this goal found useful material under BSD-3-Clause (proselint and its Vale pack, Vega-Lite) and ISC
(Observable Plot). ADR 299 accepts neither by name.

Two facts frame the licence question:

- Our code dependency tree already carries these licences. Counted on 2026-10-13 from the
  `package.json` files under `node_modules/.pnpm` (3,580 files, dev and duplicate copies included):
  3,033 MIT, 270 Apache-2.0, 122 ISC, 59 BSD-3-Clause, 27 BSD-2-Clause, 12 0BSD. Code dependencies
  are decided one by one under AGENTS.md hard rule 6, and this ADR leaves that rule alone.
- The open question is vendored material, meaning upstream text adapted into `.agents/skills/**`,
  and style packs pulled into the repo's lint config.

## Problem

Without a decision, the skill keeps saying "not yet" to every tool. Each future PR that wants one
reopens the same three questions (which linter, which scorer, which chart library) plus the
licence question. A seat could also pull a share-alike or non-commercial source into a skill
because nothing names those as off limits.

## Decision

### 1. Vale is the prose linter, local first and pinned

- Vale **3.24.0**, with packages pinned by release URL, never by bare name (a bare name floats to
  the newest release):
  - Google **v0.7.1**, Readability **v0.2.0**, tbhb/vale-ai-tells **v1.37.0**, at their own alert
    levels.
  - jdkato/a11y **v0.1.0** and jdkato/diataxis **v0.1.0**, at `suggestion` only. They were created
    on 2026-09-24 and have no record yet.
  _(Amended 2026-10-13: the trial turned most of these packs off; only jdkato/a11y's structural
  rules and a musterd style remain. See Consequences, 2026-10-13.)_
- The vocabulary is generated from `docs/glossary/terms.ts`. Canonical terms go in `accept.txt` and
  the Not column goes in `reject.txt`. That covers the whole Not column, which `pnpm vocab:check`
  does not. `vocab:check` stays the gate for the four banned words.
  _(Amended 2026-10-13: `reject.txt` carries the banned terms only; the Not column was 1 of 50
  right as a word list. See Consequences, 2026-10-13.)_
- It runs locally through `pnpm prose:lint <paths>`. A machine without Vale gets an install hint and
  exit 0, so a missing binary never blocks a commit.
- Whether CI runs it (advisory, gating, or not at all) is decided from a measured trial: alerts per
  1,000 words on `docs/wiki`, `docs/design` and the README, and a hand-graded false-positive rate on
  50 alerts per pack. The result is recorded as a dated note in this ADR's Consequences.
  Follows-up: 01M4VEYYMPX4XVMZ5T11CEJ0W3
- Vale is a standalone Go binary installed per machine (`brew install vale`). It is a tool and
  never a runtime dependency of any package.

### 2. The prose tell scorer is the skill's own eval checks

The comms evals (lane `01M4V98H46`) score output with a small script in the skill's `evals/`
directory, with no dependencies. It checks what is specific to us: the glossary's Not column,
contrast frames (brand.md §4), the dated word list, and fact preservation against the source.
When Vale is installed, the eval also records its alert counts.

eric-tramel/slop-guard (MIT, v0.5.0) was considered and is not adopted. It is a Python tool, so it
would bring a second toolchain, and its 0–100 score measures generic tells. Our checks are specific
to the glossary and brand.md.
hardikpandya/stop-slop's five-dimension rubric (MIT) may serve as a model-graded rubric inside the
evals; that rubric is skill text and needs no tool.

### 3. Charts stay hand-written SVG; Observable Plot is the library when one is needed

The default stays SVG or HTML generated in code from source data, as `references/charts.md`
requires. When a chart needs real axes, scales or more than two series, the library is
**Observable Plot** (ISC), pinned to an exact version and rendered to static SVG at build time, so
nothing loads from a CDN at view time. The first PR that adds it cites this decision as its
dependency ADR (AGENTS.md hard rule 6). Colour contrast is computed with the WCAG formula in a few
lines of our own code, so no colour library is added.

Vega-Lite (BSD-3-Clause, v6.5.0) was the alternative. Its JSON specs are attractive for
model-written charts, but it is a larger runtime, and Plot's API matches the hand-written D3 style
we already use.

### 4. The licences accepted for vendored material (amends ADR 299 §3)

| Class | Licences | Use |
| --- | --- | --- |
| Accepted | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, CC-BY-4.0 | Adapt, pin by SHA in `PROVENANCE.md`, keep the license text in `LICENSES/` |
| Reference only | CC BY-SA (any version), GPL, AGPL, LGPL, MPL, any non-commercial licence (CC BY-NC, BY-NC-SA), no licence, custom terms | Read and cite with a link. Never adapt text from it. |

What each accepted licence adds beyond keeping its text:

- **Apache-2.0:** keep the upstream's `NOTICE` file if it has one, beside its license.
- **BSD-3-Clause:** never use the upstream's or its contributors' names to endorse or promote
  musterd.
- **CC-BY-4.0:** credit the work, link the license, and say that it was changed.

When an accepted upstream credits a reference-only source (blader/humanizer credits Wikipedia's CC
BY-SA page), check that it does not copy that source's text before adapting it. Record the method
and result in `PROVENANCE.md`.

This table governs text and style packs that enter the repo. It does not change how code
dependencies are approved.

## Consequences

- The skill's "not yet" notes change to point here: `references/docs-and-a11y.md` §5 and
  `references/charts.md` "Not yet". SKILL.md hard rule 8 stands as written; this ADR is the ADR it
  asks for. Those edits land with the Vale follow-up lane, since that lane changes the skill anyway.
  Follows-up: 01M4VEYYMPX4XVMZ5T11CEJ0W3
- ADR 299's policy reads more widely. Every row already in `PROVENANCE.md` is MIT and unaffected.
- The skill gains a check it can run on its own output, local to each seat, before any CI cost is
  paid.
- _(2026-10-13, lane `01M4VEYYMP`, the trial decision 1 called for.)_ Vale 3.24.0 with every pack
  above ran over `README.md`, `docs/wiki` and `docs/design`: 190 files, 283,625 words by a
  code-stripped count, 68,140 alerts, **240 per 1,000 words**. Fifty alerts per pack, drawn at
  random (seed 579), were graded by read-only seats against brand.md §4–§5 and the comms skill:

  | Pack | Alerts per 1,000 words | Right in the sample | Rules that earned their place |
  | --- | --- | --- | --- |
  | Google | 92.2 | 2 of 50 | `Semicolons` 2 of 7, too weak to keep |
  | Readability | 58.2 | 1 of 50 | none |
  | tbhb/vale-ai-tells | 46.0 | 8 of 50 | a few with one sample each; not enough to judge |
  | jdkato/a11y (with Inclusive, Plain) | 21.2 | 19 of 50 | `Plain.Sentence` 15 of 32, `Plain.Grade` 4 of 15 |
  | Vale spelling | 14.3 | 1 of 50 | none: handles, product names and jargon |
  | Not column as `reject.txt` | 8.0 | 1 of 50 | none: the words are wrong in one sense only |
  | jdkato/diataxis | 0.3 | 3 of 50 | none |

  The stock rules mostly fought conventions the repo keeps on purpose (dated wiki claim headings,
  spaced dashes, `ADR` as a term of art). They also missed the contrast frame, brand.md §4's main
  ban. So the set is replaced with a committed `musterd` style of three rules, graded the same way:
  `ContrastFrame` 22 of 50, `LongSentence` (over 35 words) 27 of 50, `HardParagraph` (grade
  over 13) 19 of 50. jdkato/a11y's alt-text, link and heading-structure rules stay on: they fired
  fewer than ten times, so they were not sampled. The new set runs at 14.1 alerts per 1,000 words.

  **CI does not run Vale.** At best half of the remaining alerts are right, so a gate would block on
  noise and an advisory comment would be ignored. `pnpm prose:lint` stays a local second look, and
  the comms skill runs it before handing copy over. `prose-vocab:check` (in `format:check`) keeps
  the vocabulary in step with the glossary. The candidate ai-tells rules (`ContrastiveNegation`,
  `PseudoCleft`, `LabelAndExplain`) need a sample of their own before they join. To repeat the
  trial, run the packs listed in decision 1 over the same paths and draw 50 alerts per pack with
  seed 579.

- _(2026-10-13)_ nick confirmed decision 4's licence table in session with sloane: "agree with
  your license recommendation". The case made was that each accepted licence asks no more than MIT
  does (keep the notice, credit the source, plus BSD-3's no-endorsement clause and CC BY's note of
  changes), that the installed dependency tree already carries 122 ISC and 59 BSD-3 packages, and
  that the reference-only list holds the licences with real risk (share-alike and copyleft terms
  that would bind our files, and non-commercial terms that conflict with selling musterd).

## Observability & Evaluation

- **Traces:** none. This ADR adds no runtime behaviour.
- **Eval:** the Vale follow-up lane's trial produces the numbers that decide the CI question
  (alerts per 1,000 words and false-positive rate per pack). The comms evals (lane `01M4V98H46`)
  report the skill's with-skill and without-skill scores on the checks in decision 2.
- **Experiment:** the two new jdkato packs run at `suggestion` level through the trial. One moves up
  a level only on a false-positive rate the trial records.
