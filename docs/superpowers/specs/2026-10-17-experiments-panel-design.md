# Experiments on /live and /broadcast: the team's dated reads, where everyone can see them

**Date:** 2026-10-17
**Seat:** slippy (designer)
**Status:** source and placement agreed with nick in chat on 2026-10-17. Alfie confirmed the §5
strings on 2026-10-17 (ask `01M55WR8AR9E74MYWW9RR65X41`). Increment 2 (the web section) built
2026-10-17 in `packages/web/src/live/Experiments.tsx` + `experimentReads.ts`. Increment 3 (the
corkboard pins) built 2026-10-17 in `office-scene/render.ts` + `wallboard.ts`.
**Lane:** `01M55KZF5M41HBR7CWSC5PHFHD` (goal `launch`), asked by nick
**Decision:** [ADR 644](../../decisions/644-lane-reads-on-and-read-verdict.md): a lane declares
`reads_on`, its close gives `read_verdict`, and the server derives `read_status`

## 1. What this is for

The team runs dated experiments: a claim, the day it is read, and what would prove it wrong. Today
the date sits in a lane title, so a read that slips past its day is noticed only if someone happens
to remember. The Experiments section puts every dated read next to the team. It shows what is being
read, the day, and where it stands, so an overdue read is seen by everyone in the room and everyone
on the stream.

**Success:** someone glancing at `/live` or `/broadcast` can say, without clicking, which read is
overdue, which is due today, and what the last verdict was.

**Non-goals**

- Not a place to run or record the experiment. A verdict is given on the lane (ADR 644 §2).
- No reminder, ask or wake. Overdue is shown, never acted on (ADR 644 §5).
- Wiki "Revisit" lines do not appear unless someone opens a lane with `reads_on` for them.

## 2. Source

Only lanes that carry `reads_on` appear, read from the `LaneBoard` that `TeamColumn` is already
given. Status is the server's `read_status`. The web never computes it from dates, so the board,
the CLI and both routes agree at midnight.

Which entries are included:

| `read_status` | Shown | Order inside the group |
| --- | --- | --- |
| `overdue` | always | oldest `reads_on` first |
| `due` | always | by title |
| `waiting` | always | soonest `reads_on` first |
| `read` | for 7 days after `read_verdict.at` | newest verdict first |
| `dropped` | never | — |

The groups appear in that order: overdue, due, waiting, read.

## 3. Placement

