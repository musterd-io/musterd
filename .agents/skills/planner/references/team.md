# This team: musterd (revive)

The only file in this skill that names musterd's specifics. Read before the first plan in a
session. A team adopting this skill replaces this file with its own.

## The role here

- **Built-in role**: `planner` in `packages/cli/src/roster-roles/templates.ts`, created on a team
  with `musterd role create planner --from planner`. revive's role library has no `planner` today
  and no seat has held it, so the acceptor of this skill is a human.
- **A charter, not a power**: a planner is a member whose charter says plan; it gets no protocol
  power (`docs/design/roles-and-stewardship.md`). musterd does not split or assign work on its
  own; the roadmap keeps an orchestrator out of scope (`ROADMAP.md`, item `no-orchestrator`). The
  plan's accept is what lets the planner open and hand off lanes.

## The tools

| Step | Tool | Notes |
| --- | --- | --- |
| Pick it up | `team_send {act:'status_update'}` | `planning: <idea in five words>` |
| Ask | `team_send {act:'ask'}` with `meta.species: 'consult'`, `meta.tier: 'advisory'` | Advisory asks proceed after 3 minutes, standard after 5; blocking holds 15 (`packages/protocol/src/ask.wire.ts`). Every ask is also pushed to the team's human admins (ADR 147 §3), so keep them few |
| Post the plan | `team_send {act:'message', to:'@team'}` | Any member's `accept` is the go |
| Declare the goal | `team_goal_declare` | `id`, `title` (the outcome), `story` (one line, at most 140 characters) |
| Open lanes | `lane_open` | `goal_id`, `title`, `scope` (paths), `detail` ("done when …"), `depends_on`, `stakes`, `risk`, `role` (a hint) |
| Hand off | `lane_handoff` or `team_send {act:'handoff'}` | One owner per lane |
| Who is here | `team_members`, `team_status` | Present first, then wakeable |

## Lane rules you must follow at open

- **A plan of several steps is a goal with every step's lane opened now**, chained by
  `depends_on`; dropped ones are abandoned with a reason (ADR 487). A one-step plan is one lane
  and needs no goal; `lane_open` without `goal_id` only advises. Deferred lanes are opened
  with why they wait in `detail`; only a human may park a lane (ADR 466), so ask nick to park
  them. A lane whose title says "increment N" or "N of M" needs `follows_up` when it is
  submitted.
- **`risk` must be declared** when a lane's scope reaches `packages/web/**` or
  `packages/mobile/**`, or the open is refused (ADR 530). The form differs by surface:
  `lane_open` takes an array (`risk: ["user-facing"]`, or `risk: []` for none); the CLI takes
  `--risk tag[,tag]` or `--risk none`. A string `'none'` in the tool call is rejected. Any risk tag routes the acceptance to a
  human first (ADR 169).
- **`stakes`** is low, normal or high (default normal); low may skip acceptance (ADR 234).
- **Vocabulary**: goal, lane, phase, increment (ADR 098; `pnpm vocab:check`). No epics, sprints
  or story points.
- **Scope overlap** between open lanes is warned, not blocked; avoid it anyway (hard rule 6).
- **Acceptance** judges the landed outcome on intent, principles, usable and feel (ADR 192). The
  plan's "done when" is what the acceptor checks.

## Product rules a plan meets

- Monitoring is diagnostic, not evaluative: "Never a leaderboard of Members"
  (`docs/design/brand-coordination-observability.md`). This is the team's source for hard rule 9;
  cite it in the decide lane.
- CLI output is held to the Figma terminal frames, a new runtime dependency needs an ADR, and
  the protocol schema changes only with an ADR (AGENTS.md hard rules 1, 2 and 6).

## The team

`team_members` is the truth. Build lanes go to agent seats; nick is the human who decides and
reviews. Roles held on revive: platform, designer, comms, security, courier, admin (steward and observer exist, unheld).
Write work stays in a seat: a lane never goes to a helper process without a seat of its own
(AGENTS.md hard rule 8).

## What happened before

| Date | What happened | What it taught |
| --- | --- | --- |
| 2026-09-26 | The first planner skill (#1759) ran a live-build demo: pitch from a phone, asks, plan, board on the projector; its scope was fixed to a static front end on Cloudflare Pages (`docs/demo.md` §7, now historical) | Team and venue specifics belong here, not in the core |
| 2026-10-01 | The next demos dropped the planner; the team split the work itself in a huddle (`docs/demo/multiplayer-ai-2026-10-01/`) | A planner is optional; the team can plan without one |
| 2026-09-26 | A rehearsal note (ADR 459, proposed) says the planner created agents in a burst | Creating members is not the planner's (hard rule 7) |
