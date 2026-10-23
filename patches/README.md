# Local dependency security patches

These patches are narrow downstream mitigations for the versions currently
required by Expo and Metro. Keep them until the dependency chain can consume an
upstream fixed release; remove each patch when the dependency chain can consume
that release and the vulnerable version is no longer resolved.

## `node-forge@1.4.0`

The patch requires the nested RSA `DigestAlgorithm` sequence to contain only
its OID and, when present, the optional NULL parameters. This backports the
fix from [digitalbazaar/forge#1158](https://github.com/digitalbazaar/forge/pull/1158),
which is still open and has no published release to consume as of 2026-10-13.
It addresses [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

## `braces@3.0.3`

The patch rejects brace nesting deeper than 100 in the parser, before the
recursive AST walkers run. It addresses
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
which has no published patched release as of 2026-10-13.

These are code patches, not version upgrades. The pnpm lockfile therefore
continues to resolve the advisory-listed versions; GitHub may keep reporting
the Dependabot alerts even though pnpm applies the local changes. Do not
dismiss those alerts as inaccurate. Re-check the dependency graph when upstream
releases become available and remove the local patches with the corresponding
upgrade.

A third patch, `decode-uri-component@0.2.2` (GHSA-vcc3-ghjq-m6fr), was removed
on 2026-10-22 with the Expo SDK 58 bump: `expo-router@58` no longer depends on
`query-string`, so nothing in the tree resolves the vulnerable version and pnpm
refuses an unused patch.
