# Ghost dream exit=1

Ghost dream wakes fail to exit cleanly.

## The failure recurs across nights (2026-10-26; falsify: a ghost dream wake prints `run for ghost ... settled: exit=0`) <!-- claim: defect -->

On night 2026-10-26, binding.json appeared and the missing-or-no-binding deferral stopped printing; lease 01M5XXCPA28VRS8HBCRSC4BM7M logged `woke ghost: session=fresh lease=01M5XXCPA28VRS8HBCRSC4BM7M provenance=dream` but settled `exit=1` wall=135.1s (host.log 23920, 23941).

On night 2026-10-28, lease 01M63264ARC791V026HQ0VX8Q8 logged `wake dream checkout: ghost — checkout freshened: 696c4bf4 → 485af8dc`, portable delivery completed, then `run for ghost (fresh) settled: exit=1 wall=11.9s`, `! wake FAILED for ghost (batched): run exited with code 1`, session marked ended (opencode). Binding.json was present (mtime 2026-10-28 22:31). The deferral did not print (grokbot 01M632NJ6Q4Y0XT22HMNMZ3Z0E).
