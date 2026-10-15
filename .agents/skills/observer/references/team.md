# This team: musterd (revive)

The only file in this skill that names musterd's specifics. Read before the first report in a
session. A team adopting this skill replaces this file with its own.

## The role here

- **Role file**: `observer` in the team home: "Read-only watcher — roster, board, goals, reports;
  holds no lanes, sends no acts". Capabilities `can_message: none`, `can_flag_urgent: false`.
  Unheld today, so the acceptor of this skill is a human.
- **The observer role sees what any member sees** (ADR 407). The watcher for an audience is in
  the core's charter boundary.

## What you can read

| Tool | Gives |
| --- | --- |
| `team_status`, `team_members` | Who is here, working, out; roles and presence |
| `lane_board` | Lanes by state |
| `team_goals`, `team_next` | Goals and what is next |
| `team_report` | `altitude: 'ic'` the board; `'team'` a flow digest (default); `'exec'` goals and exceptions |
| `team_inbox_check` | Acts addressed to you or the team |
| `/live`, `/board` | The team's own dashboards |

Write tools are hidden from a muted seat. Two that send acts (`team_goal_retract`,
`team_insight_save`) still show, and are refused when called; do not call them.

## Who reads you

Nobody yet; a report needs a named reader first (hard rule 2). The team already has a morning
digest from the `digest` service seat (ADR 494) and a weekly sweep (ADR 487 §7); an observer report
should add something those do not, for a reader who asked for it.

## Visibility rules

- musterd's own design says monitoring is diagnostic, not evaluative: "Never a leaderboard of
  Members" (`docs/design/brand-coordination-observability.md`, citing
  `docs/design/human-agent-dynamics.md` §4).

- Every member sees team acts, including direct messages, through the timeline (ADR 407). The
  exceptions: an ask to a human carrying `meta.about` is confidential, and public-grade observers
  see only team-wide traffic.
- Credentials (`mskey_`, `msgr_`, `mscr_` and the rest) never appear in a report (AGENTS.md hard
  rule 5).

## What happened before

| Date | What happened | What it taught |
| --- | --- | --- |
| 2026-07-31 to 2026-08-05 | wanderer held the observer role, then went back to a regular seat: "the observer role muted it" | The role suits a seat whose only job is reporting; a member who also builds needs to message |
