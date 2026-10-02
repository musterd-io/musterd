# Shipping a PR

One enforced git loop (ADR 106): branch from fresh origin/main → PR → `gh pr merge --squash --auto --delete-branch` → sync by rebase + `--force-with-lease`, never merge — plus the two traps that stall or pollute it.

## The loop (ADR 106, enforced by branch protection since 2026-07-07, with a gap on 2026-10-02 — below)

Branch `feat/`|`fix/`|`docs/` from fresh `origin/main`; commits are throwaway (squash-merge). Fast local smoke only — CI is the authority. `gh pr create` → `gh pr merge --squash --auto --delete-branch`, walk away. Sync a stale branch by `git rebase origin/main` + `git push --force-with-lease`; never `merge main`, never bare `--force`. Required checks on main: ~~`gates` + `Cursor Bugbot`~~ `gates` only since ADR 180 (corrected 2026-10-02); linear history; squash-only.

## Protection vanishes when the repo goes private on a Free org, and does not come back by itself (2026-10-02; falsify: `gh api repos/SandRiseStudio/musterd/branches/main/protection --jq .required_status_checks.contexts` prints `["gates"]`, and no merged PR's `mergedAt` is earlier than its head's `gates` check-run `completed_at`) <!-- claim: defect -->

On 2026-10-02 nick made the repo private to keep it that way while the platform matures. The `SandRiseStudio` org was on GitHub Free, which offers branch protection and rulesets only for public repos. Both APIs then answered 403 "Upgrade to GitHub Pro or make this repository public". With no required check, `gh pr merge --auto` does not wait: it merges at once. #1957 (17:43Z) and #1961 (18:21Z) merged before their `gates` finished. Both went green afterwards. Every sampled merge from #1500 (09-16) to #1954 (10-02 00:22Z) came seconds after `gates`, so the lapse began between 00:22Z and 17:43Z.

