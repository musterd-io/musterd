# 757 — daily view rows: a fixed right column, not hand-set gutters

- Status: accepted
- Date: 2026-10-29

## Context

The daily view of `musterd status` has four frames: 27-2 (busy, 80 columns), 27-4 (busy, 40), 27-6 (empty)
and 27-8 (degraded). They are listed under "Daily view frames" in `docs/design/figma-brief-terminal.md`. Lane
01M64626WK brought `status.ts` up to the frames (PR #3548) and listed three differences that remained.
big-body declined the lane on them, because hard rule 2 says CLI output matches the frames or the frames
change by ADR:

1. The hub's ⚠ line read `unreachable since 12m ago —` where the frame reads `since 12m —`.
2. A waiting row did not add `(you + 2 others)` for an ask sent to a set of seats.
3. Ages and lane hints sat after whatever gap a row's text left. The frames place them by hand.

## Problem

The first two are copy the code can match. The third cannot be matched as drawn. The frames' gutters
were set row by row: at 80 columns the `active` lane's text ends at column 54 before a hint that
starts at 62, and the `claimed` lane's text ends at 49 before a hint at 66. At 40 columns the three
waiting rows end at 28, 29 and 30. No rule computed from data gives those positions. A layout that
only a designer's eye produces either drifts from the frames on the first real title, or forces the
renderer to special-case the frames' example text. The frames need a rule the code can keep, and a
test that holds both to it.

## Decision

1. The hub's ⚠ line in the daily view reads `⚠ hub <name> unreachable since <age> — <cause>`, as
   the frame does. The CLI's `hubWarning` drops the `ago` from the shared `describeHubLink` line.
   The helper itself is unchanged, and the other surfaces that print it keep `ago`.
2. A waiting act sent to a set of seats that includes you (ADR 254) ends
   `(you + N other[s])`. The suffix is part of the row's text, so a narrow terminal cuts it first.
3. Each section's rows leave a **fixed right column**. Waiting rows leave 10 cells for their age.
   Lane rows leave 20 cells for their hint at 60 columns and wider, and 8 cells under 60, where
   hints are dropped. A row's text is cut with `…` to fit what is left. The age or hint
   right-aligns to the last column, at least two spaces after the text. Cut rows therefore end on
   one vertical line per section. At 40 columns that reproduces 27-4's waiting and lane rows to
   within a character.
4. At 40 columns an up-next row keeps its lane id and cuts the title (`Desk-level presence for… —
   01M6ABCD12`), where 27-4 cuts the id away. The id is the part a reader acts on.
5. `commands/status.daily.test.ts` pins the busy day at 80 and at 40 columns line for line, and
   the empty and degraded days by their lines. The frames are read through this rule. A change
   to the layout changes the test, and with it this ADR's frames.

## Consequences

- The three differences the brief listed are closed. The brief now points here instead of
  listing them.
- The frames' example positions are approximations of decision 3. Redrawing 27-2/27-4 to the rule
  is a design pass, not a blocker. Until then a reviewer reads the frames through this ADR.
- The lane column is wider than the longest hint (`PR merged · submit`, 18 cells). A new hint
  longer than 18 cells needs the column widened here.

## Observability & Evaluation

n/a — a terminal layout rule with no agent-facing behaviour. The line-for-line test is the check.
