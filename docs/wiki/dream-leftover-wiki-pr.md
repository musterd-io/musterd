# Dream leftover wiki PRs

A dream wiki PR that conflicts with main stays OPEN with auto-merge armed and no check-runs, so the leftover is still there the next night.

## The stall

A leftover dream wiki PR stays OPEN and CONFLICTING into the next night (2026-10-03 #2018 after wanderer's same-night #2017 merged; seen again 2026-10-04 #2018 still OPEN CONFLICTING and #2048 OPEN CONFLICTING; falsify: `gh pr view 2018 --json state,mergeable` and `gh pr view 2048 --json state,mergeable` both print a state of MERGED or CLOSED) <!-- claim: defect -->

#2018 (`grokbot/dream-perf-headroom`) promoted the gzip-headroom reading onto [the perf gate's two blind spots](perf-gate-blind-spots.md) the same night wanderer's #2017 landed the same claim (merged 2026-10-03T05:40:29Z). The grokbot insight was 01M42PKSW6PFEWJBATY3NCPY06 (night 2026-10-03). On night 2026-10-04, `gh pr view 2018` still reads state OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY. Auto-merge cannot land it. ~~On night 2026-10-04 #2018 remained an open conflicting leftover~~ CLOSED unmerged 2026-10-05T05:40:11Z; the #2018 instance of the stall has cleared (falsify: `gh pr view 2018 --json state` prints OPEN).

#2048 (`docs/dream-packet-truncation`) is the same stall on a second page: ~~OPEN, mergeable dirty, updated 2026-10-04T05:32:28Z~~ MERGED 2026-10-05T23:31:19Z; the #2048 instance of the stall has cleared (falsify: `gh pr view 2048 --json state` prints OPEN). Miley's night-2026-10-04 insight 01M458P7WWSG27CCV679YQ7JP6 notes that #2066 already fixed the clip that page describes, so the leftover now states behaviour that has shipped.

#2079 (`docs/dream-wake-checkout-freshen`) is the same stall on the next night: OPEN, mergeable CONFLICTING, auto-merge squash armed 2026-10-05T14:43:18Z, `statusCheckRollup` empty, still open at the 2026-10-05 wanderer dream (2026-10-05; falsify: `gh pr view 2079 --json state,mergeable` prints a state of MERGED or CLOSED) ~~still open~~ cleared 2026-10-08: rebased onto main with both nights' landings kept — the force-push did not disarm auto-merge, and the PR went MERGEABLE and merged the same evening once `gates` ran green — so its two claims main was missing (the freshen seen running, the packet carrying the skill) landed beside the sightings #2146/#2148 had already merged; the instance cleared by a rebase rather than a close <!-- claim: defect -->

~~The current instance is #2145~~ CLOSED unmerged 2026-10-13T01:39:59Z; the #2145 instance has cleared (falsify: `gh pr view 2145 --json state` prints OPEN). It was (`docs/dream-night-2026-10-05`, wanderer): OPEN, mergeable CONFLICTING, 91 commits behind main with a red `gates` run on its 2026-10-06 tree, auto-merge armed 2026-10-06T05:40:02Z. Its porcelain sightings and packet-skill section landed by other routes (#2146/#2148 and the 2026-10-08 rebase of #2079), and its [huddles](huddles.md) line was overtaken when `packages/whiteboard` re-entered the repo, so what remains unique is one byte-identical `skill.text` observation (2026-10-08; falsify: `gh pr view 2145 --json state,mergeable` prints a state of MERGED or CLOSED) <!-- claim: defect -->

The current instance is #2351 (`docs/dream-night-2026-10-11`, grokbot): OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY, auto-merge squash armed 2026-10-12T05:37:36Z, head last updated 2026-10-12T05:37:34Z. Seen on two nights: grokbot's insight 01M4WF61JJE47J37BBWK3GHE6S (night 2026-10-13, `gates` FAILURE on run 38208756452) and alfie's check on night 2026-10-14, unchanged (2026-10-14; falsify: `gh pr view 2351 --json state,mergeable` prints a state of MERGED or CLOSED) <!-- claim: defect -->

Still OPEN on 2026-10-17 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `gates` FAILURE on run 38208756452; `updatedAt` still 2026-10-12T05:37:34Z. `docs/dream-night-2026-10-15` never opened a PR (`gh pr list --head` empty) and left uncommitted wiki edits on that named branch (insight 01M56R9ZEJWYAVT2A7JMJ62K3E).

Still OPEN on 2026-10-18 wanderer: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z (falsify: `gh pr view 2351 --json state,mergeable` prints MERGED or CLOSED).

Still OPEN on 2026-10-19 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z.

Still OPEN on 2026-10-21 wanderer: `gh pr view 2351 --json state,mergeable,mergeStateStatus,autoMergeRequest,updatedAt` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z.

Still OPEN on 2026-10-22 wanderer: `gh pr view 2351 --json state,mergeable,mergeStateStatus,autoMergeRequest,updatedAt` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z.

Still OPEN on 2026-10-22 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z.

Still OPEN on 2026-10-23 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z (insight 01M5P6N940SBK459AAZB2TVWJ9).

Still OPEN on 2026-10-24 wanderer: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z (insight 01M5RS8ACQNQYWPS8787KK7QDJ).

Still OPEN on 2026-10-25 wanderer: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z.

Still OPEN on 2026-10-26 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z. Dolly's #3322, wanderer's #3323 and grokbot's #3324 all MERGED on 2026-10-26 morning and did not close it.

Still OPEN on 2026-10-28 grokbot: `gh pr view 2351 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-12T05:37:36Z; `updatedAt` still 2026-10-12T05:37:34Z. Alfie's #3539 MERGED 2026-10-29T05:34:23Z and did not close it.

#2863 (`docs/dream-skill-sibling-of-packet`, wanderer) is the two-seats-one-claim arrival again, on [dream wake checkout](dream-wake-checkout.md): OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY, auto-merge squash armed 2026-10-18T05:49:34Z, `statusCheckRollup` empty, `updatedAt` 2026-10-18T05:49:22Z. Wanderer promoted “skill is a sibling of packet” as #2863 (commit 12ca0811); grokbot promoted the same claim the same night as #2862, on origin/main as bb84e5bf7. Twenty-four hours later origin/main already carries the struck nested claim, and `git diff --stat origin/main...12ca0811` is two insertions and two deletions on that page (2026-10-18; insight 01M59AR97BH416H3EFMP4FRGX9; falsify: `gh pr view 2863 --json state,mergeable` prints MERGED or CLOSED) <!-- claim: defect -->

Still OPEN on 2026-10-19 izzo and grokbot: `gh pr view 2863 --json state,mergeable` prints OPEN, UNKNOWN; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z (insight 01M5BWN21K7KTWDN1MTA8SZ8YP). The claim already landed via #2862 / #2887; close, do not merge.

Still OPEN on 2026-10-21 wanderer: `gh pr view 2863 --json state,mergeable,autoMergeRequest,updatedAt` prints OPEN, UNKNOWN; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Closing remains a working-hours act.

Still OPEN on 2026-10-22 wanderer: `gh pr view 2863 --json state,mergeable,autoMergeRequest,updatedAt` prints OPEN, UNKNOWN; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Closing remains a working-hours act.

Still OPEN on 2026-10-22 grokbot: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Close, do not merge.

Still OPEN on 2026-10-23 grokbot: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z (insight 01M5P6N940SBK459AAZB2TVWJ9). Close, do not merge.

Still OPEN on 2026-10-24 wanderer: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Closing remains a working-hours act.

Still OPEN on 2026-10-25 wanderer: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Closing remains a working-hours act.

Still OPEN on 2026-10-26 grokbot: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Close, do not merge.

Still OPEN on 2026-10-28 grokbot: `gh pr view 2863 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-18T05:49:34Z; `updatedAt` still 2026-10-18T05:49:22Z. Close, do not merge.

#2860 (`dream/alfie-acceptance-2026-10-17`, alfie) is the same leftover shape on [acceptance-routing](acceptance-routing.md): OPEN a second night (izzo 01M59A9X2G night 2026-10-18, 01M5BWN21K night 2026-10-19). `gh pr view 2860 --json state,mergedAt,mergeable` on 2026-10-19 prints OPEN, null, UNKNOWN; auto-merge is not armed; `updatedAt` 2026-10-19T05:31:01Z. Until it lands, the hold-after-hop claim is not on origin/main's acceptance-routing.md. Land or rebase is a working-hours act (2026-10-19; falsify: `gh pr view 2860 --json state` prints MERGED or CLOSED) <!-- claim: defect -->

~~OPEN~~ CLOSED unmerged 2026-10-22T05:32:58Z (`mergedAt` null); the #2860 instance of the stall has cleared (2026-10-21 wanderer; falsify: `gh pr view 2860 --json state` prints OPEN) <!-- claim: defect -->

Origin/main already carries the hold-after-hop claim via #3180 (`06526f732`).

#3113 (`docs/dream-night-2026-10-20`, grokbot) is the same leftover shape: OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY, auto-merge squash armed 2026-10-21T05:44:22Z, `updatedAt` 2026-10-21T05:44:09Z. On night 2026-10-21 it was OPEN, MERGEABLE, BLOCKED — `docs` and `gates` FAILURE on run 39551242478 after ledger:check treated an in-place rewrite of a marked claim line on [dream on a resident seat](dream-resident-seat-no-packet.md) as a strike (insight 01M5H260J39HNKQM27BE51DERE). Tonight, after #3181 merged 2026-10-22T05:48:57Z overlapping leftover and resident wiki, it is CONFLICTING (2026-10-22; insight 01M5KM669N4JK171XCDAS2H96X; falsify: `gh pr view 3113 --json state,mergeable` prints MERGED or CLOSED) <!-- claim: defect -->

A dated note that keeps the original marked line passes; a dream cannot mint `docs/claims/entries` (the fence is `docs/wiki/**/*.md` only). Closing or rebasing #3113 is a working-hours act.

Still OPEN on 2026-10-23 grokbot: `gh pr view 3113 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-21T05:44:22Z; `updatedAt` still 2026-10-21T05:44:09Z (insight 01M5P6N940SBK459AAZB2TVWJ9).

Still OPEN on 2026-10-24 wanderer: `gh pr view 3113 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-21T05:44:22Z; `updatedAt` still 2026-10-21T05:44:09Z. Closing remains a working-hours act.

Still OPEN on 2026-10-25 wanderer: `gh pr view 3113 --json state,mergeable,mergeStateStatus` prints OPEN, CONFLICTING, DIRTY; auto-merge still armed at 2026-10-21T05:44:22Z; `updatedAt` still 2026-10-21T05:44:09Z. Closing remains a working-hours act.

Still OPEN on 2026-10-26 grokbot: `gh pr view 3113 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-21T05:44:22Z; `updatedAt` still 2026-10-21T05:44:09Z. Closing remains a working-hours act.

Still OPEN on 2026-10-28 grokbot: `gh pr view 3113 --json state,mergeable,mergeStateStatus` prints OPEN, UNKNOWN, UNKNOWN; auto-merge still armed at 2026-10-21T05:44:22Z; `updatedAt` still 2026-10-21T05:44:09Z. Closing remains a working-hours act.

#2588 (`docs/ghost-dream-acceptance-fast-verdict`, ghost) stalled one page over, on [acceptance-routing](acceptance-routing.md): OPEN, mergeable CONFLICTING from 2026-10-14T05:35:56Z, auto-merge never armed, after #2586–#2589 landed the same fast-verdict measurements it carried — the two-seats-one-claim arrival again. Its 2026-10-15 rebase found nothing main was missing (the claim had landed via #2586's sixty-second section, same ask/resolve timestamps), so it cleared by a close, not a rebase: ~~OPEN~~ CLOSED unmerged 2026-10-15, the page's second clear-by-close after #2018 (2026-10-15; falsify: `gh pr view 2588 --json state` prints OPEN) <!-- claim: defect -->

The mechanism is the one on [shipping a PR](shipping-a-pr.md): a conflicted PR gets zero check-runs, so auto-merge waits on nothing. Two seats promoting one claim the same night is how the conflict arrives. Closing or rebasing the leftover is a working-hours act — and the rebase is the whole fix for a stale base: the 2026-10-08 force-push of #2079 did not disarm its 2026-10-05T14:43:18Z arming, so no re-arm step exists, and the gates run on the new head (falsify: `gh pr view 2079 --json autoMergeRequest,statusCheckRollup` showing an `enabledAt` after the push, or a rebased leftover whose check-runs stayed empty).

## The leftover that never became a PR

A dream's wiki write can stop short of a PR and sit in the seat's workspace into the next night, where no PR check sees it (2026-10-18; falsify: `gh pr list --head docs/dream-night-2026-10-15 --state all` or `gh pr list --head docs/wiki-changed-since-read --state all` prints a PR) <!-- claim: defect -->

Two sightings. grokbot's 2026-10-15 appends to four `docs/wiki/` pages were still uncommitted on `docs/dream-night-2026-10-15` at its night-2026-10-17 dream, and `gh pr list --head docs/dream-night-2026-10-15 --state all` printed `[]` again on night 2026-10-18 (insight 01M56R9ZEJWYAVT2A7JMJ62K3E). sloane's night-2026-10-17 page `lane-write-changed-since-read.md` was committed as 12467c7a on local `docs/wiki-changed-since-read` but not pushed, because `pnpm wiki:index` and `pnpm wiki:check` came back "requires approval" with nobody there to approve. The same command was refused again on night 2026-10-18 (insight 01M56QXNVYDDRT69TG1SV581ZC). A new page needs `wiki:index` in its own commit, so on that harness a dream can append to a page but cannot land a new one. The open-PR stall above at least shows in `gh pr list`. This one shows only in the workspace: as the named branch that makes the wake checkout skip its freshen ([dream wake checkout](dream-wake-checkout.md)), or in the seat note. Pushing or discarding it is a working-hours job, and so is allowlisting `pnpm wiki:index`/`pnpm wiki:check` in the seat's harness settings.

Grokbot's four 2026-10-15 wiki appends later landed as #2862 (`docs/dream-night-2026-10-17`, merged 2026-10-18T05:48:57Z as bb84e5bf7) after that dream detached to origin/main and re-applied them; `gh pr list --head docs/dream-night-2026-10-15 --state all` is still `[]` because they never rode that branch. The same stop-short then recurred: night 2026-10-18 left uncommitted appends on `docs/dream-night-2026-10-18` (lease-stamp confirmation, #2351 still-OPEN / #2862 landing line, 2026-10-18 uncommitted-changes skip) with `gh pr list --head docs/dream-night-2026-10-18 --state all` empty at the night-2026-10-19 dream (insight 01M5BX2GAMSR2Y4GJ0TFQ324V8). #2351 is still OPEN on night 2026-10-19 grokbot (`updatedAt` 2026-10-12T05:37:34Z, auto-merge still armed at 2026-10-12T05:37:36Z).

Recurred on night 2026-10-22: HEAD was `docs/dream-night-2026-10-21-grokbot` at 06526f732 (#3180), tracking origin/main, 71 behind, with no unique commits and `gh pr list --head docs/dream-night-2026-10-21-grokbot --state all` empty. Porcelain had no uncommitted wiki files. The named branch alone skipped freshen.

Recurred on night 2026-10-24: HEAD was `docs/dream-night-2026-10-24-wanderer` at 8232b6451 with uncommitted edits to `docs/wiki/dream-leftover-wiki-pr.md` (Still OPEN 2026-10-23 grokbot and 2026-10-24 wanderer for leftover PRs #2351 #2863 #3113). `gh pr list --head docs/dream-night-2026-10-24-wanderer --state all` printed `[]`. Host log 23682 lease `01M5VB016WJ0JF3W68X403AMKV`: `wake dream checkout: wanderer — checkout left: on a branch`. Same leftover-never-became-a-PR shape as 01M56R9ZEJWYAVT2A7JMJ62K3E and 01M5BX2GAMSR2Y4GJ0TFQ324V8.

## A red ledger:check

A dream wiki PR that strikes or rewrites a line carrying `<!-- claim: -->` in place fails `pnpm ledger:check` (the `docs` and `gates` checks), so its armed auto-merge never fires. The PR passes only if its body or one of its commit messages carries `not-a-falsification: <why>` (2026-10-22; falsify: a wiki PR whose only change is an in-place edit of a marked claim line, with no `not-a-falsification:` line in its body or commits, and a green `ledger:check`) <!-- claim: defect -->

Two sightings. #3113 (grokbot, `docs/dream-night-2026-10-20`) added a fifth-night date inside the marked packet-refusal line of [dream resident seat](dream-resident-seat-no-packet.md). It was still OPEN and BLOCKED on night 2026-10-21 (insight 01M5H260J39HNKQM27BE51DERE), and DIRTY on night 2026-10-22. #3179 (dolly, `docs/dolly-dream-2026-10-21`) struck the enforcement-cache claim on [dream wake checkout](dream-wake-checkout.md) as `~~…~~ FIXED … by #3123` and edited a marked line on the resident page. Run 39728590524 printed `✗ … — claim struck or rewritten` for both pages. `scripts/check-ledger.ts` treats any edit to a line that was marked at the base as a falsification. The strike-and-date form that README rule 4 and the dreaming skill teach is exactly that kind of edit, and the strike asks for a `docs/claims/` entry, which is outside the dream fence.

The fence leaves a dream two ways through. It can leave the marked line verbatim and add a dated note after it, which is how #3179 was repaired on night 2026-10-22. Or, when the edit records a fix rather than proving the claim wrong, it can put `not-a-falsification: <why>` in a commit message. `ESCAPE_RE` reads PR bodies and commit messages alike, and a commit message rides the same PR as the wiki write.

Related: [dream wake checkout](dream-wake-checkout.md), [shipping a PR](shipping-a-pr.md).
