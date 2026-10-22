# 709 — Guidance names what it teaches

- Status: accepted
- Date: 2026-10-22

## Context

The member guidance (`packages/protocol/src/guidance.ts`, ADR 085) is the playbook every
seat runs under. ADR 085's layering rule allows exactly one duplication between the skill
and the system: command and tool *names*, made safe by `pnpm guidance:check`, which asserts
every name in `SKILL_MCP_TOOLS` / `SKILL_CLI_COMMANDS` still exists. The check is
deliberately one-directional (its header says why): it proves a taught name resolves, not
that everything worth teaching is taught.

An audit of guidance v56 against shipped work (2026-10-22, lane 01M5GYXTK1) found the
one-directional gap paid twice:

- ADR 603 (landed 2026-10-15, #2629) made a risk-tagged lane close in two stages: while a
  human review is owed and its window runs, the owner's `done` is refused. The skill's
  closing section taught only the three ADR 235 contracts, so an owner following it met an
  unexplained 409.
- `lane_update` / `musterd lane update` — the mid-flight edit (state, branch, scope, goal,
  metric) — was named nowhere in the skill, so the name was also unpinned: a rename would
  rot silently, the failure `guidance:check` exists to prevent. `team_agent_create` was
  taught in prose (ADR 449/452 sponsored agents) but likewise unpinned, and it is
  registered on the remote rail (ADR 630), outside the `TOOL_NAMES` list the check reads.

## Problem

A playbook that omits a refusal rule trains seats to collide with it; a taught name the
gate does not pin rots on the next rename. Both are the same defect from two sides: what
the guidance *says* and what the gate *guards* had drifted from what shipped.

## Decision

Guidance v57, in this change:

1. The closing section teaches the ADR 603 two-stage risky close as step 4: a peer's accept
   is the first stage; while a human review is owed and its window runs, the owner's
   `done` is refused (the refusal names the confirming peer and the window, and is the
   rule working, not a wedge); `abandoned` is never refused.
2. `lane_update` is taught in one line — keep the lane current (`state`, branch, scope,
   detail, goal link, metric) — and added to `SKILL_MCP_TOOLS`, pinning the name.
3. `team_agent_create` is added to `SKILL_MCP_TOOLS`, and `scripts/check-guidance.ts`
   unions `REMOTE_TOOL_NAMES` (ADR 630) into the registry it checks against, so a
   remote-rail name the skill teaches is pinned like any other.

Checked and deliberately **not** added: advisory acceptance scope (ADR 667). The
lane-review ask itself tells an advisory seat at delivery ("your acceptance scope is
advisory… does not close or reopen it. A binding acceptor is asked beside you",
`packages/server/src/transport/http.ts`), so the seat learns it at the moment it matters;
a playbook line would duplicate a delivered fact. Seeds, `team_report` and the ops
commands stay untaught by design (ADR 085 layering; `check-guidance.ts` header).

Follows-up: none — the audit's proven set is closed by this change; the next surface-map
reading is owed when the next member-facing tool lands, per the check's own header
(2026-10-22).

## Consequences

- `GUIDANCE_CONTENT_VERSION` moves 56 → 57; the rendered-surface snapshot hash is pinned
  in `guidance.test.ts` (bump-on-change discipline, ADR 085).
- Every workspace receives v57 on its next guidance refresh (`musterd init
  --refresh-guidance` or the ADR 408 self-heal); the per-workspace epoch attestation
  (ADR 417) is what reports who still runs older guidance. This record does not push the
  new content into running workspaces — source current and members current remain two
  different facts, and the census owns the second.
- `guidance:check` now reports 25 MCP tools resolving (was 23–24 across v55/v56).

## Observability & Evaluation

- Traces: the guidance epoch census (`installedGuidanceEpoch`, ADR 417) reports the
  minimum installed guidance version per workspace, so v57's spread — and any workspace
  still on v56 or older — is measurable from presence, not assumed.
- Eval: `packages/protocol/src/guidance.test.ts` pins the rendered surface per version
  (39 tests) and `scripts/check-guidance.ts` fails the build if a taught name stops
  resolving on either rail. Both ran green on this change; CI's `docs` leaf runs the
  ADR gate this record satisfies.
- Experiment: n/a — no rollout split; the change is content on a surface every member
  already receives, and the epoch census is the before/after measure.
