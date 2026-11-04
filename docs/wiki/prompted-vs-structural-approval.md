# Prompted vs structural approval

Which of musterd's "a human approves first" rules a mechanism enforces, and which rest on prose alone, checked against revive on 2026-11-04 after the radar flagged Concordat (arXiv 2610.37461).

## Why this page exists

Concordat ("Typed Sessions for LLM Agents", radar digest 2026-W44, draft PR #3325) withholds tools that are not yet allowed, so the agent cannot call them, rather than asking it in the prompt to wait. It measures agents breaking confirmation rules under social pressure, and outcome-scored benchmarks missing most of those breaks. musterd already holds the same belief: ADR 150's gates are "structural inducement", not instructions. This page checks how much of that is true on the team that dogfoods it. Related: [agent permission-enforcement patterns](agent-permission-enforcement-patterns.md).

## The headline: the revive gate table has one class

The ADR 150 gate decides with the team's enforcement table (`musterd team policy --enforce-surface` for Gate A lane ownership, `--enforce-action` for Gate B costly-action→ask). An undeclared call is allowed with no round trip (`packages/cli/src/commands/gate.ts`, "undeclared call → allow"). On revive the table served to a seat holds exactly one class: `taildrop`, a `role-route` that sends `tailscale file cp *` to the courier role. It has no `contended-surface` class and no `costly-action` class. So on revive, Gate A never checks lane ownership and Gate B never turns an action into an ask (2026-11-04, dolly's `.musterd/enforcement-cache.json`, fetched 12:02 PT; falsify: `musterd team policy` as a human admin lists any `contended-surface` or `costly-action` class, or a gate audit row with `action='lane.gate'` dated after 2026-10-01 exists). <!-- claim: defect -->

AGENTS.md's hard rule 8 and the musterd skill say the ADR 150 lane gate "cannot see" a subagent. That is still true, but on revive the gate also sees nothing for the seat itself, because no class asks it to look. Lane ownership is held by the board's warnings and by the seats reading them (2026-11-04; falsify: an edit to a path in another seat's claimed lane draws a gate deny or advisory line on revive). <!-- claim: defect -->

The gate also fails open when the daemon is unreachable, except for a `block`-posture or `costly-action` class (`outageVerdictForMatch` in `gate.ts`). In this one session the hook printed `unenforced (gate unreachable)` on at least 8 tool calls while the CLI reached the daemon ([gate unreachable despite CLI reachability](gate-unreachable-despite-cli-reachability.md)).

## The table

"Structural" means a check refuses the action. "Measured" means a record is written, but the action proceeds. "Prose" means only words stand in the way.

| Rule | Where it is stated | What enforces it | Kind |
| --- | --- | --- | --- |
| Claim a lane before you build; never build in a teammate's lane | AGENTS.md, musterd skill, MCP instructions | ADR 150 Gate A, but no `contended-surface` class is declared on revive | **prose** on revive |
| Ask a human before a costly or irreversible action | AGENTS.md, MCP instructions | ADR 150 Gate B, but no `costly-action` class is declared on revive | **prose** on revive |
| A blocking ask HOLDS for 15m | the `team_send` reply contract | nothing stops the asking seat from acting before the answer | **prose** |
| Deploys go through an ask; nick accepts them from /live | nick's machine-local Claude memory | `musterd service refresh` is not gated | **prose** |
| No subagent that writes | AGENTS.md hard rule 8, global instructions | ADR 163 records `actor.subagent_write`; "it cannot change whether the call proceeds" (`gate.ts`) | **measured** |
| Commit or push only when the user asks | the harness system prompt | ADR 516 Team merge hold, when a human has set one | prose, structural under a hold |
| Never `git push --force` | AGENTS.md git workflow | branch protection refuses force-push to `main` only; feature branches are open | structural on `main` only |
| Never merge past a red `gates` run; squash only | AGENTS.md git workflow | GitHub branch protection: required check `gates` | **structural** |
| A protocol schema change needs an ADR | AGENTS.md hard rule 1 | `change-adr:check` in CI, rule 1 | **structural** |
| A new runtime dependency needs an ADR | AGENTS.md hard rule 6 | `change-adr:check` in CI, rule 2 (`dependencies` only) | **structural** |
| An accepted ADR's Decision is frozen | AGENTS.md, 07-conventions | `change-adr:check` | **structural** |
| A merge attests the authorizing human | `lane_submit` contract | ADR 662: `authorized_by` refused without an A2 device signature (refused for dolly 2026-11-04) | **structural** |
| A risky lane's owner cannot close it before a human | ADR 603 | the server refuses the owner's `done` | **structural** |
| A seat cannot act in another seat's session | ADR 442 | the PreToolUse session-reach deny | **structural** |
| A seat uses only its allowed tools | ADR 794 | the `seat_tools` policy key | **structural** |
| Taildrop goes through the courier | courier skill | the `taildrop` role-route class | **structural** |
| Credentials never travel by courier unless a human asked for that transfer | courier charter | nothing inspects what is carried | **prose** |
| A radar digest graduates only by a human | radar README ("never auto-merged") | the workflow opens a draft; `main` requires 0 approving reviews, so any seat can mark it ready and merge it | **prose** |

Each prose row was checked against code or configuration (2026-11-04; falsify: for each row, an action of that kind refused by a check rather than declined by the agent — a deny line from the gate, a server refusal, or a GitHub protection error). <!-- claim: other -->

## What the table says

The rules that protect the record are structural: protocol, dependencies, ADR Decisions, merge attestation, risky-lane closes, session reach. The rules that protect a human's say in an action are mostly prose: claim before build, ask before costly, the blocking HOLD, deploys, radar graduation. That is the split Concordat warns about: the confirmation rules are the ones agents break under pressure, and an outcome check will not notice.

Most of the gap needs no new mechanism. Gate B already turns a declared action into an ask and denies until it is answered. What is missing is the declarations, and declaring them is a team-policy act by a human admin, not an ADR (2026-11-04; falsify: `--enforce-action` cannot express one of the candidates below, or a declared costly-action class is still allowed with no ask). <!-- claim: defect -->

Candidates, each a `--enforce-action class=glob`: `service-refresh=musterd service refresh*` (the deploy rule), `radar-graduate=gh pr ready*` (too broad as written, so it needs a narrower match), and `--enforce-surface` globs for the paths the team most often collides on.

Two rows are beyond declarations. The blocking HOLD would need the gate to deny a seat's next costly action while its own blocking ask is open, and the courier's content rule cannot be checked by a glob. Either of those is a mechanism change and would need an ADR (2026-11-04; falsify: an existing gate already denies a seat's action while its own blocking ask is open). <!-- claim: other -->

Related: [running the gates](running-the-gates.md), [gate unreachable despite CLI reachability](gate-unreachable-despite-cli-reachability.md).
