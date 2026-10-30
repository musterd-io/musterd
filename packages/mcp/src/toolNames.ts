/**
 * The canonical list of MCP tool names `buildMcpServer` registers (ADR 085). Kept in its own tiny,
 * dependency-free module so the guidance drift check (`scripts/check-guidance.ts`) can import it
 * without pulling in the MCP SDK. `mcp.test.ts` asserts this equals the built server's actual registry,
 * and `pnpm guidance:check` asserts the skill's `SKILL_MCP_TOOLS` is a subset of it — so renaming a
 * tool without updating the skill breaks the build.
 *
 * Naming convention (ADR 144 inc 2 — the audited standard): `<namespace>_<operation>`, with exactly
 * two DELIBERATE namespaces. `team_*` is the coordination surface — presence, acts, Seeds, goals,
 * memory, insight. `lane_*` is the work-board sub-surface — a Lane's lifecycle. The
 * split is intentional, not drift: MCP spec issue #2808's namespacing proposal favors several small
 * namespaces over one flat prefix, and folding lanes into `team_lane_*` would lengthen every name
 * and break connected agents for no selection gain. New tools join one of these namespaces or argue
 * a third in an ADR; operations are a verb (`join`, `send`, `resolve`) or the noun they read
 * (`status`, `board`, `goals`).
 */
export const TOOL_NAMES = [
  'team_join',
  'team_leave',
  'team_send',
  'team_inbox_check',
  'team_status',
  'team_members',
  'team_memory_save',
  'team_memory_read',
  'team_availability',
  'team_question',
  'team_style',
  'team_style_set',
  'team_wake_context',
  'team_seed_list',
  'team_seed_get',
  'team_seed_update',
  'lane_open',
  'lane_claim',
  'lane_release',
  'lane_handoff',
  'lane_update',
  'lane_submit',
  'lane_resolve',
  'lane_board',
  'team_next',
  'team_goal_declare',
  'team_goal_outcome',
  'team_goal_retract',
  'team_goals',
  'team_report',
  'team_insight_save',
  'team_insight_search',
] as const;

/**
 * Tools registered on the remote rail only (ADR 630), beside {@link TOOL_NAMES}: a phone's human
 * sponsors and connects agents here, while a desk does it with `musterd agent`, so no desk seat
 * pays their standing context.
 */
export const REMOTE_TOOL_NAMES = ['team_agent_create', 'team_agent_connect'] as const;

/**
 * The tools a working seat reaches for in nearly every session: join the team, read what waits, say
 * what it is doing, see the room (lane 01M4S53E79), then orient, open/claim/update/submit/resolve a
 * lane, read the board, and read/save seat memory (ADR 741). A harness that defers MCP tools behind
 * a schema search (Claude Code's ToolSearch) is asked to load these up front, via `_meta`
 * `anthropic/alwaysLoad` on their `tools/list` entries, so the call is the call itself: a deferred
 * tool costs a whole extra turn at the session's full context the first time it is needed (median
 * $0.30 and 2.7 s on revive, ADR 741), while its schema is cached standing context either way. The
 * rest stay deferred: each is reached in a handful of sessions, and every always-loaded schema is
 * standing context in every turn. Pinned by `hotTools.test.ts`; grow it with a measurement.
 */
export const HOT_TOOLS = [
  'team_join',
  'team_inbox_check',
  'team_send',
  'team_status',
  'team_next',
  'lane_board',
  'lane_open',
  'lane_claim',
  'lane_update',
  'lane_submit',
  'lane_resolve',
  'team_memory_read',
  'team_memory_save',
] as const satisfies readonly (typeof TOOL_NAMES)[number][];
