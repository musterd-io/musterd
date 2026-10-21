# Provenance

SKILL.md and `references/` adapt craft material from the upstream repositories below, per the
vendoring policy in ADR 299. "Adapted" means rewritten for musterd's voice,
charter, and constraints — not copied verbatim; the upstream structure and
ideas are credited here and their license texts preserved in `LICENSES/`.
Pinned SHAs are the upstream HEADs reviewed on 2026-08-21, except where a row
says it was re-pinned or added on 2026-10-13.

| Upstream | SHA | License | What was adapted |
| --- | --- | --- | --- |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | `0f8d89961cdf782dd02644b9df3ddc671c21a7f0` (re-pinned 2026-10-13 from `c6ea1283`) | MIT | `skills/copy-editing` (Seven Sweeps → the editing sweeps in SKILL.md; its 2.11.7 AI-tell check → the negation-list, self-answered-question and vague-adjective rows in `references/prose.md`), `skills/launch` (announcement sizing matrix, phased-release framing; `references/shipped-changes.md` → "From shipped work to an announcement" and the claim-drift check in `references/launch-and-press.md`), `skills/public-relations` (pitch quality bar; `references/story-angles.md` and `references/crisis-communications.md` → "Story angles" and "When something goes wrong" in `references/launch-and-press.md`) |
| [samber/cc-skills](https://github.com/samber/cc-skills) | `3aba3285f060a601316fd2efdfbd194737824c2e` | MIT | `skills/press-release-writer` (inverted-pyramid structure, 5W1H lead constraint, quality checklist, banned-phrase list → `references/launch-and-press.md`) |
| [content-designer/ux-writing-skill](https://github.com/content-designer/ux-writing-skill) | `98cacde4ba2dd10ed28df43a8d53eef1e321c539` | MIT | `SKILL.md` (four quality standards; error/empty-state/button patterns → `references/ux-copy.md`) |
| [mcltyl/brand-voice-skills](https://github.com/mcltyl/brand-voice-skills) | `9c45153de0a1c75e8866164cc704527528626a99` | MIT | `skills/brand-voice` (profile-driven enforcement shape; here the profile is `docs/design/brand.md` §4, not a separate BRAND_VOICE.md) |
| [blader/humanizer](https://github.com/blader/humanizer) | `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` | MIT | `SKILL.md` v3.1.0 (the six pattern families, the mark → draft → check facts → final procedure, strong versus weak-alone patterns, the reply pattern, "when not to act", the injection guard, the second group of the dated word list → `references/prose.md`). Every example is rewritten for musterd; none of its examples are carried over. Lineage check below. |
| [wondelai/skills](https://github.com/wondelai/skills) | `c172996495bed0fcd26896a9416b2093fd7073f0` | MIT | `obviously-awesome` (the per-component tests: "only we", "so what", category moves, trend misuse, the alignment check → `references/positioning-and-gtm.md`), `mom-test` (bad-data types, commitment currencies, zombie leads → `references/research.md`), `jobs-to-be-done` (job statement, three sides of a job, big and little hire → `references/research.md`). Its copy formulas are not taken (brand.md §4). |
| [phuryn/pm-skills](https://github.com/phuryn/pm-skills) | `c68487d721e419ec87af1ae6412a842978eab785` | MIT | `pm-product-discovery/summarize-interview` (the per-interview summary fields → `references/research.md`), `pm-go-to-market/beachhead-segment` (the four segment criteria → "Choosing the next segment" in `references/positioning-and-gtm.md`), `pm-market-research/competitor-analysis` (direct versus adjacent, two-source confirmation → `references/positioning-and-gtm.md`) |
| [jrjsmrtn/diataxis-skills](https://github.com/jrjsmrtn/diataxis-skills) | `4f36079fd36e49803575200273fd39065fa28c44` | MIT | `skills/diataxis-audit` (the five-phase audit, per-type red flags, report shape → "Auditing a set of docs" in `references/docs-and-a11y.md`) |
| [trogera/diataxisSkills](https://github.com/trogera/diataxisSkills) | `8370801b91ff2e75517a1f4ff49b549ae528a4bd` | MIT | `.skills/docs-reorg` critical rules (steps alone are not a tutorial, landing pages hold links, reference is for consulting, a split never invents content → `references/docs-and-a11y.md` §1) |
| [GaZmagik/iso-24495](https://github.com/GaZmagik/iso-24495) | `5951eb7d985018459c62428378926c07f4199794` | MIT | `skills/iso-24495-1` (sentence and paragraph proxies, filler trims, explicit connectors, the code exemption) and `skills/iso-24495-3` (purpose → how parts relate → implementation with file and line) → `references/docs-and-a11y.md` §2. Its bold-lead-in house rule is not taken; it conflicts with the mechanical-bold tell. Its own disclaimer stands: these are proxies, never a claim of ISO conformance. |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) | `156736fb63e965b2f547a1460f3b5972c46e6b24` | MIT | `instructions/markdown-accessibility.instructions.md` (the seven checks and their priority order, naming who each finding affects, offering alt text as a suggestion → `references/docs-and-a11y.md` §4) |

Consulted but not adapted (no material carried over, listed for the record):

- [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) @ `5267cf7bff3031921d4474b8e8f86ad02d2b8f6d` (Apache-2.0) — marketing plugin reviewed; nothing needed beyond what the MIT sources cover.
- [anthropics/skills](https://github.com/anthropics/skills) @ `3b3fad96af16a10759d930941b4520ba0c40edae` — skill format reference ([agentskills.io](https://agentskills.io) specification).

Research trail: the upstream survey was run by the gptbot seat on 2026-08-20
(Codex session; plan recorded in the musterd daemon act log, message rowid
6368). Falsifier: `git -C <clone> rev-parse HEAD` against the SHAs above;
if an upstream moves, re-review before pulling anything new.

## The v2 rebuild (2026-10-13, lane `01M4V98D9T`, goal `comms-skill-v2`)

SKILL.md became a core plus `references/`. The adapted material above moved into
the reference files noted in the table; nothing new was adapted from an upstream
in this change.

The new rules in `references/` are written from primary sources, each cited
inline where it is used: Diátaxis, the Google and Microsoft style guides, W3C
WCAG 2.2 and its tutorials, Keep a Changelog, Common Changelog, Wikipedia's
"Signs of AI writing" (the pattern names and the dated word list, paraphrased),
Kobak et al. 2025, Russell et al. 2025, Anthropic's prompting guide, Hacker News's
guidelines, NN/g, First Round Review, Product Talk, April Dunford, PostHog's
handbook, Working Backwards, the FT Visual Vocabulary, the Urban Institute style
guide, Cleveland and McGill, YC's published essays, DocSend, Redpoint and He et
al. The research behind the choice of sources, with every URL and what was and
was not verified, is the report "Comms skill upgrade research" (claude.ai
artifact `E5DqiQz9DeYGMKSdu2cwD2`, 2026-10-13).

## Increment 2 (2026-10-13, lane `01M4V98FJN`)

The coreyhaines31 re-pin and the six new upstreams in the table above. Each
upstream was cloned and its HEAD checked against the SHA listed; the license
text is in `LICENSES/` under the upstream's name.

**The humanizer lineage check.** blader/humanizer is MIT and credits Wikipedia's
"Signs of AI writing", whose text is CC BY-SA 4.0. Share-alike would bind a
derivative of the page's text, so the question was whether humanizer copies it.
Method: every 8-word run in humanizer's `SKILL.md` was compared with the page's
wikitext (`action=raw`, fetched 2026-10-13). 77 of 5,122 words (1.5%) fall in
shared runs, and every shared run is inside an example of AI-written prose that
both quote, and none is in the rules. The rules are humanizer's own wording. Nothing
here carries humanizer's examples, so neither text is copied into this skill;
the ideas are credited to both. Falsifier: rerun the 8-gram comparison against
the pinned SHA and today's page.

Considered and not adopted: hardikpandya/stop-slop's absolute rules (no passive,
no adverbs) over-correct technical docs. Its five-dimension scoring rubric is a
candidate for the evals in lane `01M4V98H46`.
