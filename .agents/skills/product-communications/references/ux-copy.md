# UX copy: specs for the designer

Open for any UI-copy spec handed to the designer role. Adapted from the upstream
ux-writing skill (see `PROVENANCE.md`).

Four standards for every string: **purposeful** (helps the user's task),
**concise** (no word that isn't working), **conversational** (how a person says
it), **clear** (no doubt about what happens next).

- **Errors**: what happened, why (if known), what to do next, in that order.
  Never blame the user; never a bare "something went wrong" when the cause is
  known.
- **Empty states**: say what will appear here and how to cause it. The CLI's
  registered example: `inbox empty — nobody's mustered anything yet`.
- **Buttons and links**: verb first, named for the outcome. Link text says where
  it goes (WCAG 2.4.4; `docs-and-a11y.md`).
- **Color**: meaning never rides on color alone; the act name is always written
  (PRODUCT.md accessibility). Terminal specs state `NO_COLOR` and piped-output
  behavior.
- **Names**: what the person recognizes (the board, the inbox, the office), never
  how the system is built (the daemon, MCP, the hub; ADR 578).

## Handoff format

A table of `surface / state / exact string / notes` (constraints, character
limits, glossary terms used). The spec is exact: the designer implements it
verbatim or bounces it back, and nobody paraphrases copy in transit. Long-lived
page specs live in `docs/design/*-copy-spec.md` (for example
`homepage-copy-spec.md`), newest revision on top.
