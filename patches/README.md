# Local dependency security patches

These patches are narrow downstream mitigations for the versions currently
required by Expo and Metro. Keep them until the dependency chain can consume an
upstream fixed release; remove each patch when the dependency chain can consume
that release and the vulnerable version is no longer resolved.

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

`tests/dependency-guards.test.ts` resolves dependencies through Expo's installed graph and
checks malformed inputs and ordinary controls, and checks that the lockfile no longer resolves
the Zod 3 or deepmerge versions removed below. [ADR 784](../docs/decisions/784-dependency-validation-refresh.md)
records the dependency refresh and validation compatibility choices.

The `zod@3.25.76` and `deepmerge@4.3.1` patches were removed on 2026-11-04 with the bump to
Expo SDK 58.0.23 (GHSA-mrhx-c7xc-m3w5, GHSA-gcqx-w48m-w2h4). Its `@expo/cli` 58.1.19 no
longer depends on Zod, and its `@expo/config` 58.0.11 no longer depends on deepmerge, so
neither vulnerable version resolves.

The `node-forge@1.4.0` patch was removed on 2026-11-01 with the upgrade to 1.4.2. That
release checks the decrypted DigestInfo against canonical DER encodings with and without
NULL parameters. Installed verification rejects extra nested elements and accepts ordinary
signatures, including the cases the old local patch guarded.

A third patch, `decode-uri-component@0.2.2` (GHSA-vcc3-ghjq-m6fr), was removed
on 2026-10-22 with the Expo SDK 58 bump: `expo-router@58` no longer depends on
`query-string`, so nothing in the tree resolves the vulnerable version and pnpm
refuses an unused patch.
