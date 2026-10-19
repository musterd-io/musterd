# Experiment results: keep the word, add the number, surface the note, link the evidence

**Date:** 2026-10-19
**Seat:** miley
**Status:** design agreed with nick in chat on 2026-10-19 ("agree"). This document is the written form.
Nothing is built.
**Lanes:** `01M5B1YQVH25MWWANZZN6H1M95` (ADR + protocol + daemon), `01M5B1Z5RR0CNP8G1XA07JDKFW`
(the daemon's own daily samples), `01M5B1ZM809JRJP4PQVV671ZMT` (the panel). Goal `live-delight`.
**Builds on:** [ADR 644](../../decisions/644-lane-reads-on-and-read-verdict.md) (`reads_on`,
`read_verdict`, `read_status`), [ADR 645](../../decisions/645-pre-registered-work.md)
(`pre_registered`), the [experiments panel](2026-10-17-experiments-panel-design.md) and its
countdown (lane `01M5AXHFZT`).

## 1. What this is for

The Experiments section on `/live` and the stream shows every dated read: the question, the owner,
a countdown, and, once read, one word — `met`, `missed` or `inconclusive`. nick asked for two more
things: "a small visual/graph of what the experiment data is showing so far", and, stepping back,
whether a verdict should only ever be one word.

The answer we agreed: the word stays as the headline, because it is what a stranger on the stream
can take in at a glance and what makes reads comparable across the panel. But a result is a number
against a prediction, and today nothing numeric exists anywhere on a lane. The readouts that would
feed a chart (the up-next ranking hit rate, wake latency, dispute rate) live in local research
scripts or one-window report snapshots, and no field ties any of them to a lane. So:

1. a dated read **may declare a metric**: what is measured, in what unit, where it started and
   where it must get to;
2. **daily samples** are posted against it, by the owner's seat or by the daemon for the few
   metrics it already knows;
3. a `met` or `missed` verdict on a metric lane **carries its measured value**, and any verdict may
   **link its evidence**;
4. the panel draws a **small sparkline** from the samples and shows the number beside the word;
   the 280-character note is **shown, not hidden**.

**Success:** on the stream, a stranger reads `met · 61% (target 40%)` under a question and, below
it, a sparkline that climbed past a dashed line; on `/live`, one click opens the note that says
what was learned and a link to the readout. A lane with no metric looks exactly as it does today.

**Goals**

- Numbers come from a declaration and samples, never from a title, a detail, or a doc (ADR 530/536).
- The web never computes experiment math. It draws what the server serves.
- The panel stays honest: no metric, no chart; no samples, no line; no words from a chart before
  the verdict is in.

**Non-goals**

- Not a general metrics store. One number per lane per day, at most 60 served, is the whole shape.
- Not a fourth or fifth outcome word. "Partially met" is what the number and the note are for.
- Not a reminder or a wake (ADR 644 decision 5 stands).
- Not the research scripts' job to change: `pnpm next:readout` and friends stay as they are; a
  seat that runs one posts the day's sample.

**Anti-goals**

- A sparkline that implies a verdict before the rule allows one. The chart carries no words, no
  colour by outcome, until `read`.
- A verdict that says `met` with no number on a lane that declared one. The transport refuses it.

## 2. The metric (protocol, lane 1)

```ts
// packages/protocol/src/lanes.ts
export const METRIC_SOURCES = ['manual', 'wake_latency_p50_ms', 'dispute_rate'] as const;
export const LaneMetricSchema = z.object({
  name: z.string().min(1).max(80),          // "ranked pick hit rate"
  unit: z.string().min(1).max(24),          // "%", "ms", "per day", "count"
  baseline: z.number().nullable(),          // where it started; null when unknown
  target: z.number(),                       // where it must get to
  direction: z.enum(['up', 'down']),        // which way is better
  source: z.enum(METRIC_SOURCES).default('manual'),
  by: z.string().min(1).max(80),            // daemon-stamped from the authenticated writer
  at: z.number().int(),
});
export const OpenMetricSchema = LaneMetricSchema.omit({ by: true, at: true });
```

- `Lane.metric?: LaneMetric`. Rides `lane_open` / `musterd lane open --metric` and `lane_update`
  (`null` clears it), exactly as `reads_on` does (ADR 644 decision 1). It requires `reads_on`: a
  metric with no read day is refused (`validation`), because a number with no verdict day is a
  dashboard, not an experiment.
- It is a **separate field, not part of `pre_registered`.** ADR 645 refuses a pre-registration on
  any lane with a risk tag, with `user-facing`, or with `stakes: 'high'`; a dated read with a
  metric must be possible on exactly those lanes (every `/live` change is `user-facing`). The two
  may coexist on a lane; neither reads the other.
- Changing `target` or `direction` after a sample exists is allowed but audited
  (`lane.metric_changed`, both values), so a moved goalpost is on the record.

## 3. Samples (protocol + daemon, lane 1)

```ts
export const LaneSampleSchema = z.object({
  day: CalendarDateSchema,                  // YYYY-MM-DD in the team's calendar zone
  value: z.number(),
  n: z.number().int().min(0),               // how many observations the value summarises
  by: z.string().min(1).max(80),
  at: z.number().int(),
});
export const SampleInputSchema = LaneSampleSchema.omit({ by: true, at: true });
```

- `POST /teams/:slug/lanes/:id/samples` with `SampleInput`. Any authenticated member of the team
  may post (the owner usually will; the daemon's sweep posts as its service seat). Refused with
  `validation` when the lane has no `metric`, and with `409` when the lane is `done` or `abandoned`.
- **One row per lane per day.** A later write for the same day replaces the earlier one; each write
  is one `lane.sample_recorded` audit row carrying both the new and the replaced value. The table
  is `lane_samples (lane_id, day, value, n, by, at)` with `(lane_id, day)` unique.
- **Served with the lane:** `Lane.samples?: LaneSample[]`, the newest 60 days ascending, present
  only when `metric` is. `brief=1` keeps it (it is the chart's whole input and small); a sample is
  five scalars.
- CLI / MCP: `musterd lane sample <id> --day 2026-10-19 --value 0.61 --n 23` and `lane_sample`.
  `--day` defaults to yesterday in the team zone, because a day's number is known the morning after.

## 4. The daemon's own samples (lane 2)

Two metrics the daemon can already compute from its tables get a `source` the sweep understands:

| `source`              | Value for a day                                                  | `n`                  |
| --------------------- | ---------------------------------------------------------------- | -------------------- |
| `wake_latency_p50_ms` | p50 of wake latency over that day (`WakeMetrics`)                | wakes that day       |
| `dispute_rate`        | disputes ÷ acceptances that day (`DisputeReadout`, ADR 505)      | acceptances that day |

Once a day, a few minutes after the team-zone midnight (after `read_status` has flipped for the
day), the daemon writes yesterday's sample for every **open** metric lane whose `source` is not
`manual`, through the same store path as the endpoint, as its service seat. Idempotent: rerunning a
day replaces that day's row. A metric whose source the build does not know is left alone and
logged once. No new table, no new loop beyond the existing daily sweep.

This is what makes the chart real on day one for the two reads already on the panel that ask about
wakes and disputes.

## 5. The verdict (protocol, lane 1)

```ts
export const ReadVerdictInputSchema = z.object({
  outcome: z.enum(READ_OUTCOMES),
  note: z.string().min(1).max(READ_NOTE_MAX_CHARS),
  measured: z.object({ value: z.number(), n: z.number().int().min(0) }).optional(),
  evidence: z.string().min(1).max(200).optional(), // a URL, or a repo path / ADR ref
});
```

- On a lane **with** a metric, `met` and `missed` **require `measured`**; the transport refuses
  without it (`validation`: "this lane measures <name>: give measured"). `inconclusive` does not
  require it (the honest answer when the number never came).
- On a lane **without** a metric, `measured` is accepted and shown if given.
- `evidence` is a pointer, not a claim: a URL, a repo path (`scripts/research/next-readout.ts`),
  or an ADR ref (`ADR-536 §Consequences 2026-10-20`). Nothing validates where it points beyond
  length; the panel renders it as a link only when it parses as a URL.
- The word's meaning does not change: `met` is the verdict rule satisfied, `missed` is not,
  `inconclusive` is the rule unanswerable. The number is **how**, not **whether**.

## 6. The panel (web, lane 3)

Anatomy of a row, left to right, on both routes:

```
[leaf]  Does ranking Up next help agents pick their work?         ▁▂▃▅▆█  61%
        ◯ ryder · met · 61% (target 40%, n 23)
        “Ranked picks were claimed within the hour 61% of the time…”     ↗ evidence
```

- **Sparkline.** For a lane with `metric` and ≥ 2 samples: a 60×16 px inline SVG at the row's right.
  The baseline (when known) is a faint rule, the target a dashed rule, the series one line, and the
  latest value the only number, in the metric's unit. The y-range is the min and max of
  {baseline, target, samples} with 10% headroom, so the target is always in frame. **No colour by
  outcome before `read`** (ink only); once read, the line takes the mark's ink shade and nothing
  else changes. A lane with no metric, or one sample, draws nothing. Reduced motion changes
  nothing (there is no motion). Inline SVG, never a font glyph (spec §4's rule for marks).
- **The number beside the word.** A `read` row whose verdict carries `measured` reads
  `met · 61% (target 40%, n 23)`; without `measured`, the word alone, as today. Formatting: the
  unit's own convention (`%` → one decimal at most; `ms` → integer; else up to two significant
  decimals). The countdown (lane `01M5AXHFZT`) is unchanged for unread rows.
- **The note, shown.** On `/live` the row is a disclosure: clicking it opens the note in full under
  the meta line (the row stays a link to the board via its leaf). On the stream, where nothing is
  clickable, a `read` row shows the note's **first sentence** under the meta line, ellipsised at the
  row's width. Today's hover tooltip goes.
- **Evidence.** When `evidence` parses as a URL, a small link glyph after the note opens it in a new
  tab (`/live` only; the stream shows nothing, a link nobody can click is noise).
- **Copy table additions** (spec §5): `{word} · {value}{unit} (target {target}{unit}, n {n})`;
  screen-reader label gains `, measured {value}{unit} against {target}{unit}`.

## 7. Constraints the builder holds

- Hard rule 1: the protocol change needs the ADR in lane 1; `change-adr:check` needs that ADR file
  in the same diff as any `packages/protocol/src` change.
- Hard rule 4: every new input (`metric`, samples, `measured`, `evidence`) is parsed through the
  zod schemas at the transport.
- No new runtime dependency. The sparkline is hand-drawn SVG.
- ADR 151: the panel's bytes are measured and, if a raise is needed, logged in
  `docs/perf/web-live-baseline.md`.
- The server derives nothing from samples (no status, no auto-verdict). ADR 644 decision 4's
  `read_status` rules are untouched.
- Words: "metric", "sample", "measured", "evidence". Not "KPI", not "score".

## 8. What is left to the builder

- Whether `lane_samples` lives in `musterd.db` beside `lanes` (default) or gets its own ladder step.
- The exact daily sweep hook to hang lane 2 on (the digest's midnight job is the natural one).
- The sparkline's stroke width and the dash pattern for the target rule; tune on the dev preview.
- Whether the disclosure on `/live` remembers its open state across a board refetch (default: yes,
  keyed by lane id, in component state only).

## 9. Increments

| # | Lane                         | Owner | Needs | What lands |
| - | ---------------------------- | ----- | ----- | ---------- |
| 1 | `01M5B1YQVH25MWWANZZN6H1M95` | open (platform) | this spec | ADR; `LaneMetricSchema`, `LaneSampleSchema`, `measured` + `evidence` on the verdict; `lane_samples` table, `POST …/samples`, samples served on the lane; CLI/MCP verbs; SPEC and 01/03 docs |
| 2 | `01M5B1Z5RR0CNP8G1XA07JDKFW` | open (platform) | 1 | the daily sweep for `wake_latency_p50_ms` and `dispute_rate` |
| 3 | `01M5B1ZM809JRJP4PQVV671ZMT` | miley | 1 (2 to see data) | sparkline, number beside the word, note shown, evidence link; panel spec §4/§5 amended |

## 10. Acceptance

1. Open a read lane with `--metric "ranked pick hit rate" --unit % --baseline 40 --target 60 --direction up`;
   post three days of samples; `GET /lanes?brief=1` returns them in order; the panel draws a line
   with two rules and the latest value, and nothing else changes on the row.
2. Give `met` without `measured` on that lane → refused with the metric's name; give it with
   `measured` → the row reads `met · 61% (target 60%, n 23)` on `/live` and on the stream.
3. A lane with no metric: no chart, the word alone, exactly today's row.
4. The two daemon-sourced metrics have yesterday's sample the morning after lane 2 lands.
5. On the stream, a `read` row shows the note's first sentence; on `/live`, clicking the row opens
   the whole note and the evidence link works.
