# 540 — The picker's first screen lists the teams on this machine, not only the recent seats

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (asked for it 2026-10-06), lazara (lane `01M49K9NSM8ZD9258EYW05XFPF`)
- Goal: `launch`
- Relates to: ADR 491 (the seat launcher — Decision 1 is amended here, not reversed), ADR 503
  (roster-first catalog: the teams the snapshot knows, here or not)

## Context

Bare `musterd` on a terminal opens the seat picker (ADR 491). Its first screen is the `recent`
level: every seat on this machine, newest use first. Teams, projects and members are a separate
drill-down that `→` enters. The only place the screen says so is the footer, in dimmed text, as
`→ browse`; the word "teams" appears on screen only as a comma-joined list in the header's right
corner, which reads as status, not as something to open. The `?` help says `→ ← into a level · back
out`, which still does not name the level.

## Problem

nick, 2026-10-06: "when I do the musterd command, I see the members that I have most recently
opened a session for on this machine. That is not the most intuitive — I should have more simple
guidance of what teams are on this machine as well as recently opened. Right now it is not super
clear that I can click the right arrow to advance to the teams."

Three things compound. "Browse" does not say what is browsed. Every row on the first screen is a
seat, so nothing on it leads anywhere: the drill-down is undiscoverable without knowing a key. And
a flat list of recent seats hides the shape of the machine — with three teams and a dozen seats
you cannot tell which team a seat belongs to without reading its address column.

## Decision

1. **The first screen is the recents, then the teams.** The `recent` level renders its recent seats
   (or, with no recents yet, the seats here) **capped at five** (`RECENT_LIMIT`), followed by a
   `teams` heading and the same rows the `teams` level shows: one per team the snapshot knows, with
   `● here · N seats` or `○ no Workspace here`, and `★` on the team of the seat used last. A team
   with no Workspace here is listed and not selectable, as on the `teams` level.
2. **`⏎` on a team row opens that team's projects**, exactly as it does on the `teams` level; `←`
   and `esc` come back to the first screen. The footer on a team row reads `⏎ open`; on a seat row
   it keeps `⏎ launch · ⌃R resume`.
3. **`→` still opens the `teams` level** from the first screen, and the footer now says so:
   `→ teams`, not `→ browse`. The help line reads `→ ← into the teams, a team, a project · back
   out`.
4. Search is unchanged: typing still searches every seat and shows no teams section.

ADR 491 Decision 1's "lists recent seats first" stands; this adds what comes after them on that
screen.

## Alternatives rejected

- **Only rename the hint.** `→ teams` alone fixes the word, not the affordance: the screen would
  still have no row that leads anywhere, and the key would still be the only door.
- **Open on the `teams` level.** One keystroke to a recent seat is ADR 491's point; most launches
  are a recent seat, and the capped list keeps that first.
- **Group the recents by team instead of a teams section.** Loses newest-first across teams, which
  is the ordering a recent list exists for, and still shows no team that has no recent seat.

## Consequences

- A machine with more than five recent seats reaches the sixth through its team, through search,
  or by name (`musterd <member>`). The cap is a constant, not a setting.
- The teams section repeats on the `teams` level; that level keeps its job as the `→` target and
  as the crumb for the drill-down, so nothing else moves.
- `04-cli.md` §`musterd` (bare) and the picker tests change in this commit.

## Observability & Evaluation

- **Traces:** none new. The picker is a pure state machine with no I/O of its own; a launch still
  records itself in `~/.musterd/launcher.json` as before, and a team opened from the first screen
  leaves the same `level` trail as one opened from the `teams` level.
- **Eval:** `pnpm --filter @musterd/cli test -- src/launcher/picker` asserts the first-screen rows,
  `⏎` on a team row, the five-row cap, and both footer forms. Baseline: the pre-ADR tests, which
  asserted only seat rows on the first screen and the `→ browse` footer.
- **Experiment:** nick's own use. If after a week he still reaches a team through `→` rather than
  `⏎` on its row, the section is decoration and this should be reconsidered.