Upgrading the org to Team (nick, ~19:00Z) did **not** restore the old rules: `branches/main/protection` answered 404 "Branch not protected" and `rulesets` was `[]`. izzo re-applied them through the API at about 19:00Z, exactly as ADR 106 §2 and ADR 180 set them: `gates` required with `strict: false`, a PR required with 0 approvals, linear history, no force-push, no deletion, and `enforce_admins: false`. Checked right after: a PR with a failed `gates` (#1958) and one with `gates` still running (#1962) both read `BLOCKED`. The sign to watch for is a PR that merges within a minute of `gh pr merge --auto`, before its `gates` run has finished.

## `--auto` on an already-green PR is a merge, not a wait (2026-10-01, #1937; falsify: `gh api repos/SandRiseStudio/musterd/commits/7d3fe3c6/check-runs` shows a `gates` run that completed after #1937 merged at 21:11:25Z) <!-- claim: other -->

`gh pr merge --auto` waits only for required checks that have not passed yet. If `gates` is already green on the head commit, the PR merges at once. That is a problem when the green head is a verification commit you meant to drop. On #1937, fifty pushed `TEMP: force sqlite in coverage to check the floors (revert before merge)` to measure the coverage floors on a SQLite-only run. `gates` passed on it at 21:10:06Z. The PR left draft at 21:11:21Z and merged 4 seconds later, with the TEMP lines in the squash. For the next 11 minutes, every PR and every `main` push ran SQLite only, until #1940 removed the lines.

Remove or revert the verification commit and push **before** `gh pr ready` and `gh pr merge --auto`, so the run that auto-merge waits for is on the head you mean to land. If the PR is already armed, run `gh pr merge --disable-auto` before you push a verification commit. The symptom is the same as the protection lapse above: a merge within seconds of `--auto`. The cause is different. Here the required check exists and has already passed.

## Waiting for "merged" never sees a red CI (2026-09-21, nick's observation, lane 01M32Z1PD9; falsify: arm the state-only waiter below on a PR whose `gates` is red — it must exit within one poll; if it runs to its timeout, the trap holds) <!-- claim: defect -->

After `gh pr merge --auto`, a seat arms a background waiter (or a Monitor) on `gh pr view --json state` and waits for it to leave `OPEN`. **A failed required check never changes the state.** The PR stays `OPEN`, auto-merge stays armed, the waiter runs to its timeout in silence, and the seat sits. PR #1630: the `static` leaf failed on two `import/order` errors at 21:31; izzo's waiter said nothing and the failure was learned at 21:45 because nick asked "landed?". nick had seen the same shape on other seats.

The waiter has to exit on **either** terminal state and say which:

```sh
until s=$(gh pr view $N --json state,mergeCommit -q '"\(.state) \(.mergeCommit.oid // "")"') \
      && { [ "${s%% *}" != "OPEN" ] || gh pr checks $N | grep -qE '^gates\s+fail'; }; do sleep 45; done
echo "PR$N $s"; gh pr checks $N | grep -E '^gates|fail'
```

`gates` is the required check and fails when any leaf fails, so it is the one name to watch; the second line prints the leaf that actually went red. A push after the fix restarts the run — re-arm the waiter, it is not re-armed for you.

Related trap, same PR: the fast local gates were `typecheck && format:check`, and neither runs `eslint` — CI's `static` leaf does. A lint-only failure is therefore invisible before the push and surfaces only in the leaf the state-waiter does not watch. `pnpm lint` is now in the fast gates (AGENTS.md step 3); it costs ~25 s.

## Declare the lane in the squash body, in the first five lines

Open the PR body (which becomes the squash body) with `Lane \`01M2XXXXXX\`.` — the short id, on its own line, near the top — or put `(lane 01M2XXXXXX)` in the title. This is what `team_next` reads back to tell a seat its carried lane already landed ([memory outlives the merge](memory-outlives-the-merge.md)). A mention mid-sentence ("declining lane 01M2…") or deep in the body is deliberately not counted, so a PR that never declares its lane (#1474 did not) is invisible to that check once its branch is cleared (2026-09-19).

## A PR's review count is not this team's review record

Seat reviews are musterd acts, so a fully-reviewed PR routinely shows **0 reviews and 0 comments** on GitHub. Do not read an empty forge as an unreviewed PR, and post substantive reviews to both stores with each pointing at the other — see [the ledger and the forge](ledger-and-forge.md).

## Bugbot no-show (2026-07-08, PR #170, intermittent; falsify: check-runs list on a stalled PR) <!-- claim: defect -->

Cursor Bugbot can silently never register its check-run (2026-07-08, PR #170; intermittent — #167 minutes earlier ran normally): `gates` green for 20+ minutes while auto-merge waits on a check that does not exist, and nothing alerts. If a PR sits OPEN with `gates` SUCCESS and no `Cursor Bugbot` entry in `gh api repos/…/commits/<sha>/check-runs`, comment `bugbot run` on the PR — it registers and completes within ~90s (neutral conclusion = clean, auto-merge fires).

## A conflicted PR gets ZERO check-runs (2026-08-13, PR #793; falsify: open a PR with a conflict and list its check-runs) <!-- claim: defect -->

GitHub never creates the pull_request CI run for an unmergeable (mergeStateStatus DIRTY) PR, so auto-merge waits on nothing forever — the same stalled-OPEN symptom as the Bugbot no-show but a different cause and fix. Diagnose with `gh pr view --json mergeStateStatus`; fix by rebasing onto origin/main + `--force-with-lease`, not by `bugbot run`. Corollary: branching from a stale or sibling branch invites this — branch from `origin/main` explicitly (`git checkout -b <name> origin/main`); `git checkout main` fails silently useless in a worktree checkout where another worktree holds main.

## After the merge, the branch you are standing on lies (2026-08-13; falsify: `git status -sb` in a worktree after an auto-merge landed) <!-- claim: defect -->

`--delete-branch` removes the remote, so the local branch is left tracking a `[gone]` upstream. `git pull` there fails outright (`no such ref was fetched`) — loud, and therefore harmless. The dangerous half is quiet: **every command that reads the working tree instead of a ref keeps answering, from a snapshot of main that stopped moving when you merged.** It bit a measurement script the same day, which counted the wiki off a post-merge worktree and reported 24 pages / 52,849 B / 8 commits against `origin/main`'s real 25 / 59,384 / 10 — understating a teammate's contribution threefold.

Anything that measures or reports on the repo should name the ref: `git fetch origin` first, then `git ls-tree origin/main <path>` and `git log origin/main`, never `ls`/`cat`/`git log` over the checked-out tree. To resume work, branch afresh (`git checkout -b <name> origin/main`) rather than pulling.

## Branch cleanup is repo-wide, and tidying up is what removes the guard (2026-08-13; falsify: `git worktree list`, then try `git branch -D` on a branch another worktree holds) <!-- claim: other -->

Every seat worktree shares one `.git`, so `refs/heads` is common — 19 worktrees on this machine, and from any one of them `git branch` lists, and can delete, every other seat's branches. "I pruned my branches" is always "I pruned the team's branches."

Git's only guard is narrow: it refuses to delete a branch **currently checked out** in another worktree (`error: cannot delete branch 'x' used by worktree at …`), even under `-D`. That guard disappears exactly when a seat tidies up — detaching at `origin/main` at wrap-up, the recommended finish, leaves that seat's branches unprotected. Meanwhile squash-merge makes `-d` refuse on work that HAS landed (the tip is never an ancestor of main), so cleanup reaches for `-D`, which asks nothing.

Prune by name, never by sweep: delete only branches you own and have verified landed — PR state `MERGED`, or `git cherry origin/main <branch>` marking every commit `-`. A neighbour's unmerged branch with no remote looks identical to your own dead one.

## ~~Never `pnpm format`~~ FIXED 2026-08-19 by #890 — the writer's scope now equals the checker's

~~`pnpm format` writes `**/*.{ts,js,mjs,json,md}` but `format:check` only checks `packages/**/*.ts`, `tests/**/*.ts`, `*.{ts,json}` — the committed markdown/json was never prettier-conformant, so `pnpm format` reflows ~100 unrelated docs, burying the real change and breaking `roadmap:check` (glob misalignment verified still present 2026-08-13).~~

ADR 284 removed the asymmetry rather than documenting around it: both modes are now `node scripts/format.ts`, reading one scope list from `scripts/format-scope.ts`, with `.prettierignore` backstopping `docs/` and `scripts/` joining the checked set. `pnpm format` on a clean tree changes 0 files (2026-08-19; falsify: from a clean `origin/main`, `pnpm format && git status --porcelain` — any output revives the struck claim above). <!-- claim: other -->

The old workaround — `pnpm exec prettier --write <files>` on your own files only — is no longer necessary, and stays safe if you prefer it.

## Ordering landmine

Same-millisecond `ts` collisions are real; any new ts-only ordering or dedup is nondeterministic. Always order by `(ts, id)`.
