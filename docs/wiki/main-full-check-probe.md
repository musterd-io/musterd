# Main's full-check probe

Main's full check (both drivers, coverage, a11y) is started by three triggers — a push, GitHub's hourly cron, and an hourly dispatch from the daemon host — and CI's pick step alone decides whether a probe runs it or skips.

## Why there are two hourly probes (2026-10-07; falsify: `gh run list -w ci.yml -e schedule` over a day that shows a run near every :17) <!-- claim: defect -->

GitHub's `17 * * * *` cron (ADR 535) went live 2026-10-06 18:41Z. In the next 22 hourly slots it fired 3 times: 23:03Z, 02:23Z and 10:15Z. The older 4-hourly cron had dropped 3 of 6 the day before. GitHub documents that scheduled runs can be delayed or dropped under load, so [ADR 542](../decisions/542-hourly-probe-dispatched-from-daemon-host.md) adds a `workflow_dispatch` with `probe: true` from this laptop at :47 every hour. Neither trigger replaces the other.

## How to tell what a run did

The `gates` job summary prints one `plan:` line. A probe that skipped reads `plan: suite=false … — probe: no code moved since the last full check …`. A probe that ran reads `full=true`. A dispatch WITHOUT `probe` always runs the full check (ADR 535 item 3) — that is the manual override, not the probe.

## Operating the LaunchAgent

- Install or reinstall from the daemon's checkout, which the auto-refresher keeps on main: `sh ~/.musterd/runtime/scripts/ci/main-probe.sh install`. `uninstall` removes it; no argument dispatches one probe now.
- Label `studio.sandrise.musterd-ci-probe`; log `~/.musterd/ci-probe.log`, one line per dispatch (`dispatched probe` or `dispatch FAILED: <gh's error>`).
- It needs `gh` logged in on this machine (it uses the keyring login). A `dispatch FAILED` line naming auth means `gh auth login`.
- A slot missed while the laptop slept fires once on wake (launchd's `StartCalendarInterval`). While the laptop is off, the cron is the only probe, which is exactly the pre-ADR-542 state. Every seat that merges code runs on this laptop, too.

## Related

- [When CI never starts](ci-not-running.md) — when nothing runs at all, the provider is the suspect, not the trigger.
- [Shipping a PR](shipping-a-pr.md) — the per-PR gate; this page is main's post-merge check.
