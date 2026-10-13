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
 * The tools a session needs before it can do anything else (lane 01M4S53E79): join the team, read
 * what waits, say what it is doing, see the room. A harness that defers MCP tools behind a schema
 * search (Claude Code's ToolSearch) is asked to load these four up front, via `_meta`
 * `anthropic/alwaysLoad` on their `tools/list` entries, so the first call of a session is the call
 * itself. The rest stay deferred: every always-loaded schema is standing context in every turn.
 */
export const HOT_TOOLS = [
  'team_join',
  'team_inbox_check',
  'team_send',
  'team_status',
] as const satisfies readonly (typeof TOOL_NAMES)[number][];
