import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './atomicWrite.js';
import type { Harness, ProvisionServer } from './harness.js';
import { HARNESSES } from './harnesses/index.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';

/**
 * The repo's own MCP servers reach every harness (ADR 529).
 *
 * A repository declares project MCP servers in `.mcp.json` — this one declares the whiteboard
 * (ADR 527). Claude Code reads that file natively; Codex, Cursor, OpenCode and Grok each read
 * their own project config, so a seat on those harnesses never saw the servers. This mirrors the
 * repo's servers into the project config of every non-Claude harness the folder is provisioned
 * for (its `desired` set), through each adapter's own `provision` — additive, by name, never
 * touching the user's other entries.
 *
 * - The `musterd` server is excluded: init provisions it with seat-specific wiring.
 * - Relative args that name a file in the folder are made absolute, so the entry does not
 *   depend on the cwd a harness launches its servers from. Env values pass through unchanged.
 * - Idempotent: `.musterd/repo-servers.json` remembers what was mirrored where (a hash of the
 *   servers and the harness set), so a launch with nothing new writes nothing.
 * - Reversible: what was added is recorded under the manifest's `repo-servers` key, unwound by
 *   `musterd uninstall` like role tools, and a server removed from `.mcp.json` is removed from
 *   the harnesses on the next mirror.
 */

const McpJsonSchema = z.object({
  mcpServers: z
    .record(
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string()).default({}),
      }),
    )
    .default({}),
});

/** The manifest key that records mirrored servers, as `repo-server <harnessId> <name>`. */
export const REPO_SERVERS_KEY = 'repo-servers';

/** Harnesses that read the repo's `.mcp.json` themselves and need no mirror. */
const READS_MCP_JSON = new Set(['claude-code']);

const StateSchema = z.object({
  hash: z.string(),
  harnesses: z.array(z.string()),
  servers: z.array(z.string()),
});
type State = z.infer<typeof StateSchema>;

function statePath(cwd: string): string {
  return join(cwd, '.musterd', 'repo-servers.json');
}

/** The repo's MCP servers, minus musterd's own, with folder-relative args made absolute. */
export function readRepoServers(cwd: string): ProvisionServer[] {
  const path = join(cwd, '.mcp.json');
  if (!existsSync(path)) return [];
  const parsed = McpJsonSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) return [];
  return Object.entries(parsed.data.mcpServers)
    .filter(([name]) => name !== 'musterd')
    .map(([name, s]) => ({
      name,
      command: s.command,
      args: s.args.map((a) =>
        !isAbsolute(a) && existsSync(resolve(cwd, a)) ? resolve(cwd, a) : a,
      ),
      env: s.env,
    }));
}

function readState(cwd: string): State | null {
  try {
    const res = StateSchema.safeParse(JSON.parse(readFileSync(statePath(cwd), 'utf8')));
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

/** Non-Claude harnesses this folder is provisioned for — the manifest's `desired` set. */
function targetHarnesses(cwd: string, registry: readonly Harness[]): Harness[] {
  const prov = loadProvisioning(cwd);
  const desired = prov.kind === 'valid' ? prov.value.desired : [];
  return registry.filter((h) => desired.includes(h.id) && !READS_MCP_JSON.has(h.id) && h.provision);
}

export interface MirrorResult {
  /** Harness ids whose config changed. Empty when nothing needed doing. */
  changed: string[];
  servers: string[];
}

/**
 * Mirror the repo's servers into this folder's harnesses. Never throws for one harness's
 * failure — that harness is skipped and retried on the next call; the state file is written
 * only when every target took the change.
 */
export async function mirrorRepoServers(
  cwd: string,
  registry: readonly Harness[] = HARNESSES,
): Promise<MirrorResult> {
  const servers = readRepoServers(cwd);
  const targets = targetHarnesses(cwd, registry);
  const ids = targets.map((h) => h.id).sort();
  const hash = createHash('sha256')
    .update(JSON.stringify([servers, ids]))
    .digest('hex');
  const prior = readState(cwd);
  if (prior?.hash === hash) return { changed: [], servers: servers.map((s) => s.name) };
  // Nothing to mirror into and nothing mirrored before: leave the folder untouched.
  if (!prior && (targets.length === 0 || servers.length === 0))
    return { changed: [], servers: servers.map((s) => s.name) };

  const names = servers.map((s) => s.name);
  const dropped = (prior?.servers ?? []).filter((n) => !names.includes(n));
  const changed: string[] = [];
  let ok = true;
  for (const h of targets) {
    try {
      if (dropped.length > 0)
        await h.unprovision?.(
          { servers: dropped, permissions: { allow: [], ask: [], deny: [] } },
          'local',
          cwd,
        );
      if (servers.length > 0)
        await h.provision!(
          { servers, permissions: { allow: [], ask: [], deny: [] } },
          'local',
          cwd,
        );
      if (servers.length > 0 || dropped.length > 0) changed.push(h.id);
    } catch {
      ok = false;
    }
  }
  if (!ok) return { changed, servers: names };

  const prov = loadProvisioning(cwd);
  if (prov.kind === 'valid') {
    const others = (prov.value.contributions[REPO_SERVERS_KEY] ?? []).filter(
      (e) => !ids.some((id) => e.startsWith(`repo-server ${id} `)),
    );
    const mine = ids.flatMap((id) => names.map((n) => `repo-server ${id} ${n}`));
    const contributions = { ...prov.value.contributions };
    if (others.length + mine.length > 0) contributions[REPO_SERVERS_KEY] = [...others, ...mine];
    else delete contributions[REPO_SERVERS_KEY];
    saveProvisioning(cwd, { ...prov.value, contributions });
  }
  writeJsonAtomic(statePath(cwd), { hash, harnesses: ids, servers: names });
  return { changed, servers: names };
}

/** The one line a caller prints, or '' when nothing changed. */
export function describeMirror(r: MirrorResult): string {
  if (r.changed.length === 0) return '';
  const what = r.servers.length > 0 ? r.servers.join(', ') : 'removed servers';
  return `musterd: mirrored the repo's MCP servers (${what}) into ${r.changed.join(', ')} — reload it to pick them up.`;
}
