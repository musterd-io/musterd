# Dream on a resident seat reads no packet

A resident seat (harness `musterd`, ADR 588) woken to dream cannot run `musterd dream`, so it never sees its packet and has to dream from its seat note and the team's insights.

## The packet read is refused

On a resident seat's dream wake, bash `musterd dream` returns `denied: musterd dream is not a seat command`. The dreaming skill says to read the packet with that command and offers no MCP tool for it. Seen on seat resident on night 2026-10-13 (insight 01M4WE8CRWT12D7DD8EMRXNG6P), again on night 2026-10-14 (insight 01M4Z1K36ZPXX282Q67TJY17RQ), on seat mason on night 2026-10-15, and on seat mason again on night 2026-10-19. Nights are team-local dates, inferred because the packet carrying `night` could not be read (2026-10-19; falsify: a dream wake on a resident seat where bash `musterd dream` prints the `{packet, used_bytes, truncated}` JSON) <!-- claim: defect -->

Seen again on seat delta-2, two dream wakes on night 2026-10-29 (insight 01M65MK06KHSKBXECF57JZH85Y). Same denial string. A new seat, not a new claim.

The refusal comes from the resident seat's bash allowlist, which admits `musterd …` in its tool description but does not let `dream` through. It is not the dream write fence (`dreamMayWrite`). The fence rules on writes, and this is a read.

## What it costs

The dream has no `lanes` record and no `learned` list. It cannot tell which insights fall inside its window or what tonight's `night` key is, so it dates sightings from insight timestamps and team-local dates. Its window never advances from a packet read. Tonight's insights still do, because `team_insight_save` is a seat tool. (2026-10-15; falsify: a resident dream's seat note or insight citing a `night` key or a `lanes` act taken from its own packet) <!-- claim: defect -->

## What still works

`team_memory_read`, `team_insight_search`, `team_insight_save` and `team_memory_save` all answer as the seat. Reading `docs/wiki/**` and `git fetch`, `git checkout -b <branch> FETCH_HEAD`, commit, push and `gh pr create` are enough to land a page. On a resident seat `git switch -c` is refused (`git -c executes, reconfigures or retargets the repository`), because the allowlist matches the `-c` flag as git's global config option (2026-10-15, seen once; falsify: `git switch -c x FETCH_HEAD` succeeds on a resident seat) <!-- claim: defect -->

## Git and gh can vanish on the resident host

On mason (resident, host macbook-air-2.lan) those git and gh commands fail, so a resident dream there cannot land a page. bash `gh pr view 2735` returned `/bin/sh: gh: command not found` (exit 127), and `git fetch origin main` failed with `xcode-select: error: unable to read data link at '/var/select/developer_dir' (Operation not permitted)` and `No developer tools were found and no install could be requested (possibly because there is no active GUI session)` (2026-10-20, seen again 2026-10-21; falsify: a resident dream on macbook-air-2.lan where `git fetch origin main` and `gh --version` both succeed) <!-- claim: defect -->

Seen night 2026-10-20 (insight 01M5EF13FSQEGQ7RJK0FHQKC7K) and again night 2026-10-21 (insight 01M5H1E11GRSMQ1AM8NXHR44A2). The night of 2026-10-19 the same `gh` command worked from that seat, so this is the launch environment on that host, not a missing install in the repo. Mason could not promote this itself: promoting needs git and gh. Wiki PR #2735, which mason could not re-check, had already merged 2026-10-20T05:33:24Z.

Related: [resident seat](resident-seat.md), [dream adapter cannot take its own seat](dream-adapter-cannot-take-seat.md) (the opposite case: the CLI reads the packet but the adapter is refused), [dream packet truncation](dream-packet-truncation.md).
