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
- Steps alone do not make a tutorial. A tutorial states what the reader will
  learn and what they will have at the end; numbered steps without those are a
  how-to.
- A landing or index page holds links. Any instruction or explanation on it
  belongs on a typed page.
- Reference is for consulting. If a reader would read it top to bottom, part of
  it is explanation.

### Auditing a set of docs

1. **Inventory.** List each page with the type it seems to target.
2. **Classify.** Run the compass questions on each page, then on each section.
   A section that answers differently from its page is **mixed**.
3. **Red flags** for each type:

   | Type | Red flags |
   | --- | --- |
   | Tutorial | Explains before acting; offers choices; assumes knowledge of musterd; ends without a result the reader can check |
   | How-to | Teaches from scratch; explains theory; the goal is not in the title or first line |
   | Reference | Contains steps; narrative tone; coverage uneven between entries; opinions or recommendations |
   | Explanation | A list of bare facts; contains steps; never reaches the why or the trade-off |

4. **Gaps.** Which type is missing for this reader? No tutorial means no guided
   first run; no reference means a reader cannot look up a flag.
5. **Report** in this shape. Cite the file and line range for every finding. A
   split plan moves what exists; it never invents content to fill a gap.

```
| Page | Intended type | Actual type(s) | Finding (file:lines) |
Mixed content: <page> lines N–M are <type> inside <type> → move to <page>
Missing: <type> for <reader>, and what that reader cannot do today
Recommendations, highest impact first
```

Rationale on a how-to or reference page moves to an explanation page; it is
never deleted. If an ADR already holds it, link the ADR from the page, and first
check the ADR holds every point the page made. Anything the ADR lacks (a rejected
alternative, a measured cost) moves with the link.

Report audit findings to the page's owner. An ADR or architecture doc keeps its
implementer as author (SKILL.md, Charter).

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

Plain-language limits, as working proxies (GaZmagik/iso-24495's, from public
plain-language practice; following them is never a claim of ISO conformance):

- Sentences average 15–20 words, one main idea each; Google's 26 is the cap.
- Paragraphs of five sentences or fewer, one topic each, main point first.
- Keep the subject next to its verb; never park a clause between them.
- Trim filler: "to" for "in order to", "because" for "due to the fact that",
  "if" for "in the event that".
- Say how ideas relate with "because", "so", "if", "before" and "after".
- Say what to do. Phrase a warning as a warning only when the warning is the point.
- Passive is fine when the actor is unknown or beside the point ("the act is
  recorded").
- Code, commands, logs and quotes are exempt from all of these. Accuracy wins
  any conflict.

**Explaining how something works** (an architecture page, a design note, a
technical post) goes in this order:

1. What it is for, in one sentence.
2. How the parts relate, as a table or a diagram with a prose equivalent beside
   it. Skip this for a single mechanism or a plain sequence of steps.
3. The implementation, with exact file and line citations
   (`packages/server/src/store/lanes.ts:<line>`).

A runbook or an ADR omits the stages it has no content for and keeps the order of
the rest.

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

Markdown, checked in this priority order (after github/awesome-copilot's
markdown-accessibility instructions):

1. **Images.** Every meaningful image has alt text. Flag empty alt on a
   meaningful image, a filename or "screenshot" as alt, and an "image of" prefix
   (screen readers already announce it). Include text that appears in the image.
2. **Headings.** One `#` per file; no skipped levels; no bold line standing in
   for a heading.
3. **Links.** Link text makes sense read alone, because assistive technology lists
   links out of context. Flag "here", "this", "read more", bare URLs in prose,
   and the same link text pointing at two destinations.
4. **Lists and emoji.** Real list markup, never emoji as bullets. No runs of
   emoji (each is read aloud by name). No meaning carried by an emoji alone.
5. **Plain language** (section 2).
6. **Media.** Captions on video, a transcript for audio, no autoplay.
7. **Other.** Tables hold data, never layout. Meaning never rides on bold or
   italics alone. Describe UI paths in words ("open Settings, then Members"),
   with any icon name as a parenthetical extra.

For each finding, say who it affects (screen-reader users, people reading in a
second language, people with cognitive disabilities). Offer alt text and
plain-language rewrites as suggestions for the author to accept, because only the
author knows what the image or sentence is for. Keep the writer's voice.

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
