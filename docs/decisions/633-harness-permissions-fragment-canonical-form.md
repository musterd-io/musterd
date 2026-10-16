# 633 — the claude-code permissions fragment observes in canonical rule form

- Status: accepted
- Date: 2026-10-16

## Context

Two ADRs own the same file, `.claude/settings.local.json`, from different sides:

- **ADR 261** owns the harness permission *floor* — `installSeatPermissions` (the merge behind
  `musterd init --refresh-permissions`), `inspectSeatPermissions`, and `STANDARD_FLOOR`. Since
  2026-08-13 both compare entries through `canonicalRuleForm`, which folds the three
  trailing-wildcard spellings Claude Code treats alike (`Bash(cmd *)`, `Bash(cmd:*)`,
  `Bash(cmd*)`) into one canonical string. The code comment states the invariant outright:
  *install and check must agree on what "present" means, or a silent check follows a non-empty
  install forever.*
- **ADR 282** owns fragment *reconciliation* — `musterd harness status` / `configure`. Its
  claude-code permissions fragment observer decided "present" with a raw-string `have.has(e)`
  set lookup, never brought into that agreement.

## Problem

A seat whose `.claude/settings.local.json` carries a floor entry in an alternate working
spelling — e.g. `Bash(pnpm test*)` where the floor spells `Bash(pnpm test *)` — gets two
contradictory answers from the two sides, and no musterd command can reconcile them:

- the merge sees equivalence, so `musterd init --refresh-permissions` reports
  *"already carry the standard floor — nothing to add"* — a guaranteed no-op, by design;
- the fragment observer sees the entry absent, the subset incomplete, the fingerprint ≠ intent,
  so `musterd harness status` reports `permissions ✗ unmanaged-conflict` — forever, because
  ADR 282 (correctly) refuses to mutate an unmanaged fragment.

The only escape is a hand edit of the settings file. Observed live in stanley's workspace
(2026-10-16): five no-space entries held a whole workspace red on `harness status` while the
repair command insisted there was nothing to do.

## Decision

The claude-code permissions fragment's `observe` compares each desired entry in
`canonicalRuleForm` — the same exported function the ADR 261 merge and inspector use, from the
same module (`onboard/permissions.ts`), so there is one notion of "present", not two. A settings
file that carries every desired entry in **any** of the three working spellings observes
complete: fingerprint equals intent, the fragment classifies `unmanaged-equivalent`, and status
reports `satisfied (unmanaged)` — green, with no ownership taken.

Spelling equivalence only, deliberately — no subsumption (`Bash(git *)` still does not cover
`Bash(git push *)`), exactly the scope ADR 261 already drew. ADR 282's mutation matrix is
unchanged: nothing new is ever written or overwritten by this.

## Consequences

- Workspaces with alternate spellings go green through `musterd harness status` alone; the
  merge remains the repair path and still writes the canonical space form when an entry is
  genuinely absent.
- The incomplete-subset fingerprint is now computed over the desired spellings of the entries
  present (it previously echoed whichever raw strings happened to match), which makes it stable
  across a workspace's choice of spelling.
- ADR 261's "install and check must agree" invariant now covers all three readers: install,
  inspect, and fragment observe.

## Observability & Evaluation

- Traces: n/a — not an agent-facing act; the change is a pure comparison in a read-only
  observer.
- Eval: unit coverage in `claudeCodeFragments.test.ts` — a settings file whose allow list is
  the floor in no-space spellings must observe as `present` with the intent fingerprint
  (pre-fix it observed incomplete); plus the standing `permissions.test.ts` merge cases.
- Experiment: n/a — the defect and the fix are both deterministic single-workspace states; no
  fleet rate to measure.
