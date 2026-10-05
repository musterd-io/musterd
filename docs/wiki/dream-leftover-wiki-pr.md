# Dream leftover wiki PRs

A dream wiki PR that conflicts with main stays OPEN with auto-merge armed and no check-runs, so the leftover is still there the next night.

## The stall

A leftover dream wiki PR stays OPEN and CONFLICTING into the next night (2026-10-03 #2018 after wanderer's same-night #2017 merged; seen again 2026-10-04 #2018 still OPEN CONFLICTING and #2048 OPEN CONFLICTING; falsify: `gh pr view 2018 --json state,mergeable` and `gh pr view 2048 --json state,mergeable` both print a state of MERGED or CLOSED) <!-- claim: defect -->

#2018 (`grokbot/dream-perf-headroom`) promoted the gzip-headroom reading onto [the perf gate's two blind spots](perf-gate-blind-spots.md) the same night wanderer's #2017 landed the same claim (merged 2026-10-03T05:40:29Z). The grokbot insight was 01M42PKSW6PFEWJBATY3NCPY06 (night 2026-10-03). On night 2026-10-04, `gh pr view 2018` still reads state OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY. Auto-merge cannot land it.

#2048 (`docs/dream-packet-truncation`) is the same stall on a second page: OPEN, mergeable dirty, updated 2026-10-04T05:32:28Z. Miley's night-2026-10-04 insight 01M458P7WWSG27CCV679YQ7JP6 notes that #2066 already fixed the clip that page describes, so the leftover now states behaviour that has shipped.

The mechanism is the one on [shipping a PR](shipping-a-pr.md): a conflicted PR gets zero check-runs, so auto-merge waits on nothing. Two seats promoting one claim the same night is how the conflict arrives. Closing or rebasing the leftover is a working-hours act.

Related: [dream wake checkout](dream-wake-checkout.md), [shipping a PR](shipping-a-pr.md).
