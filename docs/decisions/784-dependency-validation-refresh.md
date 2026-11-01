# 784 — Dependency validation refresh

- Status: accepted
- Date: 2026-11-01

## Context

Nick directed big-body to address all current Dependabot findings and treat security and
Dependabot findings as tier 1 work, without waiting for another pickup request. The live
GitHub inventory on 2026-11-01 contains 60 alerts. The prior lane inventory was stale.

## Problem

The available dependency fixes span the MCP SDK, validation, serialization, development
tooling and Expo's transitive dependencies. A Zod major update changes APIs and some defaults;
a version-only edit would break protocol consumers. Some dependencies still require Zod 3.
deepmerge has no published fixed version. Existing local patches must not disappear just
because a dependency version changes.

## Decision

1. Upgrade the existing dependencies to releases covering the current advisory ranges.
   Keep the MCP client, server and core on one release. Use root overrides for transitive
   floors, and the seeds relay's own npm override for its separate dependency graph.
2. Move first-party validation to Zod 4. Preserve the wire contract: explicitly retain sparse
   enum records, optional unknown fields and the sync ingress's deliberate omission of act
   refinements. Adapt record constructors and generic types to the supported API. Invalid
   oversized collections may fail earlier; valid messages keep their existing meaning.
3. Where an upstream release cannot remove a vulnerable path, use a narrow pnpm patch with
   a behavioral regression and a valid-input control. Cover both source and target copies
   in deepmerge. Check the node-forge nested digest guard before removing its old patch.
   Retain the braces mitigation while it is required. Treat any remaining Zod 3 path as a
   separate validation implementation, rather than assuming the direct Zod 4 bump fixes it.
4. Security and Dependabot findings are tier 1 during orientation: validate and address them
   automatically within the team's authorization, claim a lane before writing, coordinate
   existing owners, and record concrete blockers. This does not authorize active offensive
   testing or expand infrastructure privileges.

## Consequences

The dependency graph and focused behavioral tests are the evidence for remediation. GitHub
may continue listing a locally patched dependency by its upstream version; a patch is not a
published fixed release, and an unchanged alert count alone cannot disprove the mitigation.
The regression tests must exercise the installed graph used by the consuming package.

The installed minimatch 3.1.5 used by ESLint has neither `firstPhasePreProcess` nor
`secondPhasePreProcess`; its glob parts are split once without the advisory's amplification
loop. The affected newer branch moves to 11.0.1 while the old callable API remains compatible
with ESLint. npm's broad `<11.0.1` advisory range still reports that old copy; this is a
source-backed applicability distinction, not a suppressed audit.

Zod 4 no longer supplies the old `received` type on every issue. Wake-report refusal auditing
derives only the runtime type of a locally retained issue input; the input value never enters
the audit row. The existing test still checks both type names and secret-value exclusion.

## Observability & Evaluation

**Traces:** existing lane and coordination acts record the inventory, authorization, checks
and landed change. No new runtime telemetry or sensitive payload logging is needed.

**Eval:** compare the 60-alert baseline against the resulting installed dependency graph,
focused malicious-input regressions, ordinary-input controls and CI. Check that protocol
fixtures still parse and sparse records remain sparse.

**Experiment:** removing each downstream guard must restore its failing regression. A
dependency update must pass the owning checks before it replaces a local mitigation.
