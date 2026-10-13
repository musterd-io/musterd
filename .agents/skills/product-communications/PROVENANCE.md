# Provenance

SKILL.md adapts craft material from the upstream repositories below, per the
vendoring policy in ADR 299. "Adapted" means rewritten for musterd's voice,
charter, and constraints — not copied verbatim; the upstream structure and
ideas are credited here and their license texts preserved in `LICENSES/`.
Pinned SHAs are the upstream HEADs reviewed on 2026-08-21.

| Upstream | SHA | License | What was adapted |
| --- | --- | --- | --- |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | `c6ea12834be62bdc4180a1385f6455cde84ae60c` | MIT | `skills/copy-editing` (Seven Sweeps → the editing sweeps in SKILL.md), `skills/launch` (announcement sizing matrix, phased-release framing → `references/launch-and-press.md`), `skills/public-relations` (pitch quality bar informing the press-release quality bar → `references/launch-and-press.md`) |
| [samber/cc-skills](https://github.com/samber/cc-skills) | `3aba3285f060a601316fd2efdfbd194737824c2e` | MIT | `skills/press-release-writer` (inverted-pyramid structure, 5W1H lead constraint, quality checklist, banned-phrase list → `references/launch-and-press.md`) |
| [content-designer/ux-writing-skill](https://github.com/content-designer/ux-writing-skill) | `98cacde4ba2dd10ed28df43a8d53eef1e321c539` | MIT | `SKILL.md` (four quality standards; error/empty-state/button patterns → `references/ux-copy.md`) |
| [mcltyl/brand-voice-skills](https://github.com/mcltyl/brand-voice-skills) | `9c45153de0a1c75e8866164cc704527528626a99` | MIT | `skills/brand-voice` (profile-driven enforcement shape; here the profile is `docs/design/brand.md` §4, not a separate BRAND_VOICE.md) |

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

Not yet done, and owned by later lanes of the goal: re-pinning coreyhaines31 to
`0f8d89961cdf782dd02644b9df3ddc671c21a7f0` after reviewing its `launch`,
`copy-editing` and `public-relations` changes, and adapting new upstreams
(blader/humanizer after a check of its Wikipedia lineage, wondelai/skills,
phuryn/pm-skills, jrjsmrtn/diataxis-skills, GaZmagik/iso-24495, github/awesome-copilot's
markdown-accessibility instructions). Lane `01M4V98FJN`.
