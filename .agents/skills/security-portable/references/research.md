# Research behind the security playbook

Read on 2026-10-16. This is a source map and a record of design choices, not a claim of compliance
with any standard. The playbook's procedures are deliberately bounded by the role charter and the
team's own security policy.

## Crafts and what the evidence supports

| Craft | Practice used in the playbook | Evidence and status |
| --- | --- | --- |
| Threat modeling | Describe the system from evidence, map trust boundaries and assets, identify plausible attackers, choose responses and tests, then state gaps. | NIST SSDF supports integrating security practices through the development lifecycle (verified); the four-question method is cited in `threat-modeling.md` (verified in the source skill). |
| Finding validation | Treat scanner output as leads; trace reachability, attempt to disprove a candidate, reproduce safely where authorized, and separate impact from confidence. | NIST SSDF frames vulnerability reduction and root-cause response as lifecycle practices (verified). FIRST CVSS v4.0 separates intrinsic severity from threat and environmental context (verified). |
| Disclosure and fixes | Follow the project's private reporting route, keep details private until the fix is released, make the proof a regression check, and review the patch. | NIST SSDF includes vulnerability response and root-cause prevention practices (verified). Project-specific channels and timelines must come from the local policy (inference from the need for an accountable owner). |
| Agents, tools and secrets | Treat all external content as data, enforce authorization downstream, bind credentials to their intended service, and rotate leaked secrets without testing them. | Current MCP Security Best Practices and Authorization Security Considerations describe confused-deputy, token-passthrough and audience-binding risks (verified). The rules are summarized here in original wording. |
| Dependencies and release | Trace dependency reachability and install behavior; inspect workflow trust, release permissions, provenance and update paths; state what a scanner did not cover. | NIST SSDF supports integrating secure development and supply-chain practices (verified). The repository's package manager and release controls remain local facts (inference; check their configuration). |

## Sources checked

| Source | Checked | What it supports | Use |
| --- | --- | --- | --- |
| [NIST SP 800-218, Secure Software Development Framework v1.1](https://csrc.nist.gov/pubs/sp/800/218/final) | 2026-10-16; final, published 2022-02-03 | Lifecycle security practices, vulnerability response and root-cause prevention | Read and cite; no source text copied |
| [MCP Security Best Practices, specification 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/tutorials/security/security_best_practices.mdx) and [Authorization Security Considerations](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/security-considerations.mdx) | 2026-10-16 | MCP-specific authorization and proxy risks; check the protocol version a project uses | Read and cite; no source text copied |
| [FIRST CVSS v4.0 User Guide](https://www.first.org/cvss/v4.0/user-guide) | 2026-10-16; document version 1.2 | Severity metrics and separation of base severity from threat and environment | Read and cite; no source text copied |
| [OWASP Application Security Verification Standard](https://owasp.org/projects/asvs) | 2026-10-16; project lists v5.0.0 | A versioned requirements source for application security verification | Reference only; CC BY-SA 4.0 is outside the accepted adaptation licences |
| [Cloudflare security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8) | 2026-10-16; commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`; MIT | A multi-phase audit with independent verification and structured findings | Surveyed, not adapted: its full workflow assumes parallel agents and an OS-enforced execution sandbox, which a generic role cannot assume is available |

The claim that a universal role skill should not presume a scanner, a staging environment, a second
agent or a particular disclosure channel is an implementation judgment based on those sources and
the role's authority boundary. Confirm those capabilities in `references/team.md` before relying on
them.
