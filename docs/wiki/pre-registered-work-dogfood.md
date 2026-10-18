# Pre-registered work dogfood (ADR 645 inc 6)

The two dated reads on the board were released and declared pre-registered on 2026-10-17 so a host takes them unprompted; this page is the setup, the falsifiers and the readout.

## What is being tested

ADR 645 says a lane whose opener declared `pre_registered` (run, verdict rule, record, expected spend) may be taken by an enrolled host without a person starting it: the host's service seat announces it to the opener as an ask, the hub watches the window, and on silence the host claims it as one of its enrolled seats with `pick.via = 'pull'`. The dogfood asks whether that happens on this team without nick starting anything by hand, and what the record shows afterwards.

## Setup (2026-10-17, lane `01M55PDR9ZPQH55GF0S38K9B69`)

| lane | read | `reads_on` | opener | declared by |
| --- | --- | --- | --- | --- |
| `01M49HHJQF96W6W0QHR4KM2G7C` | ADR 536 14-day read: `pnpm next:readout --since 2026-10-06` | 2026-10-20 | lazara | lazara (asked 2026-10-17, request `01M56P60HN`) |
| `01M3TB1GPMMH2VKFJ2V97CSP9P` | ADR 436 Decision 5 trigger read: `pnpm wake:rail` | 2026-10-21 | izzo | izzo (asked 2026-10-17, request `01M56P68CA`) |

- Both lanes were claimed by stanley and are now released (`lane_release`, 2026-10-17 23:41 UTC), so each is open and unowned: `pullEligible` withholds a dated read until its `reads_on` day (ADR 644 and ADR 645 share one clock), then offers it.
- Only the opener or an admin may declare a lane pre-registered (ADR 645 Decision 1), so the declarations were requested of the openers with the exact `lane_update` text rather than stamped by stanley. The verdict rules are the ones the two ADRs already fix: ADR 536's MET / NOT MET / INSUFFICIENT on n ≥ 5 offered claims, and ADR 436 Decision 5's two clauses (a backend unpriceable from its own artifact, or a median floor over 3× Claude Code's).
- Each declaration says `expected_spend: 2` (USD). The team's `pull.spend_cap_usd` is the shipped default 0, so both announcements go out as **standard** asks (5 min window), not advisory (3 min). That is the policy working as declared, not a setup mistake: nothing on this team has set a cap yet.
- Hosts that can take them: the seats enrolled on `macbook-air-2.lan` on 2026-10-17 were ryder, sloane (claude-code), resident and mason (musterd engine). Both lanes carry `role: null`, so any of them fits. The Air's wake actuator must be on a build at or past #2827 (`e53871fe9`, the pull) for its tick to poll `/residency/pull` at all; the auto-refresher restarts the actuator with the daemon, so this holds once the Air has refreshed past that commit.
- The Air's actuator may still be on a pre-pull build when the first read comes due (2026-10-17; falsify: a `residency.host_seen` row from `macbook-air-2` on 2026-10-20 with no `residency.pull_offered` row for `01M49HHJQF` that day — then the Air polled without the pull and the dogfood measured nothing). <!-- claim: other -->

## How to read it

The audit log is admin-only from a seat, so nick runs these (or a seat with the human credential):

```
musterd audit --limit 500 --json | jq '[.[] | select(.action | test("^(residency\\.pull_offered|residency\\.pull_claimed|lane\\.pulled|lane\\.pull_declined|lane\\.pull_released)$"))]'
musterd lanes --json | jq '[.[] | select(.id=="01M49HHJQF96W6W0QHR4KM2G7C" or .id=="01M3TB1GPMMH2VKFJ2V97CSP9P") | {id, state, owner_seat, read_status, read_verdict, merged}]'
```

The ADR 645 eval, per lane:

1. **Taken unprompted?** `lane.pulled {lane, seat, host, ask}` exists, and the claim's `lane.claimed` row carries `pick.via = 'pull'`. If a person claimed it instead, the record shows `pick.via` `terminal` or `live` and the dogfood says so.
2. **Stopped inside the window?** `lane.pull_declined {reason}` names what stopped it: a steer or decline from the opener, a competing claim, or a lane change.
3. **Accepted?** The lane's `lane_submit` carried `read_verdict` and an acceptor closed it `done`; compare against the team's acceptance rate for human-started lanes of the same `change_class` (`docs` here).
4. **Released?** `lane.pull_released` means the host died on it (3 expired leases or 2 h absent) and the lane went back to open.

## Readout

_Pending: the reads are due 2026-10-20 and 2026-10-21. The table fills on 2026-10-22 or when both lanes have closed, whichever is first._

| lane | announced (host, tier, at) | window outcome | claimed by (seat, host) | nick started it by hand? | verdict recorded | accepted |
| --- | --- | --- | --- | --- | --- | --- |
| `01M49HHJQF` | | | | | | |
| `01M3TB1GPM` | | | | | | |

Share taken unprompted: _n/2_. Stopped inside the window: _n_. Released on a dead host: _n_. Acceptance rate of pulled lanes vs human-started `docs` lanes over the same days: _pending_.

ADR 645's falsifier on the declaration class needs 30 pulls; these two are the first rows, not the verdict.

## Related

- [ADR 645 — pre-registered work](../decisions/645-pre-registered-work.md), [ADR 644 — reads_on and read_verdict](../decisions/644-lane-reads-on-and-read-verdict.md).
- The two reads' own pages: [up-next relevance](up-next-relevance.md), [resume bound is below one wake life](resume-bound-is-below-one-wake-life.md).
