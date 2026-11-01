# 782 — npm releases publish from CI with provenance

- Status: accepted
- Date: 2026-11-01
- Deciders: nick (asked for the lane; signs off as its `policy: human` risk), izzo (carried)
- Relates to: ADR 156 (lockstep npm release — Decision 2's "no CI publish" superseded here), ADR 669
  (the release train — this is D3's revisit), ADR 145 (republish stays human-gated), ADR 106 (one
  way to land a change); lane `01M6AMQQETY7NZPNCVAAKGG6PY`

## Context

`@musterd/*` is published by `pnpm release` from nick's laptop with his npm credentials (ADR 156).
mcprush's scan of `@musterd/mcp` 0.6.0 (2026-10-28, trust 93/100) deducts one point for
"verification-discount: repo — no provenance", and `npm view @musterd/mcp dist.attestations` is
empty. No published version can be traced to the commit it was built from: a stranger has our
word that the tarball is `main`, and nothing else. ADR 669 D3 kept the laptop publish for the 0.6.0
launch train and named CI trusted publishing as the revisit "after launch, under its own ADR".

npm signs a provenance statement only when the publish runs on a supported CI provider with an
OIDC identity (GitHub Actions with `id-token: write`). npm's trusted publishing goes one step
further: the registry trusts a named workflow file in a named repo (and optionally a named
environment), exchanges the run's OIDC token for a one-time publish credential, and attaches
provenance automatically. That needs npm ≥ 11.5.1 and no stored token at all.

## Problem

How do releases carry provenance without (a) moving a long-lived npm credential into GitHub, (b)
letting anything other than a human decide that a version ships (ADR 145), or (c) losing the
consumer smoke gate that 0.4.0 taught us to run before the first registry write?

## Decision

1. **The publish runs in `.github/workflows/release.yml`, from a tag.** A push of `vX.Y.Z` starts
   it. The job refuses a tag whose commit is not on `main`, builds, runs the consumer smoke
   (`scripts/release/smoke.ts`) and uploads **the tarballs the smoke installed and ran** with
   `npm publish <tarball> --provenance`, in ADR 156's lockstep order. A last step reads every
   package back from the registry and fails the run if any lacks a provenance attestation.
2. **npm trusted publishing, no token.** Each of the five packages on npmjs.com names
   `musterd-io/musterd`, `release.yml` and the `npm-release` environment as its trusted publisher.
   No `NPM_TOKEN` exists in the repo or its environments; a run from another workflow, a fork or
   another environment is refused by the registry. Once the first CI release is green, each
   package's publishing access is set to require trusted publishing and refuse tokens.
3. **A human still decides.** The `npm-release` environment requires nick's approval on every run,
   so pushing a tag publishes nothing by itself. The version is still typed by a human: `pnpm
   release --version X` bumps, builds and smoke-tests, and the bump lands as an ordinary PR through
   `gates` (ADR 106). The tag goes on that PR's merge commit, and `--publish` refuses a tag that
   does not name the on-disk version.
4. **Break-glass, not a second path.** If the workflow cannot run, `pnpm release --publish --tag
   vX.Y.Z --no-provenance` publishes the same way from a laptop with human credentials, and must say
   so in that version's release notes. `--publish` without `--no-provenance` refuses to run outside
   GitHub Actions. `pnpm train status` shows such a version's `provenance` car as missing.
5. **A re-run finishes a half release.** `--publish` skips any package already on the registry at
   that version, so a run that fails between packages is re-run, not repaired by hand.

## Consequences

- One-time setup by nick before the first CI release: create the `npm-release` environment with
  himself as required reviewer, and add the trusted publisher on npmjs.com for each of the five
  packages (workflow `release.yml`, environment `npm-release`). Until both exist the run fails at
  the approval or at the publish, and nothing is written.
- `pnpm release --version X` no longer publishes. Its printed next steps are: PR, merge, tag,
  approve. ADR 669's train order is unchanged; car 2 is a tag and an approval instead of a laptop
  command.
- The smoked tarball and the published tarball are now the same file. Before, `pnpm publish`
  packed a second time and the two were trusted to agree.
- Consumers can check a release: `npm audit signatures`, or the provenance panel on npmjs.com, ties
  each tarball to the workflow run and the tagged commit.
- Brew, the MCP Registry and the GitHub Release stay as ADR 669 orders them; the workflow prints
  their steps in its log, as the laptop run did.
- The publish job gets `id-token: write` and nothing else beyond `contents: read`. The pinned npm
  (`npm@11.21.1`) and the shared setup action are the code that holds the one-time credential.

## Observability & Evaluation

**Traces.** n/a — release tooling runs in CI, not on an agent path.

**Eval.** The lane's done-condition is checked twice. In the run, the verify step fails unless all
five packages at the version carry `dist.attestations.provenance`. Afterwards, `pnpm train status
--version X` has a `provenance` car, green only when every package is attested
(`tests/train.test.ts`). Falsifier: a release that reaches npm with no attestation on any package
means this decision did not hold. Read the next release, and mcprush's next scan of
`@musterd/mcp`, which should drop the "no provenance" deduction.

**Experiment.** n/a — a process change; the first CI release is its test.

Refs ADR-156, ADR-669, ADR-145, ADR-106.
