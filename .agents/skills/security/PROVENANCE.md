# Provenance

Rebuilt 2026-10-13 by sloane with the `building-a-role-skill` method (ADR 586), lane `01M4VPY3M7`,
goal `role-skills`. The first version (2026-09, #1062) set how audits run on this team: audit
lanes, private findings, one remediation lane per accepted finding, and the authorization for
active testing. All of it is kept, in `references/team.md` "How audits run here". Upstream ideas
are adapted and rewritten, never copied whole; licence texts are in `LICENSES/`. Licences follow
ADR 579.

## Adapted

| Upstream                                                                                            | Commit                                     | Licence                                                                        | What was adapted                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) | `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` | MIT                                                                            | `.claude/commands/security-review.md`: find candidates, then disprove each in a separate pass and drop those below 8 of 10; learn the repository's own safe patterns first → `references/findings.md` §2, `references/threat-modeling.md` §3. Its exclusion "user-controlled content in AI system prompts is not a vulnerability" is left out: on a team of agents it is the main threat (`references/agents-and-secrets.md` §1). |
| [getsentry/skills](https://github.com/getsentry/skills) `skills/gha-security-review`                | `d18b7aa8ba878354e5c348310230e652f7690f9c` | Apache-2.0 (repository)                                                        | The four-part attack path a finding must show (entry point, payload, execution, impact), "report zero findings when there are none", the outsider-without-write-access threat model for workflows and its safe patterns → `references/threat-modeling.md` §3, `references/supply-chain.md` §3. Its sibling `skills/security-review` is derived from OWASP (CC BY-SA), so it is cited only.                                        |
| [openai/skills](https://github.com/openai/skills) `skills/.curated/security-threat-model`           | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 (the skill's own `LICENSE.txt`; the repository has no root licence) | Evidence for every claim about the system, trust boundaries as concrete edges, stating what the attacker cannot do, runtime apart from CI and tests, likelihood × impact → `references/threat-modeling.md` §2, `references/findings.md` §3                                                                                                                                                                                        |

## Adapted with attribution (CC BY 4.0)

- The Model Context Protocol, "Security Best Practices" (docs version 2026-07-28, commit
  `5ea996028df322ce97d1c906731cf8c05a6e268e` of modelcontextprotocol/modelcontextprotocol):
  token passthrough, confused deputy, session handles, local server compromise, SSRF, scopes →
  `references/agents-and-secrets.md` §2.
- The Threat Modeling Manifesto (threatmodelingmanifesto.org): the four questions →
  `references/threat-modeling.md` §1.
- "SoK: the AI Cyber Challenge" (arXiv 2602.07666): repeated reproduction; patches that passed
  automated checks and failed human reading → `references/findings.md` §2,
  `references/disclosure-and-fixes.md` §3.

## Cited only

OWASP Top 10 for LLM Applications 2025, the OWASP Agentic Top 10 and the OWASP cheat sheets
(CC BY-SA 4.0: paraphrased, never copied); trailofbits/skills (CC BY-SA 4.0); semgrep/skills (Semgrep
Rules License); Simon Willison on the lethal trifecta; Meta's Agents Rule of Two (2025-10-31);
Trail of Bits on line jumping; Invariant Labs on tool poisoning; FIRST CVSS 4.0 user guide; Google
Project Zero and CERT/CC disclosure policies; GitHub Docs on security advisories; the OpenSSF
guide to evaluating open source software; npm and pnpm documentation; Dan Abramov on `npm audit`;
Daniel Stenberg on curl's bug bounty; vendor write-ups of the Nx, chalk/debug, Shai-Hulud and keyv
incidents (for keyv: Aikido, The Hacker News, and Singapore CSA advisory AD-2026-009, August
2026); CVE-2025-66414.

## Research

Four read-only researchers (threat modeling and agent threats, the finding lifecycle, supply chain
and posture, upstream skills) and one repository survey, merged into notes in sloane's scratchpad
(2026-10-13). The survey's list of candidate weaknesses went to the role holder privately and is
not recorded here.
