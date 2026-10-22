import { HARNESSES } from './harnesses/index.js';
import type { Toolkit } from './toolkit.js';

/**
 * The one toolkit-provisioning path (ADR 708): a toolkit's MCP servers + permission defaults
 * into every named harness that can provision, additively (ADR 027) and best-effort — a
 * harness that cannot provision, or a provision that throws, is reported per harness and
 * never fails the caller. `init`, seat creation, `role assign`, `wire`, and `harness configure`
 * all run this so they cannot drift into different behaviours (ADR 713).
 */
export interface ToolkitProvisionOutcome {
  harness: string;
  /** Servers actually written. */
  servers: string[];
  /** Servers the harness could not represent and skipped — reported, never dropped. */
  skipped: string[];
  /** Permissions actually applied (0 where a harness degrades them to declared intent). */
  permissionsAdded: number;
  /** Why nothing (or only part) was provisioned, when that happened. */
  error?: string;
}

const hasPermissions = (p: { allow: string[]; ask: string[]; deny: string[] }): boolean =>
  p.allow.length + p.ask.length + p.deny.length > 0;

/**
 * Provision `toolkit` into `harnessIds`, with the harnesses' cwd-scoped writes aimed at
 * `cwd` (some adapters key their config off the process cwd — Claude Code's `claude mcp`
 * local scope most of all — so the caller's cwd is moved for the duration and restored).
 * Nothing to provision (no toolkit, or a toolkit with no servers and no permissions)
 * returns an empty list. Secrets stay `${ENV}` references end to end.
 */
export async function provisionToolkitIntoHarnesses(
  toolkit: Toolkit | undefined,
  harnessIds: readonly string[],
  cwd: string,
): Promise<ToolkitProvisionOutcome[]> {
  if (!toolkit) return [];
  const { mcp_servers: servers, permissions } = toolkit.tools;
  if (servers.length === 0 && !hasPermissions(permissions)) return [];

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
          skipped: servers.map((s) => s.name),
          permissionsAdded: 0,
          error: `unknown harness "${id}"`,
        });
        continue;
      }
      if (!harness.provision) {
        outcomes.push({
          harness: id,
          servers: [],
          skipped: servers.map((s) => s.name),
          permissionsAdded: 0,
          error: `tool provisioning isn't supported for ${harness.label} yet`,
        });
        continue;
      }
      try {
        const result = await harness.provision(
          {
            servers: servers.map((s) => ({
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
          permissionsAdded:
            result.permissions.allow.length +
            result.permissions.ask.length +
            result.permissions.deny.length,
        });
      } catch (err) {
        outcomes.push({
          harness: id,
          servers: [],
          skipped: servers.map((s) => s.name),
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
