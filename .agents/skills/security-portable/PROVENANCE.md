# Provenance

Rebuilt 2026-10-16 for the built-in `security` role by the `building-a-role-skill` method. The
portable source is `.agents/skills/security-portable/`; `role create --from security` installs it as
`.agents/skills/security/` and replaces only `references/team.md` with the blank team file. The
existing team-specific `.agents/skills/security/` source was not copied into the installer bundle.

## Adapted sources

| Upstream | Commit | Licence | Material used |
| --- | --- | --- | --- |
| [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) | `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` | MIT | Candidate discovery followed by a separate attempt to disprove; repository-safe patterns first → `references/findings.md` and `references/threat-modeling.md` |
| [getsentry/skills, `gha-security-review`](https://github.com/getsentry/skills/tree/d18b7aa8ba878354e5c348310230e652f7690f9c/skills/gha-security-review) | `d18b7aa8ba878354e5c348310230e652f7690f9c` | Apache-2.0 | Evidence chain from untrusted workflow input to impact; public contribution threat model → `references/threat-modeling.md` and `references/supply-chain.md` |
| [openai/skills, `security-threat-model`](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model) | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 (skill `LICENSE.txt`) | Evidence-linked architecture, explicit trust boundaries and attacker limits → `references/threat-modeling.md` |
| [Threat Modeling Manifesto](https://www.threatmodelingmanifesto.org/) | Read 2026-10-13 in the source skill research | CC BY 4.0 | Four model questions → `references/threat-modeling.md`; attribution retained there |
| [Model Context Protocol Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) | `5ea996028df322ce97d1c906731cf8c05a6e268e` | CC BY 4.0 | Token passthrough, confused deputy, session handles, local-server compromise and SSRF → `references/agents-and-secrets.md`; rewritten and version checked against the current MCP documentation in `references/research.md` |
| [SoK: the AI Cyber Challenge](https://arxiv.org/abs/2602.07666) | Read 2026-10-13 in the source skill research | CC BY 4.0 | Reproduction and human patch review → `references/findings.md` and `references/disclosure-and-fixes.md`; attribution retained there |

The corresponding MIT, Apache-2.0 and CC BY 4.0 license texts are in `LICENSES/`. Apache notices
were not present in the adapted skill files.

## Surveyed, not adapted

| Upstream | Commit | Licence | Decision |
| --- | --- | --- | --- |
| [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8) | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | MIT | Its README and skill tree describe independent verification and machine-readable records. The full workflow assumes parallel agents and an OS-enforced sandbox for target execution. The generic role does not assume either capability, so no files or wording were adapted. |
| [OWASP ASVS](https://owasp.org/projects/asvs) | Project release 5.0.0; checked 2026-10-16 | CC BY-SA 4.0 | Read as a verification reference only. No text was adapted because share-alike material is outside ADR 579's accepted list. |

## Cited without adapting text

NIST SP 800-218 (SSDF v1.1), FIRST CVSS v4.0 User Guide, current MCP security documentation, and the
sources in `references/research.md` are linked for readers to check. No text was copied from them.
