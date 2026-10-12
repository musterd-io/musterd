# 517 — CI's `gates` job runs on Ubicloud's 2 vCPU runner

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (chose Ubicloud over a self-managed Hetzner box on 2026-10-05, created the account,
  set up billing and connected Ubicloud's GitHub App to the SandRise org), izzo (owns CI spend)
- Lane: `01M46QW1WHEYWKAGHT8H3Q7YZN` (shipped with ADR 515 in the same PR)
- Relates to: ADR 515 (CI is one job, so one `runs-on` line moves all of it), ADR 508/510/512

## Context

After ADR 508–515, CI is one job. It runs on GitHub-hosted `ubuntu-latest` (2 vCPU) at $0.006 a
minute. This week CI ran 856 times in 8 days. At post-ADR 515 run lengths that is about 640
runner-minutes a day, or about 19,000 a month: roughly $115 a month on GitHub-hosted runners.
On 2026-10-05 GitHub also had an Actions incident, "delays in assigning GitHub-hosted runners".
From about 19:30Z, jobs failed with "not acquired by Runner of type hosted", and CI was down for
every seat.

Two alternatives were weighed on 2026-10-05 against measured data.

- **A Hetzner box run by the infra seat.** A queue simulation replayed this week's real run arrival
  times through a box. With 2 runners, PRs waited a p90 of 17–27 minutes at peak (worst 43). With 3
  runners the p90 was 4–9 minutes. Three 2-vCPU runners need an 8-vCPU CX43, about €13–16 a month
  after Hetzner's June 2026 price increase (US CPX boxes rose to about $73). It is cheapest flat,
  but it queues past three jobs and needs patching, runner updates and cleanup between jobs.
- **Ubicloud managed runners.** $0.00125 a minute for 2 vCPU, with a $2.50 monthly credit: about
  $21 a month at our volume. Jobs run in parallel with no queue. Each job gets a fresh ephemeral VM.
  There is nothing to maintain, and switching is one label.

Break-even between the two is about 14,000 minutes a month. We are slightly above it, so Hetzner is
about $5 a month cheaper today, and Ubicloud wins on queueing, upkeep and isolation.

## Problem

CI costs about 5× what an equivalent runner costs elsewhere, and it depends on GitHub's own runner
assignment, which failed for hours on the day this was decided.

## Decision

1. **`gates` runs on `ubicloud-standard-2`**: 2 vCPU, the same size as `ubuntu-latest`, so the
   step timings and the two-worker vitest setting (#1985) carry over unchanged.
   _(Amended 2026-10-12: superseded by [ADR 569](569-ci-on-github-hosted-public.md) once the repo
   went public. See the amendment below.)_
2. **`main-red` stays on `ubuntu-latest`.** It runs only after a red scheduled run, costs a minute,
   and should not depend on the runner that may have just failed.
3. **Going back is one line**: set `runs-on` back to `ubuntu-latest`. Nothing else in the job
   depends on where it runs. If Ubicloud is down for long, that is the fix. It is not automatic.
4. `.github/actionlint.yaml` declares the Ubicloud labels so `actionlint` keeps passing.

## Consequences

- Expected CI spend: about $20–25 a month at this week's volume, down from about $115 on GitHub-
  hosted runners. It is still per-minute, so it grows with activity. At about twice today's volume,
  a self-managed Hetzner box becomes clearly cheaper. Re-weigh then, using Ubicloud's bill.
- GitHub's Actions spending limit no longer gates CI. Ubicloud bills its own account, so the next
  "spending limit" stop would come from Ubicloud's billing, not GitHub's.
- A third party now runs our CI. The job's only credential is the run's GitHub token
  (`contents: read`, `actions: read`). CI holds no deploy or cloud secrets.
- The Ubicloud GitHub App is connected to the whole SandRise org. Only workflows that ask for a
  Ubicloud label run there. Narrowing the app to this repo is optional hygiene.
- The first run must confirm that the image matches what the job assumes: Node via setup-node,
  Google Chrome at `/usr/bin/google-chrome` for the a11y steps, and `gh`/`jq` for the pick step.
- 2026-10-12 — **Superseded for `gates`.** The repo went public ([ADR 565](565-repo-public-musterd-io.md)),
  where GitHub-hosted runners are free and have 4 CPUs. [ADR 569](569-ci-on-github-hosted-public.md)
  moves `gates` back to `ubuntu-latest` and keeps this ADR's runner as the outage fallback.
  Decisions 2–4 stand. The weekly bill eval below ends.

## Observability & Evaluation

- **Traces:** none new. Ubicloud's console shows per-job usage. The `ubi` CLI can read usage once a
  token is provisioned (stored in the keychain, never in the repo).
- **Eval:** after one full week, compare Ubicloud's bill to the projection above (about $5–6 a week
  at this week's volume), and compare the median `gates` wall time to the same run kinds on
  `ubuntu-latest`. Pass: spend within 50% of the projection, and median wall time no worse than 20%
  above GitHub-hosted.
- **Experiment:** none. If spend runs past about $40 a month for two weeks running, re-run the
  Hetzner comparison (queue simulation plus box cost) with the new volume.
