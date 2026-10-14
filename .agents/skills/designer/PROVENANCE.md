# Provenance

Rebuilt 2026-10-13 by sloane with the `building-a-role-skill` method (ADR 586), lane `01M4VPY2D5`,
goal `role-skills`. The first version (2026-09-29) carried the slop-tells table and the
capture-at-true-size check; both are kept, generalized in `references/visual.md` and
`references/handoff.md`, with musterd's specifics in `references/team.md`. Upstream ideas are
adapted and rewritten, never copied whole; licence texts are in `LICENSES/`. Licences follow ADR 579.

## Adapted

| Upstream | Commit | Licence | What was adapted |
| --- | --- | --- | --- |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `2f98774f86bc05563876643db37e6c37c322850f` | Apache-2.0 | `skill/reference/craft-floor.md` (the verify list: contrast, spacing rhythm, measure, states, browser surfaces; the refuse list: identical cards, the hero-metric layout, eyebrow labels, numbered markers, gradient text, glass, glyphs as icons, monospace as costume) → `references/visual.md` §1–2. Its `NOTICE.md` is kept in `LICENSES/`. Its binary launcher was not used. |
| [anthropics/skills](https://github.com/anthropics/skills) `skills/frontend-design` | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 (the skill's own `LICENSE.txt`; the repository root has none) | The calibration list of generated-design defaults, "one authored moment" for motion, and errors that say what happened and how to fix it → `references/visual.md` §1, §5 |
| [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | `434b7f91364665f2f733b310ec54809bf8f37937` | MIT | `command.md` animation, focus, content-handling and touch rules → `references/visual.md` §2, §5; `references/accessibility.md` §2. Its title-case and curly-quote rules are not taken; musterd's brand guide uses sentence case. |

## Kept from the first version

- The ten tells from **"10 Tells of a Slop UI"** (<https://hereticpleb.vercel.app/blog/10-tells-of-slop>,
  read 2026-09-29), paraphrased; no licence was published with the post, so nothing is copied.
  nick endorsed the list for this team on 2026-09-29.
- Capture at true stage size, from miley's lane 5 work on ADR 464 (PR #1822, 2026-09-29).

## Cited with attribution (CC BY 4.0, paraphrased)

- web.dev, Core Web Vitals thresholds: https://web.dev/articles/vitals

## Cited only

WCAG 2.2 and its Understanding documents (W3C Document License, no derivatives); the WAI-ARIA
Authoring Practices; the WebAIM Million 2026; Deque's axe-core coverage study; Sara Soueidan on live
regions; the Command Line Interface Guidelines (clig.dev, CC BY-SA); IBM Carbon's motion guidance;
Radix Colors and GitHub Primer's color roles (licences not verified for the docs); NN/g on response
times and critique; the W3C Design Tokens Community Group format 2025.10; Figma's published agent
guidance (Figma Developer Terms); Playwright's documentation.

## Research

Four read-only researchers (visual and interaction design, accessibility, handoff and verification,
upstream skills) and one repository survey, merged into the report "Designer role skill research"
(sloane's scratchpad, 2026-10-13). Not settled there and so not stated as fact here: whether WCAG
2.2.2 applies to a broadcast stage meant to be screen-captured, and the right announcement rate for
a streaming view.
