# PGlite double: session scope instead of per-statement stamping

- Date: 2026-10-01 · Lane `01M3W7909JVWZN6WT9CN39C1CC` · Branch `perf/pglite-session-scope`
- PGlite 0.5.8 · Node v22 · Apple M3, 8 GB, a laptop shared with other seats (load average noted per run)

## What changed

The PGlite test double (`packages/server/src/db/pgliteDriver.ts`) used to run every autocommit
statement as its own stamped transaction, as `pgDriver` does: BEGIN, `SET LOCAL ROLE`,
`set_config('app.team_id', …, true)`, the statement, COMMIT. That is five PGlite calls per statement.

Now the double holds the scope (role + tenant) at session level and switches it with one call only
when the next operation's scope differs. A steady-state autocommit statement is one PGlite call; a
`tx` is BEGIN … COMMIT with no stamp. One in-process lock serialises every depth-0 operation, so
nothing can run between a scope switch and the work it scopes. `pgDriver` (production) is unchanged
and still stamps `SET LOCAL` per transaction; its choreography is still exercised against the double
through `poolFactory()`, whose clients start from the owner scope so they inherit no tenant.

## Measurements

| Measure | Before | After | Load avg |
| --- | --- | --- | --- |
| Micro: one RLS-scoped `SELECT` by key, 2,000 iterations | 451 µs | 115 µs (3.9×) | 2.6 |
| Mixed store workload, interleaved A/B in one process, no coverage | 759 ms/round | 493 ms/round (1.54×) | 7–21 |
| Same, with v8 coverage on | 570 ms/round | 406 ms/round (1.40×) | 7–21 |

The mixed workload is 40 × (`insertMessage`, `listTeamMessages`, an operator `COUNT`, a two-statement
team `tx`), 320 statements per round on both drivers, 12 rounds alternating which driver runs first.
Old and new ran in the same process against two PGlite instances, so load swings hit both. The
interleaved ratio is the number to trust. Wall time for a whole test file on this laptop is not: one
`integration.test.ts` + `db/` run went from 83 s to 121 s while the load average climbed from 4.5 to
11.9 and vitest's own import time tripled.

The gap between the 3.9× micro and the 1.4–1.5× workload is the statements themselves: real store
statements cost more than a keyed `SELECT`, so the fixed per-statement overhead is a smaller share.

## What did not change

`integration.test.ts` keeps the 5 s `TestWs.waitFor` patience from #1922. It is a ceiling, not a cost:
a passing wait returns as soon as the frame arrives. The flakes it absorbed were CI and coverage load
on top of the per-statement overhead. This change removes about a third of that overhead; it does not
remove the load, so tightening the ceiling back to 1 s would bring the flakes back on a busy runner.

## Falsifier

If a CI coverage run of `integration.test.ts` on the PGlite leg is not shorter after this lands than
the 591 s of run 36901160719, the per-statement overhead was not what dominated under CI, and the next
place to look is PGlite cold start (1.0–1.4 s per instance) and the per-test TRUNCATE in `testing.ts`.
