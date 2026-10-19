# 673 — A dated read can declare a metric, and its verdict carries the number

- Status: accepted
- Date: 2026-10-19

## Context

[ADR 644](644-lane-reads-on-and-read-verdict.md) gave a lane a read day (`reads_on`) and a
one-word verdict (`met` / `missed` / `inconclusive`) with a 280-character note. The Experiments
panel on `/live` and the stream shows that word. On 2026-10-19 nick asked for "a small visual/graph
of what the experiment data is showing so far", and whether a verdict should only ever be one word.
The answer was agreed in chat and written up as
[the experiment-results spec](../superpowers/specs/2026-10-19-experiment-results-design.md): keep
the word as the headline, add the number, surface the note, link the evidence.

## Problem

A result is a number against a prediction, and no lane carries a number. The readouts that would
feed a chart live in local research scripts or one-window report snapshots, and no field ties any
of them to a lane. So a `met` says nothing about by how much, and the panel has nothing to draw.

## Decision

1. **A dated read may declare a metric.** `Lane.metric` is `{name, unit, baseline, target,
   direction, source, by, at}`. It rides `lane_open` and `lane_update` (`null` clears it) the way
   `reads_on` does. The daemon stamps `by` from the authenticated writer and `at` from its clock. A
   metric needs `reads_on`, and one without it is refused (`validation`): a number with no verdict
   day is a dashboard, not an experiment. It is a separate field from ADR 645's `pre_registered`,
   which is refused on risky and user-facing lanes, where a metric must still be possible.
   Changing `target` or `direction` is allowed and audited (`lane.metric_changed`, before and
   after), so a moved goalpost is on the record. On the read side `source` is a plain string, so a
   source a newer daemon knows never fails an older board parse. On input it is
   `METRIC_SOURCES` (`manual`, `wake_latency_p50_ms`, `dispute_rate`).
2. **Daily samples.** `POST /teams/:slug/lanes/:id/samples` takes `{day, value, n}`. Any
   authenticated member of the team may post. The request is refused (`validation`) when the lane
   has no metric, and with 409 when the lane is `done` or `abandoned`. There is one row per lane per
   day in `lane_samples (lane_id, day)`, and a later write for the same day replaces the earlier
   one. Each write is one `lane.sample_recorded` audit row carrying the new value and the one it
   replaced. That row is also how a sample reaches the hub from a joiner, through the sync fold.
   `Lane.samples` carries the newest `LANE_SAMPLES_SERVED` (60) days, oldest first, and only when
   the lane has a metric. `brief=1` keeps them, because they are the chart's whole input.
3. **The verdict carries the number.** `ReadVerdictInput` gains optional `measured {value, n}` and
   `evidence` (≤ 200 characters: a URL, or a repo path / ADR ref, never followed). On a lane with a
   metric, `met` and `missed` without `measured` are refused (`validation`, naming the metric).
   `inconclusive` never needs it. The word keeps its meaning. The number is how, not whether.
4. **The server derives nothing from samples.** There is no status and no automatic verdict, and
   ADR 644's `read_status` rules are untouched.

## Consequences

- The panel (lane `01M5B1ZM80`) draws a sparkline from `samples` and prints
  `met · 61% (target 40%, n 23)` beside the word. A lane with no metric looks exactly as it does
  today.
- Lane `01M5B1Z5RR` adds the daemon's own daily samples for the two non-manual sources.
- All the new fields are optional on the wire. A client from before this change ignores them, and
  an older daemon drops `metric` on open. No feature epoch.
- New table `lane_samples`, in `musterd.db` beside `lanes`.

## Observability & Evaluation

**Traces.** `lane.metric_changed` and `lane.sample_recorded` audit rows. A verdict's `measured`
and `evidence` ride the existing `lane.read_recorded` row.

**Eval.** Store, transport and protocol tests: a metric without `reads_on` is refused, a sample
replaces its day and records what it replaced, samples are served oldest first and capped, `met`
without `measured` on a metric lane is refused, and a sample folded from a joiner lands on the
hub. The spec's §10 acceptance list is the end-to-end check once the panel lands.

**Experiment.** n/a. This is the substrate experiments record into, not one.
