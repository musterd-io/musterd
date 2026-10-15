# 610 — CI runs are sampled into the ledger and the report shows the trend

- Status: accepted
- Date: 2026-10-15
- Deciders: nick ("sounds good, go ahead", 2026-10-15, on the three transfers from Anthropic's
  source-control write-up)
- Lane: `01M50GDXG8Q8G4ZBKTYDXWAA53`
- Builds on: ADR 584 (one measured row per event, percentiles derived in the report, never an
  aggregate table), ADR 232 (platform services act as ledger seats — the sampler runs as
  `autorefresh`), ADR 542 (the hourly ci-probe LaunchAgent this rides), ADR 508 (`main-red`: the
  scheduled full check opens an issue when main is red), ADR 051 (shapes only, never content)
- Snapshot-debt: none — the frequency word in §Decision ("flaky", decision 4) defines what the
  instrument counts, not a rate observed; the rates it yields are the watch, read weekly into
  `docs/wiki/ci-trend.md` per §Observability.
- Protocol change: yes (hard rule 1) — `CiRunBatchSchema` on a new `POST /telemetry/ci-runs`, and
  `Report.ci` (`CiTrendSchema`), optional for back-compat.

## Context

CI is observed one run at a time. `gates` passes or fails a PR; `main-red` opens an issue when a
scheduled full check on main fails (ADR 508); the ci-probe LaunchAgent dispatches that check hourly
(ADR 542). Nothing reads the series. On 2026-10-15 the question "are our CI times drifting" was
answered by hand with `gh run list` piped through `awk`: 24 runs on main, 1.4–3.2 minutes, median
about 2, one outlier at 5.3. That reading lives in a chat message and nowhere else.

Anthropic's account of replacing git at 30,000 merges a day (2026-10) has one idea that transfers
to a repo three orders of magnitude smaller: a long-running watcher on one component's telemetry
that notices drift a fixed alert never fires on. `main-red` is the fixed alert. This is the watcher.

## Problem

A fixed alert sees one red run. It does not see a p90 that crept from 2 to 4 minutes over a
fortnight, a flake rate that doubled, or three reds in a week where the month before had none —
each of which is a change in the system that nobody is told about until it costs someone an
afternoon. The data exists on the forge and ages out of `gh run list` in weeks.

## Decision

1. **Completed CI runs are sampled into the ledger.** `musterd ci sample` reads completed runs of
   `ci.yml` through `gh` — run id, head SHA, branch, event, attempt, conclusion, wall clock, and
   per-job conclusions and durations; never a log line or a PR body — and posts them to
   `POST /teams/:slug/telemetry/ci-runs`. The daemon writes one append-only `ci.run_measured` row
   per forge run id (`recordCiRuns`, `store/ci.ts`); a run seen twice writes nothing, so a tick may
   resend. The route is leaseless and presence-neutral like the trace tap: a LaunchAgent tick never
   flips the roster.
2. **The ci-probe tick does the sampling.** `scripts/ci/main-probe.sh dispatch` runs the sampler
   after dispatching the probe, as the `autorefresh` service seat (the token the auto-refresher's own
   tick uses, ADR 232), best-effort: a sampling failure is one log line, never a failed probe. The
   sampler keeps a high-water mark under `~/.musterd/ci-trend/`; `--full` ignores it.
3. **The report shows the trend, not a number.** `deriveCiTrend` projects the last 7 days beside
   the 7 before them (`Report.ci`): completed main runs with nearest-rank p50/p90, `main-red` count
   (main runs that concluded `failure`), distinct PR head SHAs and how many were flaky, and per-job
   p50s slowest first. Buckets are the run's own creation time (`detail.created_at`), not the
   sampling time, so a sampler catching up after a laptop sleep does not pile a day into an hour.
4. **Flake is defined narrowly.** A PR head SHA is flaky when a run on it concluded `failure` and a
   later run on the same SHA concluded `success`, or a `success` run carries `attempt > 1`. A SHA
   that only ever failed is a real failure; a SHA fixed by a new commit is a different SHA; a
   cancelled run (a superseded push) is neither red nor green and enters no count.
5. **Three renderings, one shape.** `musterd report ci` in full; one headline line in `musterd
   report` and in `team_report`, arrowed against the previous window (↑ / ↓ / → at ±10%), shown only
   once anything has been sampled.

## Consequences

- `Report` gains `ci`; the ledger gains `ci.run_measured` (replicated like the other measured rows
  so a joiner's report agrees with the hub's). No aggregate table: the rows are the distribution.
- The sampler depends on `gh` being on the tick's PATH and logged in — the same dependency the probe
  already has, so nothing new fails on a machine where the probe works.
- Per-run forge reads cost one `gh run view` each; the high-water mark keeps a steady-state tick to
  the hour's handful. The first `--full` sample reads 200 runs.
- Not in this ADR: an automated revert when main goes red (the article's other half). That waits
  until this trend has shown how often `main-red` actually fires and what a revert would need.
  Follows-up: none.

- _(2026-10-15, same day, PR #2662.)_ The commit review found three gaps in the first landing and
  they are closed: the route refuses agent seats (a service seat or a human writes the team's CI
  history, nobody else); `run_id`, `head_sha`, `event` and `conclusion` are validated as forge tokens
  and names as printable ASCII, so nothing a terminal could interpret enters the ledger; the renderer
  strips job names again rather than trust the wire.

## Observability & Evaluation

- Traces: `ci.run_measured` rows (actor `autorefresh`), the sampler's line in
  `~/.musterd/ci-probe.log` each hour (`N completed runs read · a new · s already recorded`), and
  `Report.ci.sampled_through`. Falsifier: a `sampled_through` more than 2 hours old while the probe
  log shows ticks — the sampler is failing silently.
- Eval: `packages/server/src/store/ci.test.ts` — dedupe by run id; bucketing by the run's own time
  into two windows; p50/p90, red, flake (red-then-green and attempt > 1 count, red-only and cancelled
  do not), job p50s; empty-not-absent before the first sample.
- Experiment: on revive, read `musterd report ci` weekly for a month and write the four numbers
  (main p50, p90, red, flake rate) into `docs/wiki/ci-trend.md`. The watcher earns its keep the
  first time a week-over-week arrow points at something a human then fixes.
