import { z } from 'zod';
import { sparsePartial } from './schema.js';

/**
 * Seat tool grants (ADR 794). A seat loads exactly what its repo commits, plus the team's shared
 * set, plus the set for each role it holds — minus the product floor's skill denies, which no
 * grant can lift. Grants live here, in team policy, because a local toolkit file is unaudited and
 * a seat can edit it: only an admin human writes policy, and every write is a `policy.change`
 * audit row. Not a secret, so seats read it through the scoped `GET /seat-tools` route.
 */

/** A harness plugin id: `PLUGIN@MARKETPLACE`. A claude.ai-synced plugin is `<name>@synced`. */
export const PluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/, 'plugin id must be PLUGIN@MARKETPLACE');

/** The one plugin a team that never set `seat_tools` shares with every seat. */
export const DEFAULT_SHARED_PLUGIN = 'superpowers@claude-plugins-official';

/**
 * One MCP server definition an admin grants (ADR 817). Exactly one transport, matching a toolkit
 * server minus its name: `command` for stdio, or `url` for remote HTTP. `args` and `env` default
 * empty, so a grant that omits them matches a proposal that omits them.
 */
export const SeatToolServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().url().optional(),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), {
    message: 'an MCP server carries exactly one transport: `command` (stdio) or `url` (remote)',
  });
export type SeatToolServer = z.infer<typeof SeatToolServerSchema>;

/**
 * One grant set. Each list is the whole set: writing a list replaces it, never merges into it.
 * `mcp_servers` are NAMES of servers in the human's layer to let through (a claude.ai connector,
 * a user-config server). The command or URL a harness runs is `seat_tools.servers` (ADR 817).
 */
export const SeatToolSetSchema = z.object({
  claude_plugins: z.array(PluginIdSchema).default([]),
  codex_plugins: z.array(PluginIdSchema).default([]),
  /** Skills beyond the seat's own role skill: a plugin skill or a user-folder skill, by name. */
  skills: z.array(z.string().min(1)).default([]),
  mcp_servers: z.array(z.string().min(1)).default([]),
});
export type SeatToolSet = z.infer<typeof SeatToolSetSchema>;

export const SeatToolsPolicySchema = z.object({
  shared: SeatToolSetSchema.prefault({ claude_plugins: [DEFAULT_SHARED_PLUGIN] }),
  /** Per-role sets, keyed by roster role name. A role with no entry adds nothing. */
  roles: z.record(z.string().min(1), SeatToolSetSchema).default({}),
  /**
   * Admin-granted MCP server definitions, keyed by server name (ADR 817). A toolkit proposal is
   * provisioned only when it matches the grant for that name, or a built-in definition. Absent
   * reads as none: a reader that has not seen a grant does not invent one.
   */
  servers: z.record(z.string().min(1), SeatToolServerSchema).default({}),
});
export type SeatToolsPolicy = z.infer<typeof SeatToolsPolicySchema>;

/** The sparse stored form: either half may be absent and reads as its default. */
export const SeatToolsPolicyOverrideSchema = sparsePartial(SeatToolsPolicySchema);

/** `GET /teams/:slug/seat-tools` (ADR 794): the effective grants, nothing else from policy. */
export const SeatToolsResponseSchema = z.object({ seat_tools: SeatToolsPolicySchema });
