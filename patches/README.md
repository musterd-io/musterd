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

## `decode-uri-component@0.2.2`

The patch backports the scanner helpers from `decode-uri-component@0.5.0`,
at upstream commit
[`a12fabaa28303cc8b5b07e93d128f4fc09fc31e5`](https://github.com/SamVerschueren/decode-uri-component/blob/a12fabaa28303cc8b5b07e93d128f4fc09fc31e5/index.js).
The CommonJS export, outer fallback handling, and `0.2.2`'s `+`-to-space
conversion remain intact. Expo Router's `query-string@7.1.3` requires this
CommonJS dependency; upstream `0.5.0` is ESM. This backport targets this repo's
Node ≥22 and Expo runtime, rather than the old package's Node 0.10 engine claim.

The upstream MIT copyright and permission notice are retained in the installed
package's `license` and copied verbatim to
[`decode-uri-component.LICENSE`](decode-uri-component.LICENSE) for the backported
code. No runtime dependency is added.

As of 2026-10-13, this is a local mitigation for
[GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), whose
upstream fixed release is `0.5.0`. The lockfile still resolves `0.2.2`, so the
version-based advisory remains applicable to the dependency inventory. Remove
the patch when Expo's dependency chain consumes the upstream fixed decoder
with a compatible module contract.

After a frozen install, run the compatibility check against Expo's installed
CommonJS dependency chain:

```sh
node --test patches/decode-uri-component.test.mjs
```

The check covers ordinary Unicode, form spaces and escaped plus signs, repeated
query keys, short incomplete escapes, and non-string rejection. Its expected
results were recorded against unpatched `0.2.2`. The root `test` and `coverage`
commands invoke this standalone Node check before Vitest, including CI's
coverage shards; it is also available as `pnpm test:query-decoder`.

These are code patches, not version upgrades. The pnpm lockfile therefore
continues to resolve the advisory-listed versions; GitHub may keep reporting
the Dependabot alerts even though pnpm applies the local changes. Do not
dismiss those alerts as inaccurate. Re-check the dependency graph when upstream
releases become available and remove the local patches with the corresponding
upgrade.
