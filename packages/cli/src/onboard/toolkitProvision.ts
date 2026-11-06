import type { SeatToolServer } from '@musterd/protocol';
import { HARNESSES } from './harnesses/index.js';
import { BUILTIN_TOOLKITS, type Toolkit, type ToolkitMcpServer } from './toolkit.js';

/**
 * The one toolkit-provisioning path (ADR 708): a toolkit's MCP servers + permission defaults
 * into every named harness that can provision, additively (ADR 027) and best-effort — a
 * harness that cannot provision, or a provision that throws, is reported per harness and
 * never fails the caller. `init`, seat creation, `role assign`, `wire`, and `harness configure`
 * all run this so they cannot drift into different behaviours (ADR 713).
 *
 * A server is written only when `grants[name]` equals the proposal, or the proposal equals a
 * built-in definition (ADR 817). Anything else is named on `refused` and not written. An omitted
 * grant map grants nothing. Built-ins still provision.
 */
export interface ToolkitProvisionOutcome {
  harness: string;
  /** Servers actually written. */
  servers: string[];
  /** Servers the harness could not represent and skipped — reported, never dropped. */
  skipped: string[];
  /** Proposals that matched neither a grant nor a built-in definition. */
  refused: string[];
  /** Permissions actually applied (0 where a harness degrades them to declared intent). */
  permissionsAdded: number;
  /** Why nothing (or only part) was provisioned, when that happened. */
  error?: string;
}

const hasPermissions = (p: { allow: string[]; ask: string[]; deny: string[] }): boolean =>
  p.allow.length + p.ask.length + p.deny.length > 0;

interface ServerDefinition {
  command?: string | undefined;
  url?: string | undefined;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

function sortedEnv(env: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Transport, args in order, and env pairs. Env key order does not matter. */
export function mcpDefinitionsMatch(a: ServerDefinition, b: ServerDefinition): boolean {
  if (a.command !== b.command || a.url !== b.url) return false;
  if (a.args.length !== b.args.length) return false;
  for (let i = 0; i < a.args.length; i += 1) {
    if (a.args[i] !== b.args[i]) return false;
  }
  const left = sortedEnv(a.env);
  const right = sortedEnv(b.env);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (!l || !r || l[0] !== r[0] || l[1] !== r[1]) return false;
  }
  return true;
}

function proposalAllowed(
  server: ToolkitMcpServer,
  grants: Readonly<Record<string, SeatToolServer>>,
): boolean {
  const grant = grants[server.name];
  if (grant && mcpDefinitionsMatch(server, grant)) return true;
  for (const toolkit of Object.values(BUILTIN_TOOLKITS)) {
    for (const builtin of toolkit.tools.mcp_servers) {
      if (builtin.name === server.name && mcpDefinitionsMatch(server, builtin)) return true;
    }
  }
  return false;
}

function splitProposals(
  servers: readonly ToolkitMcpServer[],
  grants: Readonly<Record<string, SeatToolServer>>,
): { allowed: ToolkitMcpServer[]; refused: string[] } {
  const allowed: ToolkitMcpServer[] = [];
  const refused: string[] = [];
  for (const server of servers) {
    if (proposalAllowed(server, grants)) allowed.push(server);
    else refused.push(server.name);
  }
  return { allowed, refused };
}

/**
 * Provision `toolkit` into `harnessIds`, with the harnesses' cwd-scoped writes aimed at
 * `cwd` (some adapters key their config off the process cwd — Claude Code's `claude mcp`
 * local scope most of all — so the caller's cwd is moved for the duration and restored).
 * Nothing to provision (no toolkit, or a toolkit with no servers and no permissions)
 * returns an empty list. Secrets stay `${ENV}` references end to end.
 *
 * `grants` is the admin map from `GET /seat-tools`. The default is empty, which provisions
 * built-in definitions only (ADR 817).
 */
export async function provisionToolkitIntoHarnesses(
  toolkit: Toolkit | undefined,
  harnessIds: readonly string[],
  cwd: string,
  grants: Readonly<Record<string, SeatToolServer>> = {},
): Promise<ToolkitProvisionOutcome[]> {
  if (!toolkit) return [];
  const { mcp_servers: proposed, permissions } = toolkit.tools;
  const { allowed, refused } = splitProposals(proposed, grants);
  if (allowed.length === 0 && refused.length === 0 && !hasPermissions(permissions)) return [];
  if (allowed.length === 0 && !hasPermissions(permissions)) {
    return harnessIds.map((id) => ({
      harness: id,
      servers: [],
      skipped: [],
      refused,
      permissionsAdded: 0,
    }));
  }

  const outcomes: ToolkitProvisionOutcome[] = [];
  const prevCwd = process.cwd();
  try {
    process.chdir(cwd);
    for (const id of harnessIds) {
      const harness = HARNESSES.find((h) => h.id === id);
      if (!harness) {
        outcomes.push({
          harness: id,
          servers: [],
          skipped: allowed.map((s) => s.name),
          refused,
          permissionsAdded: 0,
          error: `unknown harness "${id}"`,
        });
        continue;
      }
      if (!harness.provision) {
        outcomes.push({
          harness: id,
          servers: [],
          skipped: allowed.map((s) => s.name),
          refused,
          permissionsAdded: 0,
          error: `tool provisioning isn't supported for ${harness.label} yet`,
        });
        continue;
      }
      try {
        const result = await harness.provision(
          {
            servers: allowed.map((s) => ({
              name: s.name,
              args: s.args,
              env: s.env,
              ...(s.command !== undefined ? { command: s.command } : {}),
              ...(s.url !== undefined ? { url: s.url } : {}),
            })),
            permissions,
          },
          'local',
          cwd,
        );
        outcomes.push({
          harness: id,
          servers: result.servers,
          skipped: result.skipped ?? [],
          refused,
          permissionsAdded:
            result.permissions.allow.length +
            result.permissions.ask.length +
            result.permissions.deny.length,
        });
      } catch (err) {
        outcomes.push({
          harness: id,
          servers: [],
          skipped: allowed.map((s) => s.name),
          refused,
          permissionsAdded: 0,
          error: (err as Error).message,
        });
      }
    }
  } finally {
    process.chdir(prevCwd);
  }
  return outcomes;
}