A section at the foot of `TeamColumn`, under the team cards, on both routes. `/broadcast` already
renders `TeamColumn` with `still`, so one component serves both. It is set off from the cards by a
hairline (`--lc-border`), not a box: rows, not cards (the column's own rule, Live.css "slop tell 4").

The office corkboard gets one pin per entry in increment 3 (lane `01M55WK0N2`). The pins show status
only; this section is their text equivalent.

## 4. Anatomy

```
EXPERIMENTS   1 overdue · 1 due                  ← head: .lc-team__title + .lc-team__count
──────────────────────────────────────────
◆ overdue · 2 days            Wed 10-21          ← line 1: mark, status, date
  Wake-rail trigger binds                         ← line 2: lane title, ≤2 lines
  ghost                                           ← line 3: owner (muted)
──────────────────────────────────────────
● due today                   Mon 10-20
  Up-next ranking beats oldest-first
  stanley
──────────────────────────────────────────
○ in 16 days                  Mon 11-02
  Accountability dogfood read
  nick
──────────────────────────────────────────
✓ met                         Sat 10-17
  …title…
  stanley · "14-day readout: ranked list beat baseline on 9 of 12"   ← verdict note, 1 line
```

_(Amended 2026-10-17, slippy, lane `01M56P1JDY`: nick found the rows below "extremely bare", so the
section was redrawn to the anatomy here.)_

- **Calendar leaf.** Each read's date is a leaf torn off a desk calendar, tacked up the way the
  corkboard's read tags are: a month band over the day in the casual cut, 24px wide, with the
  weekday in its tooltip. The band is accent ink for overdue, ink for due, muted for waiting and
  pale for read. Leaves sit a hair off true. An overdue leaf has slipped on its tack, as its tag has
  on the corkboard. A verdict is a small seal on the leaf's corner: a slashed ring for missed, a
  filled ring for met, a dashed ring for inconclusive. _(Amended 2026-10-18, slippy, lane
  `01M57WJFBV`: nick found the first leaves took "too much real estate"; the leaf shrank from 38px,
  the weekday band became the month band, the worded stamp became the seal, and rows, strip and
  type tightened, so four reads take about 40% less height.)_
- **Fortnight strip.** Under the head, a strip runs from today to fourteen days out, with weekends
  shaded and overdue reads in a gutter before today. Each read is a paper token at its day carrying
  its §4 mark. It is decorative: every fact on it is in the rows. On `/live`, hovering a token lights
  its row and hovering a row lights its token.
- **Row.** The leaf, then a short title (the lane title without its repeated date or its
  instructions; the full title stays in the label), then the owner's avatar in their roster colour,
  their seat and the status phrase.
- **Motion, all of it once.** Rows rise in, staggered, on mount; the strip's tokens drift in toward
  today; a leaf turns over when its read changes status; a hovered leaf straightens and lifts.
  Nothing moves under reduced motion.

The rest of this section describes the first cut:

- **Head.** Title in `.lc-team__title` style. The count names only the urgent statuses ("1 overdue ·
  1 due") and falls back to "3 reads" when nothing is urgent.
- **Line 1.** The mark and the status phrase on the left. On the right is the date in the mono cut,
  weekday plus `MM-DD` (`Mon 10-20`): a stream viewer reads a weekday faster than a year. Size 12 px,
  matching `.lc-team__count`.
- **Line 2.** The lane title, 14 px in the column's card-name style, clamped to 2 lines.
- **Line 3.** Muted 12 px: the owner seat. On a `read` entry it is followed by the verdict note,
  clamped to 1 line (the full note is in the `title` attribute on `/live` only).
- **Row padding** matches `.lc-team-card`. Rows are divided by the same hairline.

### Marks: shape first, color second

Status never rides on color alone (WCAG 1.4.1). Every row says its status in words, and the marks
differ by shape:

| Status | Mark | Mark color | Status text color |
| --- | --- | --- | --- |
| overdue | ◆ filled diamond | `--lc-accent-ink` `#715104` (4.60:1 worst case) | `--lc-accent-ink` |
| due | ● filled circle | `--lc-text` | `--lc-text`, weight 600 |
| waiting | ○ hollow circle | `--lc-muted` | `--lc-muted` |
| read | ✓ check | `--lc-muted` | `--lc-text` for the outcome word |

Overdue is the only accent in the section. `--lc-accent` (`#B8860B`) is 2.66:1 on the column ground,
so it fails the 3:1 floor for marks; the mark uses the ink shade. A `missed` verdict gets no red. The
word carries it, and a red verdict would read as an error on the stream when it is a result.

Marks are inline SVG at 10 px in a 12 px box, never font glyphs (glyph fallback varies by machine,
and the broadcast capturer has no emoji font).

## 5. Copy

| Where | String |
| --- | --- |
| Section title | `Experiments` |
| Count, urgent | `{n} overdue` · `{n} due`, only the statuses above 0, joined with ` · ` |
| Count, nothing urgent | `1 read`; `{n} reads` |
| overdue | `overdue · 1 day`; `overdue · {n} days` |
| due | `due today` |
| waiting | `tomorrow` when the day is next; `in {n} days` from 2 — _(amended 2026-10-19, lane `01M5AXHFZT`: the row shows a live countdown to the read day's start in the team zone instead — `2d 14h 05m` · `14h 05m` · `05m`; `due` reads `today · 9h 12m left`; `overdue` reads `overdue · 2d 04h` / `overdue · 4h 12m`; the screen-reader label keeps the day phrases; nick: "a countdown clock to make it more exciting for the viewer")_ |
| read | `met` · `missed` · `inconclusive` — _(amended 2026-10-19, lane `01M5B1ZM80`, [experiment results](2026-10-19-experiment-results-design.md) §6: a read whose verdict carries `measured` reads `{word} · {value}{unit} (target {target}{unit}, n {n})`; a lane with a `metric` and two or more `samples` draws a 60×16 sparkline at the row's right — baseline rule, dashed target rule, the latest value as the only number, ink only until `read`; the note is shown rather than hidden in a tooltip: its first sentence on the stream, and on `/live` a click opens the whole note in place; an `evidence` web address is a small link on `/live`)_ |
| Empty, `/live` only | `No dated reads. Open a lane with --reads-on to add one.` |
| More, `/live` | `Show all {n}` / `Show fewer` |
| More, `/broadcast` | `+{n} more on the board` |
| Row label (screen readers) | `{title}, {status phrase}, reads {weekday, month day}, owner {seat}` |

Confirmed 2026-10-17 by alfie, answering ask `01M55WR8AR9E74MYWW9RR65X41`. The count noun is
`reads` (`1 read`). The section title stays `Experiments`. The count uses the same noun as
`reads_on` and the empty line. On `/live` and on the stream the outcome word is the verdict's
own word, one word each: `met`, `missed`, `inconclusive` (ADR 644 decision 2).

**The title is the question, in plain words.** The row shows the lane's title to everyone in the
room and on the stream, most of whom have never read an ADR. Title a dated-read lane as what it
finds out ("Does ranking Up next help agents pick their work?"), never by its record ("ADR 536
14-day read"), and put the steps, commands and ADR numbers in its detail. _(Added 2026-10-18,
slippy, lane `01M58J0TZM`: nick found the rows said "ADR 324" and "nobody knows what ADR 324 is".
The three lanes then carrying `reads_on` were retitled as questions, their old titles kept at the
head of their detail.)_

## 6. Increment 3, for reference: the corkboard

One pin per entry, in the same order, on the back-right corkboard. Overdue pins use the accent and
the rest are neutral, with shape matching §4 where a pin's size allows. At most 8 pins; past that,
the eighth is a "+" card. The idle bake (`office-scene/index.ts`) re-renders only when the set of
`(lane, read_status)` pairs changes, never per frame. The scene's text equivalent points at this
section. It is a separate lane because it has to pass `scene:pixel-check` and the scene budget.

_(Amended 2026-10-17, slippy, building it: the board's six columns fill the cork, so the pins hang on
a strip of their own. The board grew 14 units downward, its top edge and columns unmoved, and an oak
rail divides the strip from the columns. Each read is a small paper tag on a tack, left to right.
Overdue is an amber tag on an accent tack that has slipped crooked on its pin; due has a dark tack;
waiting is the plainest paper with a pale tack; read carries a tick. Past 8, the eighth tag carries a
"+". The board is a live wall fixture, painted every frame outside the sprite cache, so the pins add
no bake.)_

## 7. Behavior

- **Cap.** Five rows on both routes. Overdue and due rows are never hidden by the cap. If more than
  five are urgent, all of them show, and the cap applies to waiting and read. `/live` gets a
  `Show all` toggle (a real `<button>`, 24 px minimum target). `/broadcast` prints the `+{n} more`
  line.
- **`/live` rows are links** to `/board?lane=<id>` (the acceptance deep link, ADR 200 §3), each a
  single focusable element with a visible focus ring above the column's sticky head. `/broadcast`
  rows are not interactive (`still`).
- **Collapsed column.** The overdue count, when it is above 0, rides under the rail cap as the
  overdue mark and the number, with `1 overdue read` as its label and title. _(Amended 2026-10-17,
  slippy, building it: the rail's `hint` pill sits in a 56 px column and cannot hold
  `2 working · 1 overdue` in words.)_
- **Motion.** When a row changes status (a verdict lands, or midnight moves a read to `due`), its
  ground flashes once to `--lc-surface` and back over `--lc-dur-4` / `--lc-ease-out`. A new order is
  applied with no slide, because rows sliding on the stream read as noise. Under reduced motion,
  nothing moves. Nothing loops. _(Amended 2026-10-19, lane `01M5AXHFZT`: the countdowns tick once a
  minute, on the wall minute, on `/live` and the stream alike — one text node per row, paused while
  the tab is hidden, and still ticking under reduced motion, because a clock is information rather
  than motion. That is not a loop in this section's sense; nothing animates.)_

## 8. States

| State | `/live` | `/broadcast` |
| --- | --- | --- |
| Loading (`board` null) | Section absent; the column's card placeholders already show loading | Absent |
| Empty (no `reads_on` anywhere) | Head plus the one empty line in §5 | Section hidden: dead air on the stream says nothing |
| Error / unreadable board | Follows the column: absent, the column's own notice speaks | Absent |
| Stale (`stale`) | Rows dimmed by dimming the marks only, never the words (local rule 2026-08-13) | Same |
| Long title | 2-line clamp, full title in the link's accessible name | 2-line clamp |
| Long note | 1-line clamp, full note in `title` | 1-line clamp |
| Many reads | §7 cap | §7 cap |
| Server behind ADR 644 | No lane has `reads_on`, so it reads as Empty | Hidden |

## 9. Checks before it ships (increment 2)

- Captures at 1920×1080 (`/broadcast`), 1280×720 and 390×844 (`/live`), in both themes and with
  reduced motion, after hydration and fonts, on a fixture team carrying one read in each status.
- `pnpm a11y:check` (contrast on painted pixels), `pnpm a11y:targets:check` (the toggle and the
  rows), `pnpm tokens:check`.
- `pnpm build && pnpm perf:check`. The section is plain DOM, no new font, no image. A value import
  of `@musterd/protocol` would pull zod onto the eager graph, so import types only.
- A render test in `TeamColumn.render.test.ts`: group order, the cap that never hides urgent rows,
  the empty and hidden states, and the absence of `read_status` computation in the web.
