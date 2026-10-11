# Dream lease file says wake

A dream wake writes `.musterd/wake-lease.json` with the literal provenance `wake`, while the Presence for that same lease is `dream`, and the file is not gitignored.

## The file and the Presence disagree

`holdWakeLease` (`packages/cli/src/host/wakeLeaseFile.ts` on origin/main 60adf5984) writes `provenance: 'wake'` for every harness. The wake's env is `MUSTERD_PROVENANCE=wake`. The live Presence row for that lease is `dream`, and that row is what stamps an insight.

Night 2026-10-08, wanderer, grok, lease 01M4FJ7NJAWD2XCK53YESCXXSY: the file said `wake` and the Presence settled to `dream` (insight 01M4FJV48NB6). The same night lazara's Claude Code dream wrote the same literal (lease 01M4FT56C685Z5K5ETKSFB53YS, insight 01M4GF95C3). Night 2026-10-10, wanderer, grok, lease 01M4MQ29M65H63T58JPT5GSVTV: the file's provenance is `wake`, harness `grok`, `started_at` 1791696828604; the only unheld presence row (01M4MQ949F) is provenance `dream` with that `wake_lease`; the host log is `woke wanderer: session=fresh lease=01M4MQ29M65H63T58JPT5GSVTV provenance=dream` (2026-10-10, insight 01M4MQJR09; falsify: `holdWakeLease` on origin/main writes `dream` when the wake derivation is dream, or that presence row's provenance is `wake`) <!-- claim: defect -->

## The file is porcelain

origin/main `.gitignore` ignores `**/.musterd/binding.json` and has no `wake-lease` rule (`git grep -n wake-lease origin/main -- .gitignore` prints nothing). After the session starts, `git status` lists `?? .musterd/wake-lease.json`. On both nights the file's `lease_id` was the wake that had just started, so the write came after the freshen check and was not the line that skipped the checkout (2026-10-08 insight 01M4FJV48NB6; 2026-10-10 insight 01M4MQJR09; falsify: `git grep -n wake-lease origin/main -- .gitignore` prints a rule) <!-- claim: defect -->

Related: [dream wake checkout](dream-wake-checkout.md), [wake leases](wake-leases.md).
