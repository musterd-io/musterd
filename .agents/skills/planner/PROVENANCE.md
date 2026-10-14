# Provenance

Rebuilt 2026-10-13 by sloane with the `building-a-role-skill` method (ADR 586), lane `01M4VPY6NT`,
goal `role-skills`. The first version (2026-09-26, #1759) set the loop: pick up the pitch, ask a
few questions as asks, post one plan, wait for an accept, then declare the goal, open the lanes
and hand them out; build lanes to agents, decide and review lanes to humans; never build. All of
it is kept. Its venue specifics (a static front end on Cloudflare Pages, a phone and a projector)
moved to `references/team.md` as history. Upstream ideas are adapted and rewritten, never copied
whole; licence texts are in `LICENSES/`. Licences follow ADR 579.

## Adapted

| Upstream | Commit | Licence | What was adapted |
| --- | --- | --- | --- |
| [obra/superpowers](https://github.com/obra/superpowers) `skills/brainstorming`, `skills/writing-plans` | `bb92a77741419a4ab5f06e711a283343f1ada0c3` | MIT | Sorting open questions into answered, yours to call, and theirs; the smallest unit a reviewer could accept while sending back its neighbour → `references/shaping.md` §2, `references/breakdown.md` §2. Its hand-off to subagent execution is not taken (AGENTS.md hard rule 8). |
| [github/spec-kit](https://github.com/github/spec-kit) `templates/commands/clarify.md` | `96774bc52fd7dccc7185791e1cac7572b9e09dea` | MIT | One question at a time, a recommended answer so "yes" settles it, a stake per question, ranking by impact times uncertainty, a small cap → `references/shaping.md` §2 |
| [openai/skills](https://github.com/openai/skills) `skills/.curated/define-goal` | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 (the skill's own `LICENSE.txt`) | An outcome names what will be true, how it is checked, and its scope; activity is not an outcome → `references/shaping.md` §3 |

## Cited only

Basecamp's Shape Up (problem, appetite, rabbit holes, no-gos; scopes); Amazon's working-backwards
PR/FAQ; INVEST; "Ambig-SWE" (ICLR 2026) on asking about underspecified tasks; SWE-bench Verified
task-length analyses and METR's reviews of agent PRs; GitHub's guidance on work suited to its
coding agent; Anthropic's writing on multi-agent research systems; anthropics/skills
`doc-coauthoring` (no licence found).

## Research

One read-only researcher on planning practice and upstream skills, and one repository survey of
the planner, steward and observer roles, in sloane's scratchpad (2026-10-13).
