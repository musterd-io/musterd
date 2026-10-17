# 638 — a superseded harness resource key releases the ledger only

- Status: accepted
- Date: 2026-10-16
- Lane: `01M53GYHCEE1H1BP2PVYX79YZY`
- Builds on: [ADR 282](282-crash-safe-multi-harness-reconciliation.md), [ADR 562](562-owned-drift-that-equals-intent-converges.md)

## Context

`musterd harness status` on a Claude Code seat printed `mcp.musterd` twice: `→ needs wire` and `✓ in place`. Those rows are two ledger resource keys for one physical registration. A repo-shared key carries the repository root (`repo-shared`, root, registration id, harness, fragment key). The desired fragments name the current root. An older root stays in the ledger while this workspace still owns it.

Status, configure, and wire print the fragment key and not the resource key. `harness status --json` omitted `resourceKey` as well.

`fragmentsFor` kept every owned ledger key desired while the harness stayed selected. The stale key therefore never released. After `wire` rewrote the registration to the new intent, the stale receipt no longer matched the file. ADR 282 then kept it as `owned-drifted` and wrote nothing. ADR 562 does not apply: the observed fingerprint equals the new intent, not the old receipt.

## Problem

Treating the stale key as undesired and letting ADR 282 remove it deletes the one registration the desired key still uses. `claude mcp remove` is one server. Apply order writes the desired fragment first, then the extra key, and each step re-reads. A remove on the extra key deletes the server the sibling just wrote. Leaving the extra key desired freezes it as retained drift on the next run.

An owned file that matches neither its receipt nor the current intent — guidance, the canonical skill — is a different state. That file is still not overwritten.

## Decision

1. While a harness is selected and available, a ledger key the current desired fragments do not name is superseded. A selected harness that is not available keeps the key desired. The binary being missing is not a reason to drop the row.

2. When one desired fragment of the same fragment key carries an intent fingerprint, and the observed fingerprint equals it, the plan is `release-owner`. The adapter's `apply` is not called. The journal's `intendedFingerprint` is the observed fingerprint. `intendedOwners` is the other owners. An empty owner list deletes the ledger row, on the apply path and in `finalize`.

3. When the fragment is absent and this workspace is the only owner, the same ledger-only release runs with `intendedFingerprint` null. Recovery sees both fingerprints null and finalizes. It does not take the remove-retry path.

4. When the fragment is absent and another owner remains, the plan is `none` and the result is `conflict`. The receipt stays.

5. When the observed fingerprint differs from the sibling intent and the fragment is present, the key is classified as desired. An `owned-exact` row stays in place. An `owned-drifted` row stays evidence retained. No remove.

6. When no desired fragment shares the fragment key, [ADR 282](282-crash-safe-multi-harness-reconciliation.md) §3 is unchanged. A sole owner of an `owned-exact` fragment removes it. A shared owner releases the ledger row only. Drift reports `release-blocked`.

7. When two desired payloads share one fragment key and their fingerprints differ, the old key stays desired. Nothing removes it.

8. `harness status`, `harness configure`, and `wire` append the repository or folder path after the verdict when one harness prints the same fragment key more than once. The path is dim. A unique key gains nothing, so frame 9's one-row sample stays character-compatible. Matching paths fall back to the registration id. A home directory prefix renders as `~`. `harness status --json` includes `resourceKey`.

9. The journal action enum is unchanged. An owned file that matches neither its receipt nor the current intent is still not overwritten.

## Consequences

- [ADR 282](282-crash-safe-multi-harness-reconciliation.md) §3 carries a dated marker. The physical remove for a deselected harness is unchanged.
- Frame 9 in `docs/design/figma-brief-terminal.md` states the collision suffix. The happy-path columns are the same.
- A co-owner of an absent superseded key keeps a conflict until a later reconcile sees the fragment present and equal to the sibling. That later reconcile is the same rule, run again.
- Two ledger keys for one fragment, with the harness deselected, still follow ADR 282. The first exact key can remove the registration, and the second can report `release-blocked` because the file is now absent. Selecting the harness again plans the desired key first. Once that content is what the extra key observes, the extra key drops from the ledger and the registration stays.

## Observability & Evaluation

- **Traces:** the existing provisioning span records `musterd.action` `release-owner` and `musterd.result` `applied`, `unchanged`, or `conflict`. No new attribute. Resource keys and paths stay off the span, as ADR 282 requires.
- **Eval:** the dataset is the ADR 638 cases in `packages/cli/src/onboard/reconcile/engine.test.ts` and the frame cases in `packages/cli/src/commands/harnessVerdict.test.ts`. Baseline is ADR 282: a selected harness kept every owned ledger key desired, and a sole owner of an exact fragment removed it. After this change a superseded key whose sibling already has the observed content leaves that registration in place and deletes only the stale ledger row. A payload that matches neither the receipt nor the sibling intent is still present afterward.
- **Experiment:** none. The next `musterd harness status` on a seat that holds two keys for one fragment shows the path on each row, and one `musterd wire` clears the stale row when the registration already matches the desired sibling.
