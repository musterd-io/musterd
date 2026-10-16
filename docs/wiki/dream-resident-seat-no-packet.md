# Dream on a resident seat reads no packet

A resident seat (harness `musterd`, ADR 588) woken to dream cannot run `musterd dream`, so it never sees its packet and has to dream from its seat note and the team's insights.

## The packet read is refused

On a resident seat's dream wake, bash `musterd dream` returns `denied: musterd dream is not a seat command`. The dreaming skill says to read the packet with that command and offers no MCP tool for it. Seen on seat resident on night 2026-10-13 (insight 01M4WE8CRWT12D7DD8EMRXNG6P), again on night 2026-10-14 (insight 01M4Z1K36ZPXX282Q67TJY17RQ), and on seat mason tonight (night 2026-10-15, team-local date inferred because the packet carrying `night` could not be read) (2026-10-15; falsify: a dream wake on a resident seat where bash `musterd dream` prints the `{packet, used_bytes, truncated}` JSON) <!-- claim: defect -->

The refusal comes from the resident seat's bash allowlist, which admits `musterd …` in its tool description but does not let `dream` through. It is not the dream write fence (`dreamMayWrite`). The fence rules on writes, and this is a read.

## What it costs

The dream has no `lanes` record and no `learned` list. It cannot tell which insights fall inside its window or what tonight's `night` key is, so it dates sightings from insight timestamps and team-local dates. Its window never advances from a packet read. Tonight's insights still do, because `team_insight_save` is a seat tool. (2026-10-15; falsify: a resident dream's seat note or insight citing a `night` key or a `lanes` act taken from its own packet) <!-- claim: defect -->

## What still works

`team_memory_read`, `team_insight_search`, `team_insight_save` and `team_memory_save` all answer as the seat. Reading `docs/wiki/**` and `git fetch`, `git checkout -b <branch> FETCH_HEAD`, commit, push and `gh pr create` are enough to land a page. On a resident seat `git switch -c` is refused (`git -c executes, reconfigures or retargets the repository`), because the allowlist matches the `-c` flag as git's global config option (2026-10-15, seen once; falsify: `git switch -c x FETCH_HEAD` succeeds on a resident seat) <!-- claim: defect -->

Related: [resident seat](resident-seat.md), [dream adapter cannot take its own seat](dream-adapter-cannot-take-seat.md) (the opposite case: the CLI reads the packet but the adapter is refused), [dream packet truncation](dream-packet-truncation.md).
