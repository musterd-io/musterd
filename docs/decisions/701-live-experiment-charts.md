# 701 — Experiment charts are live: today's point is computed on read

- Status: accepted
- Date: 2026-10-21
- Lane: `01M5G8NKG45EZA7K68JADBGCNV` (follow-on)
- Deciders: nick (in chat, 2026-10-21: "i want it to be live, not daily"), ryder
- Relates to: [ADR 673](673-experiment-results.md) (lane metric, daily samples, derived sources),
  [ADR 644](644-lane-reads-on-and-read-verdict.md) (the Experiments panel), hard rules 1, 4 and 6

## Context

ADR 673 gave an experiment lane a declared metric and one sample per day. The daemon writes
yesterday's value for its two derived sources (`wake_latency_p50_ms`, `dispute_rate`) five minutes
after midnight, and the /live and /broadcast Experiments panel draws the series as a sparkline.

On 2026-10-21 no lane on the board carried a metric. Two things kept the charts empty. The MCP tool
could not name a derived source (fixed in #3147), and nothing told whoever opened a dated read that
a chart was one field away. nick then asked for the charts to be live, not daily. There was also a
third gap: the one experiment about wake cost compares tools, but the daemon's wake latency is a
team-wide median.

## Problem

1. How does a chart move during the day without storing more than one sample per lane per day?
2. How does the panel learn of a change when no lane changed? The board refetches only on lane
   events, and a dispute or a wake usually changes no lane.
3. How does a wake-latency metric speak for one tool?
4. How does a dated read get a metric when the person opening it doesn't know it can have one?

## Decision

1. **History stays one sample per day; today's point is live.** A derived source is measured over
   today so far, from the read-status zone's midnight to now, by the same function the sweep runs
   for a whole day. It is computed on read and never stored. At the day's end the sweep writes the
   full day as before. A manual metric's live point is today's stored sample, and posting again
   replaces it (ADR 673), so "live" for a manual metric means posting when the number changes.

2. **A light endpoint carries the live points.** `GET /teams/:slug/experiments/live` returns
   `{samples: [{lane, day, value, n, as_of}]}` (`LiveSamplesSchema`), one point per open metric lane
   that has one today. It returns numbers only, so every reader of the board may read it. The daemon
   reuses a team's points for `LIVE_SAMPLES_POLL_MS` (30 s), however many viewers ask, and drops
   them when a sample is posted.

3. **The panel polls only when it has something to move.** `useLiveSamples` reads the endpoint every
   30 seconds while some open read has a metric and the tab is visible, and stops when it is hidden
   (the web package's rule that idle cost is paid by every viewer). `withLivePoints` replaces today's
   stored row with the live point, or appends it. The sparkline ends on a dot that breathes, with
   `now` beside the number. Under reduced motion the dot stays and the breathing stops.

4. **A metric may name one harness.** `MetricInputSchema.harness` scopes a derived source to the
   seats enrolled on that harness (`residency.harness`). Only `wake_latency_p50_ms` reads it, so a
   per-tool comparison is one metric lane per tool. The MCP tool carries it as a plain string, and
   the CLI carries it as `--metric-harness`.

5. **A dated read with no metric is nudged, in the same words everywhere.** Protocol's `metricNudge`
   is appended to every MCP lane result and printed by `musterd lane open` / `update` when a lane has
   `reads_on` but no metric and is not read or closed. It names the shape (a tool form and a CLI
   form) and the sample command. Any team's experiments get it; nothing here is specific to this
   repo.

## Consequences

- No new store and no new dependency. The endpoint's cost is one derivation per source per team per
  30 seconds, and only while someone is looking.
- The protocol gains `LiveSampleSchema`, `LiveSamplesSchema`, `LIVE_SAMPLES_POLL_MS`, `metricNudge`
  and an optional `harness` on a metric. All are additive. A daemon without the endpoint answers 404,
  and the panel keeps its daily chart.
- The tools list grows by 28 B for `harness`, with its falsifier in `docs/perf/context-budgets.json`.
- A live point is what the day looks like so far, so it can move a lot in the morning. The tooltip
  says "today so far, as of <time>", and the stored daily series is the record.

## Observability & Evaluation

**Traces.** The endpoint writes nothing. A posted sample keeps ADR 673's `lane.sample_recorded`
row.

**Eval.** `sweepMetricSamples.test.ts` covers today-so-far for a derived source, today's row for a
manual one, a harness-scoped wake metric counting only that harness's seats (the sweep honouring the
same scope), the 30-second reuse, and no point on a quiet day. `integration.http.test.ts` covers the
endpoint returning a posted point immediately. `experimentReads.test.ts` covers merging live points
into series. `lanes.live.test.ts` and the CLI test cover the nudge and `--metric-harness`.

**Experiment.** The falsifier for the nudge is adoption: of lanes given a `reads_on` in the 14 days
after this lands, the share that carry a metric. Before this ADR, 0 of 6. If it stays under a third,
the nudge is not doing its job and the declaration belongs in the open flow itself.
