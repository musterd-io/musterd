# 582 — Finding work on the board: one query string, short ids, derived areas

- Status: accepted (2026-10-13, nick, in chat: "looks good")
- Date: 2026-10-13
- Goal: `find-work` · lanes `01M4VKRT87` (this ADR), `01M4VKRXEX` (query), `01M4VKS1T4` (short ids),
  `01M4VKSDJH` (areas), `01M4VKS6SF` (one lane in full)

## Context

nick, 2026-10-13: "what would make it easier for musterd members to find lanes/goals on the board? we
have mcp, cli, agents go just read the db directly or some other command. what if lanes/goals have tags
like 'UI'?"

The board's data already says most of what a seat searches for. Of 147 lanes not done or abandoned that
day, 135 (92%) carried a `goal_id` and 96 (65%) carried surface globs. The ways to ask for it are thin:

- `lane_board` (`packages/mcp/src/tools/lanes.ts:242`) takes `project`, `mine`, `open`, `state`.
  `musterd lanes` (`packages/cli/src/commands/lane.ts:404`) takes `--project --mine --open --history`.
  `team_goals` takes `include_retracted` only. Both clients already send `goal=` to `GET /lanes`;
  neither front end exposes it.
- `GET /lanes` (`packages/server/src/transport/http.ts:6396`) reads the whole board and filters in
  memory (`filterLanes`, `store/lanes.ts:829`), on exact matches only.
- Every lane-taking tool sends the id verbatim to `PATCH /lanes/:id`, and `getLane` (`store/lanes.ts:372`)
  is an exact lookup. No path resolves a short id, though acts, `musterd report` and the launcher print
  lanes as 10 characters. `lane_claim 01M4VA7NQG` failed with `no lane` on 2026-10-13.
- There is no read of one lane: `/lanes/:id` is PATCH only. Its acceptance asks, its PR and its follow-ups
  live in `messages` and `merged_json`, which no tool returns together.

So seats read the database. izzo did it four times on 2026-10-13: the acceptance ask for a lane (to
`reply_to` it), a short id to a full one, a lane's brief, and the lanes under a goal. Each one is
`sqlite3 ~/.musterd/musterd.db`, which works only on the daemon's own machine, reads under no seat's
authority, and depends on the schema staying put.

Tags were the question. The two optional declared fields lanes already have show what declared tags
would get: `risk` was set on 10 of 147, `role` on 7.

## Problem

Finding work on the board means knowing the full id, or reading everything, or reading the database. A
declared tag would add a field few seats fill in. A filter argument per field would cost the MCP tool
list bytes it does not have: `toolsListDefaultBytes` in `docs/perf/context-budgets.json` has no headroom,
and `pnpm context:check` refuses a raise without a stated rent and falsifier.

## Decision

1. **One query string, not a filter per field.** `lane_board` and `team_goals` each gain one optional
   argument, `q`. `GET /lanes` and `GET /goals` take the same `?q=`, and `musterd lanes` and
   `musterd goal list` take it as positional text. The grammar is space-separated terms, all of which must
   match:
   - `key:value` for a field: `goal:`, `area:`, `owner:`, `state:`, `role:`, `risk:`, `project:`,
     `path:`. `path:` keeps a lane whose surface overlaps the path, using the existing `globsOverlap`
     (`store/lanes.ts:1109`). A key may repeat, and repeats of one key are OR'd: `state:open state:claimed`.
   - Bare words match case-insensitively against the title and detail. Quoted words match as one phrase.
   - An unknown key is a 400 that lists the known ones. A query must never quietly become a text search
     the seat did not mean.

   The existing `project`, `mine`, `open` and `state` arguments stay, and they combine with `q`. Goals
   take `q` over id, title and story, plus `status:`.
2. **Short ids resolve everywhere a lane id is taken.** `getLane` and the `/lanes/:id` routes accept a
   unique prefix of at least 8 characters. Two or more matches is a 409 `ambiguous` that lists the
   candidates' ids and titles. Under 8 characters is a 400. A ULID's first 10 characters are its
   millisecond timestamp, and the 10-character form seats see is unique in practice. 8 still separates
   lanes opened a second apart. Responses always carry the full id.
