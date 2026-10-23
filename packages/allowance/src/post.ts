import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where a good read posts (ADR 723). Team from `MUSTERD_TEAM`, else `workspace.json` (team and
 * server only), else the one team in `~/.musterd/config.json` `bindings`. Several teams and no
 * workspace file means no post. A server that is not loopback needs `MUSTERD_CREDENTIAL`.
 * `knownIdentities` is never read. `binding.json` is never read.
 */

export interface AllowanceTarget {
  server: string;
  team: string;
  credential: string | null;
}

export function teamsFromConfig(config: unknown): string[] {
  if (config === null || typeof config !== 'object') return [];
  const bindings = (config as Record<string, unknown>)['bindings'];
  if (bindings === null || typeof bindings !== 'object') return [];
  const teams: string[] = [];
  for (const value of Object.values(bindings as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const team = (value as Record<string, unknown>)['team'];
    if (typeof team === 'string' && team.trim() !== '') teams.push(team.trim());
  }
  return teams;
}

/** `team` and `server` only. Any other key on the file, including a secret, is dropped. */
export function workspaceFromFile(body: unknown): { team?: string; server?: string } | null {
  if (body === null || typeof body !== 'object') return null;
  const row = body as Record<string, unknown>;
  const team = typeof row['team'] === 'string' ? row['team'].trim() : '';
  const server = typeof row['server'] === 'string' ? row['server'].trim() : '';
  if (team === '' && server === '') return null;
  return {
    ...(team !== '' ? { team } : {}),
    ...(server !== '' ? { server } : {}),
  };
}

function isLoopback(server: string): boolean {
  try {
    const host = new URL(server).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function allowanceTarget(opts: {
  env: NodeJS.ProcessEnv;
  workspace: { team?: string; server?: string } | null;
  teamsOnMachine: readonly string[];
}): AllowanceTarget | null {
  const envTeam = opts.env['MUSTERD_TEAM']?.trim() ?? '';
  const workspaceTeam = opts.workspace?.team?.trim() ?? '';
  let team = envTeam || workspaceTeam;
  if (team === '') {
    const distinct = [...new Set(opts.teamsOnMachine.map((name) => name.trim()).filter(Boolean))];
    if (distinct.length !== 1) return null;
    team = distinct[0]!;
  }
  const server =
    opts.env['MUSTERD_SERVER']?.trim() || opts.workspace?.server?.trim() || 'http://127.0.0.1:4849';
  const credential = opts.env['MUSTERD_CREDENTIAL']?.trim() || null;
  if (!isLoopback(server) && !credential) return null;
  return { server, team, credential };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function findWorkspace(cwd: string): Promise<{ team?: string; server?: string } | null> {
  let dir = cwd;
  for (let i = 0; i < 32; i++) {
    const spec = workspaceFromFile(await readJson(join(dir, '.musterd', 'workspace.json')));
    if (spec?.team) return spec;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function discoverAllowanceTarget(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  configPath: string;
}): Promise<AllowanceTarget | null> {
  const workspace = await findWorkspace(opts.cwd);
  const config = workspace?.team ? null : await readJson(opts.configPath);
  return allowanceTarget({
    env: opts.env,
    workspace,
    teamsOnMachine: teamsFromConfig(config),
  });
}

/** Post the snapshot. A failure is the caller's to swallow; this does not throw on a bad target. */
export async function publishAllowance(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  configPath: string;
  body: unknown;
  fetchSub: typeof fetch;
}): Promise<void> {
  const target = await discoverAllowanceTarget(opts);
  if (!target || opts.body === null) return;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.credential) headers['authorization'] = `Bearer ${target.credential}`;
  const url = `${target.server.replace(/\/$/, '')}/teams/${encodeURIComponent(target.team)}/allowance`;
  await opts.fetchSub(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(1500),
  });
}
