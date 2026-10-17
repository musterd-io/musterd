# Evaluation results

## 2026-10-17 — first complete run and portability check

**Skill snapshot:** working tree based on `0c5f3c0c1`, before commit. The final snapshot includes the targeted fixes listed below. **Model:** `gpt-6.1-sol`. **Method:** each answer came from a fresh, ephemeral Codex session in read-only mode. Three sessions ran concurrently. A separate fresh grader session saw anonymized A/B answers, the case input and the expectations, but not the skill or configuration. Case pairings were assigned from fixed seeds. Readiness is 1–10. The author did not grade the answers; grader mistakes were checked against the source and recorded.

The first 20-session attempt was invalid: the runner treated `evals/files/...` as repository-root paths, while the fixtures are relative to the skill directory. No result from that attempt is counted. I corrected the runner to use `.agents/skills/security-portable/evals/files/...` and reran all cases and graders. The correction, not a change to the fixtures, produced the complete run below.

| Context | Configuration | Expectations passed | Readiness total (mean) | Preferred by graders |
| --- | --- | ---: | ---: | ---: |
| Repository | With skill | 40/40 | 91 (9.1) | 9 cases |
| Repository | No skill | 24/40 | 73 (7.3) | 0 cases |
| Blank-team install | With skill | 40/40 | 92 (9.2) | 10 cases |
| Blank-team install | No skill | 23/40 | 67 (6.7) | 0 cases |

Repository case 9 was a tie: both answers passed all expectations. The other repository cases favored the skill. Every scratch case favored the skill.

| ID | Case | Repository: skill / baseline | Scratch: skill / baseline | Preference: repository / scratch |
| ---: | --- | ---: | ---: | --- |
| 1 | Public webhook bridge | 4/4 / 3/4 | 4/4 / 3/4 | Skill / skill |
| 2 | Localhost admin reset | 4/4 / 2/4 | 4/4 / 2/4 | Skill / skill |
| 3 | Audit leads | 4/4 / 4/4 | 4/4 / 4/4 | Skill / skill |
| 4 | Unverified tenant read | 4/4 / 2/4 | 4/4 / 3/4 | Skill / skill |
| 5 | Public proof | 4/4 / 0/4 | 4/4 / 0/4 | Skill / skill |
| 6 | Leaking patch | 4/4 / 2/4 | 4/4 / 1/4 | Skill / skill |
| 7 | Poisoned message | 4/4 / 3/4 | 4/4 / 3/4 | Skill / skill |
| 8 | Leaked credential | 4/4 / 3/4 | 4/4 / 3/4 | Skill / skill |
| 9 | New library review | 4/4 / 4/4 | 4/4 / 3/4 | Tie / skill |
| 10 | Untrusted workflow title | 4/4 / 1/4 | 4/4 / 1/4 | Skill / skill |

The scratch repository contained only the task inputs and the installed `security` skill: the skill's `team.md` was replaced with the skeleton's blank template, its `evals/` directory was omitted, and its frontmatter name was rewritten to `security` as the CLI bundler does. Cases 2, 5, 7, 8 and 10 were rerun after fixes; the other cases did not use the changed guidance. The final scratch pass preferred the skill for all 10 cases.

## What changed after the first valid run

The evaluation exposed several procedural gaps, so I changed the core or the relevant craft reference and reran the affected cases in both contexts:

- Localhost review now explicitly checks server-side authentication, Host and Origin, schema validation, safe methods and wildcard CORS (case 2).
- Suspicious requests for remote execution, secrets or an authority bypass now require independent verification and notification to the security owner about possible sender compromise, without asserting compromise as fact (case 7).
- Credential exposure guidance now asks the owner to review access records, investigate and record the escape path, and add a preventive check (case 8).
- CI review now explicitly reports outsider triggerability, privileged execution of untrusted code, immutable action pins and least-privilege permissions (case 10).
- Public-proof response guidance now asks maintainers to redact promptly, use or establish a private reporting route, keep reproduction/rating private, give a neutral public fix description, and publish the fix before the advisory with reporter credit (case 5).

One grader limitation was corrected by hand: the repository grader called a skill-based statement in case 7 unverifiable because blind graders were instructed not to read the skill. I checked it against the actual core rule and found it accurate; it is not counted as a factual error. The scratch grader similarly flagged case 1's statement that the team-specific route was unrecorded; direct inspection confirmed the shipped blank team template contains placeholders, so this is accurate. All final factual-error counts are zero after those corrections.

## Deterministic checks

`node .agents/skills/security-portable/evals/check.mjs <case-id> <answer-file>` checks the configured grouped patterns. After widening several patterns that rejected equivalent wording, all ten groups pass against the final skill answers in both contexts. All ten groups reject an empty answer. The checks are intentionally a guardrail alongside the human-read expectation grades, not a substitute for them.

## Verification notes

`pnpm skills:check` passed after the final skill edits: 29 skills well formed and 8/8 built-in role skills satisfy the ADR 586 shape. An attempted `pnpm --filter @musterd/cli build` could not complete on this branch because existing type errors reference `spend_approval_usd` in `packages/cli/src/commands/report.ts` and `team.ts`; this is recorded separately from the eval result and must be rechecked after rebasing onto current `main`.

The focused role-skills test passed (9/9). The full CLI suite reported 4,089 passing tests and two failures: one OpenCode ordering failure passed when isolated, and one Grok configuration failure reproduced in an unchanged test. `pnpm lint` passed after correcting this lane's import order (13 existing warnings remain). `pnpm typecheck` stopped at `dist:check` because sibling build artifacts are stale; it did not reach type checking. `pnpm format:check` passed Prettier and its other reached checks, then stopped because the shallow checkout lacked a resolvable `origin/main` ledger base. The branch history has since been deepened and rebased; rerun the required fast gates on the rebased tree. These observations are checkpoint notes, not claims that current-main verification has passed.
