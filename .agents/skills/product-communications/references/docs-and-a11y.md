# Docs and accessibility: classify, write, check

Open for docs, a README, release notes, a changelog, or a clarity audit of an ADR
or architecture doc. Most accessibility work in our docs is writing work, so it
lives here too.

## 1. Classify the page before you write it

Diátaxis sorts every page with two questions: is it about action or cognition,
and is it for acquiring a skill or applying one ([Diátaxis compass](https://diataxis.fr/compass/)).

| Type | Serves | musterd examples |
| --- | --- | --- |
| Tutorial | Learning by doing, with a guaranteed result | README quickstart, first-run tour |
| How-to | A competent user doing a task | `docs/wiki/shipping-a-pr.md`, `musterd help <command>` text |
| Reference | Looking something up | `SPEC.md`, `docs/architecture/00–07`, CLI reference |
| Explanation | Understanding why | ADRs, `docs/design/*` |

Rules that follow from the type:

- One type per page. Mixing tutorial and how-to is "a root cause of many
  documentation problems" ([Diátaxis how-to](https://diataxis.fr/how-to-guides/)).
- A how-to holds action and only action, titled "How to …". Move the why to an
  explanation page and link it.
- Run the same two questions on each paragraph when auditing. A paragraph that
  answers differently from its page belongs on another page.
- Docs never announce upcoming features ([Google highlights](https://developers.google.com/style/highlights));
  ROADMAP.md is the only forward-looking home.

## 2. Write to checkable rules

From the [Google developer style guide](https://developers.google.com/style/highlights)
and the [Microsoft style guide](https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice),
where they agree:

- Second person, active voice, present tense, sentence-case headings, the serial
  comma, code font for anything the reader types or sees literally.
- Sentences under 26 words. Define an acronym at first use. One `h1`; never skip a
  heading level ([Google accessibility](https://developers.google.com/style/accessibility)).
- No "above" or "below" for position; link or name the section.
- Conditions before instructions: "To claim a lane, run …".
- For readers whose first language is not English: keep "that", avoid idioms and
  phrasal verbs, at most two nouns stacked before a noun, ISO dates
  ([Google global audience](https://developers.google.com/style/translation)).
- No "simply", "just", "easy" or "obviously". If it were simple, the reader would
  not be reading.
- Bias-free terms: primary/subordinate, allowlist/denylist, they for an unknown person
  ([Microsoft bias-free communication](https://learn.microsoft.com/en-us/style-guide/bias-free-communication)).
- One term per concept, the glossary's (SKILL.md, Voice).

## 3. Formats

**Changelog entry.** [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
categories (Added, Changed, Deprecated, Removed, Fixed, Security), ISO dates, an
Unreleased section, never a commit-log dump. From [Common Changelog](https://common-changelog.org/):
one imperative line per entry that makes sense without its heading, a reference
on every entry (PR number), and **Breaking:** entries first.

```
## [<version>] - <YYYY-MM-DD>

### Changed
- **Breaking:** <Imperative change a reader can act on> (#<pr>)

### Added
- <Imperative addition> (#<pr>)
```

**README.** GitHub's five questions, in order: what it does, why it is useful,
how to start, where to get help, who maintains it ([GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)).
The quickstart is a tutorial: every command copy-pasteable, every expected output
shown as text.

**Quickstart check.** Run the quickstart exactly as written on a clean machine or
container and time install to first useful output. Twilio's long-standing target
for its API is five minutes ([Nordic APIs](https://nordicapis.com/why-time-to-first-call-is-a-vital-api-metric/));
the `first-run-10-minutes` goal sets ours: install to the user's own work on the
board in ten minutes.
Record the time and date in the PR.

## 4. Accessibility pass

The WCAG 2.2 criteria that written content meets or fails:

- **Link purpose (2.4.4, Level A).** Link text says where it goes. Never "click
  here" or "this" ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html)).
- **Headings describe their section** and follow order (1.3.1, 2.4.6).
- **Text alternatives (1.1.1).** Use W3C's alt decision tree: describe what the
  image means; decorative images get empty alt; a complex image (a diagram, a
  chart) gets a short alt plus the full information in text nearby
  ([W3C alt decision tree](https://www.w3.org/WAI/tutorials/images/decision-tree/)).
- **Use of color (1.4.1).** Meaning never rides on color alone.
- **Reading level (3.1.5).** WCAG names no formula and leaves it to judgment
  ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/reading-level.html)). A
  readability score is a tripwire for a second look, never a target.

Terminal output and diagrams, where developer docs fail most:

- A CHI 2021 study with 12 screen-reader developers found command-line output is
  unstructured text, so it only looks accessible
  ([Google Research](https://research.google/pubs/accessibility-of-command-line-interfaces/)).
- Show terminal output as captured text in a code block, never as a screenshot.
- Every ASCII or box-drawing diagram gets a prose equivalent next to it.
- Every ANSI color in brand.md §2 is paired with a word or glyph in UI-copy specs.
  Specs state the `NO_COLOR` and piped-output behavior ([no-color.org](https://no-color.org/)).

Plain language, for ADR and architecture audits: ISO 24495-1's four principles.
Readers get what they need (relevant), can find it (findable), can understand it
(understandable) and can act on it (usable)
([IPLF on ISO 24495-1](https://www.iplfederation.org/iso-standard/)).
Report audit findings to the implementer as a list keyed to those four; the
implementer keeps authorship.

## 5. Not yet

Prose linting with Vale (Google, Microsoft, Readability, A11y and Diátaxis packs,
plus a vocabulary generated from `docs/glossary/terms.ts`) would automate most of
sections 2 and 4. It is a new tool and waits for the comms-skill-v2 tooling ADR
(lane `01M4V98KAW`).
