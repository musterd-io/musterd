# 562 — Owned drift that overwrites nothing converges

- Status: accepted
- Date: 2026-10-12
- Deciders: nick (asked for the ADR and code fix in chat 2026-10-12), wallow
- Lane: `01M4RH969V8JZP07NXAM1EC9PB`
- Amends: [ADR 282](282-crash-safe-multi-harness-reconciliation.md) §1 and §3 (the `owned-drifted`
  row of the action matrix)

## Context

`musterd agent wallow` on 2026-10-12 reported `⚠ the harness wiring is incomplete (claude-code:
conflict)`. The cause was the repo-shared Claude Code `mcp.musterd` fragment, which every seat
Workspace cut from `~/.musterd/runtime` shares (ADR 143). The machine ledger held that fragment with eight
owners and the fingerprint `24cd14e2…`. The live registration had the fingerprint `17787edf…`. The
fragment the reconciler wanted to write also had the fingerprint `17787edf…`, byte for byte.

ADR 282 classifies every owned fragment whose fingerprint differs from its receipt as
`owned-drifted`. For a desired harness, `owned-drifted` stops with a conflict. The rule does not ask
whether converging would overwrite anything. Here it would not: the fragment already was the intent.
The ledger keeps only a hash, so the writer that left the receipt stale cannot be recovered. A
writer outside the ledger (the pre-ADR-282 `claudeCode.configure` path that runs `claude mcp add`)
is the likely one.

The repair that `musterd doctor` prescribes for `unreachable-drifted` was also a dead end. It says
to delete the entry by hand and run `musterd wire`, because "an ABSENT fragment is the one state
the engine plans for". With a ledger entry present, an absent fragment also has a fingerprint
(`null`) that differs from the receipt. So it was classified `owned-drifted` too, and `wire`
planned `none`. On a repo-shared fragment, following the prescription would have removed the musterd
MCP entry for every seat and never put it back.

## Problem

ADR 282 says drift stops mutation to "preserve evidence": musterd never overwrites content it did
not write. Two drifted states have no such content:

1. the observed fragment equals the current intent, so a write would change nothing;
2. the observed fragment is absent, so a write overwrites nothing.

Calling these a conflict blocks every later provisioning of a shared fragment. No reconciler can
clear it, and the documented hand repair cannot clear it either.

## Decision

For a **desired** fragment with ledger evidence whose observed fingerprint differs from the
receipt:

- **Observed equals the intent fingerprint** → observation `owned-drifted`, plan `add-owner`,
  result `applied`. This is the existing owner-only, journaled operation. It writes nothing to the
  harness. It re-stamps the ledger fingerprint to the intent and adds this Workspace to the owners.
- **Observed is absent** → observation `owned-drifted`, plan `create`, result `applied`. This is the
  existing journaled create. The owner set is kept and this Workspace is added.
- **Anything else** (present, but different from both the receipt and the intent) → unchanged from
  ADR 282: `conflict`, evidence retained.

For a fragment that is **not desired**, ADR 282's rules are unchanged (`release-blocked` /
`unchanged`).

No protocol shape changes. Both plans already exist, and so does their journal recovery: owner-only
recovery finalizes to `intendedFingerprint`, and a create whose old fingerprint is `null` retries the
write.

## Consequences

- A stale receipt on a shared fragment heals on the next `wire`, `harness configure`, `init`, or
  `musterd agent` from any owning Workspace. No one has to edit anything by hand.
- The doctor's `unreachable-drifted` prescription (delete the entry, then `musterd wire`) is now
  true. Its text needs no change.
- A person who deliberately deletes an owned fragment of a desired harness gets it back on the next
  reconciliation. That is what "desired" means. To stop it, deselect the harness.
- The true conflict (content musterd did not write) still stops, with evidence retained.

## Observability & Evaluation

**Traces.** No new span or attribute. The existing `musterd.provisioning.operation` span carries
`observation=owned-drifted` with `action=add-owner|create` and `result=applied` for the converged
cases. Before this ADR, `owned-drifted` always paired with `action=none`.

**Eval.** `packages/cli/src/onboard/reconcile/matrix.test.ts` pins the two new rows: a re-stamp with
no physical write, and a create from absent with owners kept. The existing conflict row (present,
different from both the receipt and the intent) still stops. Baseline: before the change, both new
rows returned `action=none`.

**Experiment.** On this machine, after the change reaches the runtime, run `musterd wire` in any
revive seat Workspace. Falsify: it still reports `claude-code: conflict`, or the ledger fingerprint
for `mcp.musterd` is not `17787edf…` afterwards.