3. **Areas are derived, not declared.** Each lane on the wire gains `areas: string[]`, computed at read
   time from `scope` (the surface globs) by matching path segments against one mapping, kept in
   `@musterd/protocol` as a plain-TS vocabulary beside `lanes.wire.ts`. Its first entries:

   | area | a path segment that names it |
   | --- | --- |
   | `ui` | `web`, `ui`, `frontend`, `client`, `components`, `styles`, `site` |
   | `server` | `server`, `api`, `backend` |
   | `cli` | `cli` |
   | `mcp` | `mcp` |
   | `protocol` | `protocol` |
   | `docs` | `docs`, or a top-level `*.md` |
   | `ci` | `.github`, `ci`, `scripts` |
   | `tests` | `test`, `tests`, `e2e` |

   A lane may declare `areas` on open or update. Declared areas replace the derived ones; they do not
   add to them. Because areas are computed when the board is read, a change to the mapping reaches
   every lane, old ones included, and nothing has to be migrated. `area:` in `q` matches either kind.
   The board, `/live` and `team_next` show areas next to the goal.
4. **A query that names exactly one lane returns all of it.** When `q` is a lone id (full or a valid
   prefix) and resolves to one lane, `lane_board` returns that lane in full: brief, `scope` and areas,
   owner and state history, `merged`, `follows_up`, and its open acceptance asks with their ids, so
   `reply_to` needs no lookup. `musterd lane show <id>` prints the same. The server route is a new
   `GET /lanes/:id`. There is no `lane_show` MCP tool, because one would cost tool-list bytes for what
   one argument already reaches.
5. **Protocol.** Responses gain fields: `LaneSchema.areas`, `LaneSchema.declared_areas`, and a
   single-lane response schema. That is this ADR's protocol change. The `q` argument gets its zod
   schema in `@musterd/protocol` and the MCP tools import it, so the argument is parsed at the boundary
   (AGENTS.md hard rule 4). The inline schemas in `tools/lanes.ts` stop being the only definition.
   Additive only: no field is removed or renamed, and older clients ignore what they do not know.

## Consequences

- A seat asks the board the questions it reads the database for today. `lane_board {q:"area:ui
  goal:launch state:open"}`, `{q:"sync"}` and `{q:"01M4VA7NQG"}` are each one call, through the seat's
  own authority, on any machine.
- One argument on two tools is the whole tool-list cost. `pnpm context:check` measures it, and the
  increment that lands it carries the budget line if it is over.
- The area mapping is a judgement call that will be wrong at the edges. `scripts` is `ci` here and might
  not be elsewhere, for instance. It is one reviewed file, and declared areas are the escape hatch.
  A lane with no globs (35% today) gets no areas until someone declares them or gives it a scope.
- A short-id prefix can become ambiguous after the fact, when a second lane comes to share it. The 409 lists the
  candidates rather than guessing, the same as seat-name resolution (`launcher/resolve.ts:28`).
  `archaeology.ts:128`'s first-match prefix is moved onto the server path so there is one rule.
- Text search scans the in-memory board, as every filter does today, so it costs one board read.
  A board in the thousands would want an index. That is not this ADR.
- Increments (lanes under goal `find-work`): `01M4VKRXEX` — `q` on lanes and goals, server through CLI;
  `01M4VKS1T4` — short ids; `01M4VKSDJH` — areas, derivation, declared override and display;
  `01M4VKS6SF` — the single-lane read (Decision 4). Each is independent. `01M4VKRXEX` takes `area:` once
  areas exist.

## Observability & Evaluation

- **Traces:** none new. `lane_board` and `team_goals` calls already sit inside the adapter's
  `musterd.tool.call` span. The increment that adds `q` records its key names only, never the free text,
  as a span attribute, so how the board is searched is countable.
- **Eval:** seats reading the database to find work. Metric: agent-turn shell commands (ADR 445
  `TraceEvent`s) that open `musterd.db` and query `lanes`, `goals`, or `messages` by lane, per seat-day.
  Baseline: izzo, 4 on 2026-10-13. The other seats were not measured that day; the first increment to
  land takes a one-week baseline across seats before it ships.
- **Experiment:** compare the week before `01M4VKRXEX` and `01M4VKS6SF` land with the week after. The ADR
  holds if those reads drop by more than half. If they do not, the board still lacks an answer seats
  need, and the commands they ran instead say which one.
