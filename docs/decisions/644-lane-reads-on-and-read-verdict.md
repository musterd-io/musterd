# 644 — A lane declares the date it reads on, and its close gives the read's verdict

- Status: accepted
- Date: 2026-10-17
- Deciders: nick (chose the lane field over a calendar kind or a repo-doc line, and the column +
  corkboard placement, in slippy's session on 2026-10-17)
- Lane: `01M55KZF5M41HBR7CWSC5PHFHD` (goal `launch`)
- Design: [docs/superpowers/specs/2026-10-17-experiments-panel-design.md](../superpowers/specs/2026-10-17-experiments-panel-design.md)
- Builds on: ADR 530 (a lane declares what a reader cannot infer, at open), ADR 533 (a stored date
  past which someone is asked, never a timer that changes the thing), ADR 536 (rank and show from
  declared fields only, never from a title), ADR 519 (`CalendarDateSchema`: a real day, wall-clock),
  ADR 487 (`follows_up` is refused on a close that lacks it — the shape copied here)
- Protocol change: yes (hard rule 1) — `reads_on` and `read_verdict` on `LaneSchema`,
  `OpenLaneSchema` and `UpdateLaneSchema`; the derived `read_status` on the lane projection; audit
  verb `lane.read_recorded`.

## Context

The team runs dated experiments. Each one says what it measures and the day it is read, and most
also say what would prove it wrong. On 2026-10-17 the board held three:

- the ADR 536 up-next read, not before 2026-10-20 (lane `01M49HHJQF`);
- the ADR 436 wake-rail trigger, binding 2026-10-21 (lane `01M3TB1GP`);
- the accountability dogfood read, before 2026-11-02 (lane `01M4EDCSJD`).

Every one of those dates lives in a lane title or lane detail. nick asked for an "Experiments" view
on `/live` and `/broadcast` that lists them with their dates and status, so a read that slipped past
its day is seen instead of remembered.

## Problem

No structured field carries a read date. `park_until` is the only date on a lane, and it means "look
at this parked lane again", not "this measurement is due". Two repo-doc sources were checked and
neither fits. The date on a `Follows-up: deferred — … (YYYY-MM-DD)` line (ADR 373) is the day the
deferral was written. The date on a wiki `<!-- claim -->` line is the day something was observed.
Both look backward. Reading the date out of a title is what ADR 530 and ADR 536 refuse: a renderer
that parses "(2026-10-20)" out of prose shows whatever the last editor happened to type.

A calendar entry (ADR 519) has a real date type, but the calendar holds a person's events. Its
statuses (`going`, `invited`, …) do not say "read" or "overdue", it has nowhere to keep a verdict,
and adding a `read` kind would still change the protocol. A repo-doc line (`Reads-on:`) would need
the daemon to read a checkout at runtime, which a Cloud team (ADR 621) does not have, and a verdict
would wait on a merge.

The three examples are all lanes already. The read is work someone owns, so the date belongs to that
work.

## Decision

1. **A lane may declare `reads_on`, the day its read is due.** It is a `YYYY-MM-DD` real day
   (`CalendarDateSchema`, wall-clock in the team's calendar zone, `CALENDAR_DEFAULT_TZ` until a team
   zone exists). It is accepted on `lane_open` / `musterd lane open --reads-on` and on
   `lane_update` (where `null` clears it). It is never inferred from a title, a detail or a doc.
2. **The read's result is a declared `read_verdict`:**
   `{outcome: 'met' | 'missed' | 'inconclusive', note, by, at}`. `note` is 1–280 characters and says
   what was read. The daemon stamps `by` from the authenticated sender and `at` from its clock. It
   rides `lane_update`, `lane_submit` or `lane_resolve`, so the verdict can be given while the
   lane's follow-on work (say, reverting what the read disproved) is still open. A later verdict
   replaces an earlier one, and each write is one `lane.read_recorded` audit row carrying both.
3. **A lane with `reads_on` and no `read_verdict` cannot close `done`.** The transport refuses it
   with `validation` ("this lane reads on <date>: give read_verdict"). This is the same posture as
   ADR 487's `follows_up`: silence is the only shape refused. `abandoned` still only needs its
   `abandon_reason`, and an abandoned read is dropped, not overdue.
4. **The server derives `read_status` on the lane projection**, so the board, the CLI, `/live` and
   `/broadcast` agree. Today means the day in the calendar zone at the read:
   - `read`: a `read_verdict` exists;
   - `dropped`: the lane is `abandoned` with no verdict;
   - `waiting`: today is before `reads_on`;
   - `due`: today is `reads_on`;
   - `overdue`: today is after `reads_on` and there is no verdict.
   `read_status` is absent on a lane without `reads_on`. It is never stored and never sent by a
   client (a client copy is stripped).
5. **Overdue is shown, never acted on.** No ask is raised, no lane moves and no seat is woken. The
   panel is the signal. A server that later rings a read's owner goes through its own ADR.
6. **A server behind this ADR still parses.** Both fields are optional, and a renderer that sees no
   `reads_on` shows no Experiments entry for that lane.

## Consequences

- Increment 1 (protocol, server, MCP, CLI): the fields, the close refusal, the derived status and
  the audit verb, with `musterd lane open --reads-on` and `musterd lane update --read-verdict`.
  The three live examples get `reads_on` set by their owners once it lands.
  Follows-up: 01M55WJXNPFDTYTCMPSRVCBFYP
- Increment 2 (web): the Experiments section in `TeamColumn`, which `/live` and `/broadcast` share,
  is built from the spec. That is this lane's done-when.
- Increment 3 (scene): one pin per read on the office corkboard, colored by `read_status`. The
  Experiments section is its text equivalent.
  Follows-up: 01M55WK0N22SN8ASEDZGG4PX2Z
- _2026-10-17 (lane 01M55WJXNP, increment 1 built):_ three points the Decision left to the build.
  An acceptance `accept` closes a lane `done`, so it meets the same refusal as any close: a dated
  read with no verdict is refused with `validation`, and the owner gives the verdict and the accept
  is sent again. The abandoned-acceptance sweep leaves such a lane where it is, visibly `overdue`,
  rather than closing it without a verdict. On MCP the verdict is one undescribed string,
  `"<met|missed|inconclusive>: <note>"` (the `follows_up` shape), because tools/list is budgeted:
  the three tools that carry it cost +185 B in all (`docs/perf/context-budgets.json`).
- Wiki falsifiers marked "Revisit YYYY-MM-DD" do not appear on their own. To be on the panel, a
  revisit becomes a lane with `reads_on`. That is deliberate: a revisit nobody owns is not a read.
- One day of `due` is narrow. A read due on a Saturday shows `overdue` on Sunday. That is the
  honest reading of "not before", and it is measured below before anyone softens it.

## Observability & Evaluation

- **Traces:** each verdict is one `lane.read_recorded` audit row
  `{lane, reads_on, outcome, by, at, previous_outcome}`. A refused `done` close is the existing
  `validation` refusal, with `reads_on` in its message.
- **Eval:** after 30 days, count the lanes carrying `reads_on`, and for each one the gap between
  `reads_on` and `read_verdict.at`. The decision works if no read stays `overdue` for more than 3
  days without a verdict or a moved date. If more than a third of reads go overdue and are then
  given a verdict within 1 day, the single `due` day is too narrow, and a grace window gets its own
  ADR.
- **Experiment:** n/a — this declares a field and shows it; it changes no agent behavior to compare
  against a baseline.
