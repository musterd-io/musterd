# Provenance

Rebuilt 2026-10-13 by sloane with the `building-a-role-skill` method (ADR 586), lane `01M4VPY4VC`,
goal `role-skills`. The first version (2026-10-04, #2060; the gate, #2084 under ADR 513) set the
role's shape: route-agnostic authority, routes only as listed and compiled, the request's four
facts, one record per transfer, credentials only on a human's exact ask. All of it is kept, in
`SKILL.md` and `references/team.md`. No published skill covers this work, so the text is original;
the sources below are cited and paraphrased.

## Cited

- Tailscale's Taildrop documentation (tailscale.com/kb, last validated 2026-01-05) and the
  `tailscale file` CLI source: who can send, directories, offline targets, where files land,
  conflicts, names, resume, error strings → `references/routes.md` §1.
- RFC 8493 (BagIt): a manifest of sha256 lines plus total bytes and file count; "complete" and
  "valid"; a manifest is no defence against an active attacker, so it travels separately →
  `references/verify-and-record.md` §2.
- NIST SP 800-72 and SP 800-101r1 on chain of custody (who handled it, when, for what) → the
  record's fields, `references/verify-and-record.md` §3.
- GitLab's public data classification standard (handbook; licence believed CC BY-SA, so cited
  only) and FIPS 199 (public domain, the high-water mark) → `references/material.md` §1.
- GDPR Article 5(1)(b) and (c), purpose limitation and data minimisation → `references/material.md` §2.
- gitleaks (MIT) for scanning a plain directory → `references/material.md` §3.
- Simon Willison on the lethal trifecta; Meta's Agents Rule of Two (2025-10-31) →
  `references/verify-and-record.md` §1.
- magic-wormhole, croc, rsync, Syncthing and S3 presigned-URL documentation for the carrier
  comparison → `references/routes.md` §3.

## Research

Two read-only researchers (transfer practice; data handling and upstream skills) and one
repository and team-home survey, in sloane's scratchpad (2026-10-13). The survey also found two
items for the security role, which went to its holder privately.
