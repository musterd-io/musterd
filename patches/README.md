# Local dependency security patches

These patches are narrow downstream mitigations for the versions currently
required by Expo and Metro. Keep them until the dependency chain can consume an
upstream fixed release; remove each patch when the dependency chain can consume
that release and the vulnerable version is no longer resolved.

## `deepmerge@4.3.1`

All destination writes define own data properties, including the target-copy loop and both
source-copy branches. This prevents a supplied `__proto__` key from invoking the destination's
prototype setter, while preserving ordinary keys, symbols, arrays and recursive merges.
The CommonJS distribution, UMD distribution and source entry point carry the same change.
It addresses [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
which has no published fixed version as of 2026-11-01.

## `zod@3.25.76`

First-party validation uses Zod 4.6.7. Expo's CLI still requires Zod 3. The legacy patch
rejects arrays exceeding their declared maximum or exact length before visiting elements,
and stops sync and async array parsing at a failing element rather than allocating a
result and issue for every remaining item. Both module formats and the TypeScript source
carry the guard. Valid arrays still parse, in input order. This backports the array boundary
behavior needed for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
It does not impose a size limit on otherwise valid unconstrained arrays.
The bundled `zod/v4` export is not used by the installed Expo CLI and is outside this legacy
entry-point patch; first-party v4 imports resolve the separate 4.6.7 package.

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
checks malformed inputs and ordinary controls. [ADR 784](../docs/decisions/784-dependency-validation-refresh.md)
records the dependency refresh and validation compatibility choices.

The `node-forge@1.4.0` patch was removed on 2026-11-01 with the upgrade to 1.4.2. That
release checks the decrypted DigestInfo against canonical DER encodings with and without
NULL parameters. Installed verification rejects extra nested elements and accepts ordinary
signatures, including the cases the old local patch guarded.

A third patch, `decode-uri-component@0.2.2` (GHSA-vcc3-ghjq-m6fr), was removed
on 2026-10-22 with the Expo SDK 58 bump: `expo-router@58` no longer depends on
`query-string`, so nothing in the tree resolves the vulnerable version and pnpm
refuses an unused patch.
