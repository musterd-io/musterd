# 770 — The daily view's waiting count lands on the directed acts

- Status: accepted
- Date: 2026-10-30

## Context

The daily view (`musterd status`) leads with `⚑ N waiting on you` and points at `musterd inbox`
(`packages/cli/src/render/rows.ts`, the `waiting` section). That count is the directed slice:
acts addressed to this seat, or to an eligible set containing it, that wait for its answer.

`musterd inbox` opens something else: a recent window plus every unread, oldest first, all
senders and audiences together (ADR 752's read model). Measured live on 2026-10-30 (designer
pass, lane `01M61VTWD`): 21 directed acts buried in 493 unread, starting with yesterday's
@team lane chatter. The count and the landing disagree, so the daily view's first promise —
what waits on you — is the one the next command breaks.

ADR 752 settled the read semantics this decision must not disturb: a read advances the cursor
past exactly the unread rows it showed (ADR 117's guarantee), `--peek` is the non-consuming
form, and a filtered or named read never consumes the unread window.

## Problem

Make the arrow true: following `musterd inbox` from the waiting count must land on the acts
the count counted, without changing what a read consumes, what `--json` returns, or any
existing flag's contract.

## Decision

`musterd inbox` (text form, no filter flags) leads with a directed section before the general
list:

- The section header is `⚑ waiting on you — N` — the daily view's glyph, in its accent —
  where N is computed by the same projection the daily view's waiting count uses, over the
  same window. One query, two surfaces: the number in `status` and the number at the top of
  `inbox` cannot drift apart.
- The section shows exactly the rows that projection returns, whether read or unread, in the
  same `message-row` rendering and the same newest-last order as the general list. A read row
  in it is shown but consumes nothing new, since the ADR 117 cursor only moves past unread
  rows. A row shown in the section is not repeated in the general list below it (dedupe by
  act id).
- Everything below the section is today's inbox, unchanged: same window, same grouping, same
  rows.
- Read semantics are untouched. The section's rows are shown rows, so an ordinary read
  consumes them exactly as ADR 752/117 already specify; `--peek` consumes nothing; filtered
  reads (`--from`, `--act`, `--id`, `--thread`, `--waiting`, `--deferred`) render no directed
  section and consume nothing new.
- `--json` is unchanged in this decision. The directed slice is already derivable from the
  `to`/`meta` fields a JSON consumer holds; a named `waiting_on_you` array is a separate,
  additive proposal if a consumer ever needs it, not a silent shape change here.
- `musterd status` keeps pointing at `musterd inbox`. No new flag is taught.

## Consequences

The first screen of `inbox` gets longer by the directed count on a busy seat. That is the
point: the acts that can block a teammate stop being the hardest to find. The general list
keeps its order and its window, so a reader who ignores the section loses nothing.

A seat that preferred the old single list can still get it with a filter (`--all` renders its
own contract, also unchanged). Nothing about the server, the cursor, or the wire changes: the
directed projection already exists server-side for the daily view; the CLI inbox read asks
for the same slice alongside its window.

This record changes no code. If the ADR is rejected, the fallback is to repoint the daily view's arrow at
`musterd inbox --waiting` and accept that the landing is a banner, not the acts themselves.

Amended 2026-10-30 (acceptance review, lane `01M653W2VKYQRP3P9MDHP7RRQ8`): as first landed,
the Decision defined N by the daily view's projection but filled the section with "the
directed unread acts" — two different sets, since an act read but not yet answered still
waits. The Decision now reads as one set throughout: the section renders exactly the rows
the projection returns, read or unread, the eval asserts the section's row count equals N,
and the header carries the daily view's `⚑` glyph. The implementation lane's first landing
also computed its N over the inbox's own bounded window with a first-page answered set, and
the two counts disagreed live (40 vs 42); the correction derives both surfaces from the one
projection helper over the one walked window.

Follows-up: `01M658ZSMQFRQYRNCRJXSQ7YR1` (implementation, opened 2026-10-30, blocked on this
ADR's acceptance).

## Observability & Evaluation

- **Traces:** n/a — no new events. The inbox read already logs its cursor movement; the
  section adds no server call shape beyond the existing daily projection.
- **Eval:** on a seeded team with directed and broadcast unread mixed, `musterd status`'s
  waiting count and `inbox`'s section header print the same N, and the section's row count
  equals N; every row the projection returns appears in the section and exactly once on the
  page; a `--peek` read after it still shows the same unread (nothing consumed); a normal
  read consumes exactly the rows shown, section included (ADR 117's guarantee, re-run
  against the new layout).
- **Experiment:** n/a — a layout correction against a measured mismatch, not a behavioural
  hypothesis. The falsifier is the eval above: if the two counts can disagree, the fix failed.
