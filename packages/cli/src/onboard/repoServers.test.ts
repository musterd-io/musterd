import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codex } from './harnesses/codex.js';
import { opencode } from './harnesses/opencode.js';
import { loadProvisioning } from './manifest.js';
import {
  describeMirror,
  mirrorRepoServers,
  readRepoServers,
  REPO_SERVERS_KEY,
} from './repoServers.js';

/**
 * ADR 529 — the repo's `.mcp.json` servers reach the harnesses that don't read it, through the
 * real adapters into a real folder: added by name beside musterd's own entry, written once, and
 * removed again when the repo drops the server.
 */

let dir: string;

function writeMcpJson(servers: Record<string, unknown>): void {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function provisioned(desired: string[]): void {
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 3,
      toolkit: '',
      desired,
      contributions: {},
      provisionedAt: new Date(0).toISOString(),
    }),
  );
}

const opencodeCfg = () =>
  JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')) as {
    mcp: Record<string, { command: string[]; environment: Record<string, string> }>;
  };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repo-servers-'));
  mkdirSync(join(dir, 'packages', 'whiteboard', 'dist', 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'whiteboard', 'dist', 'mcp', 'index.js'), '');
  writeMcpJson({
    whiteboard: {
      command: 'node',
      args: ['packages/whiteboard/dist/mcp/index.js'],
      env: { WHITEBOARD_LINKED_BOARDS: 'team=docs/wireframes/team.squig.json' },
    },
    musterd: { command: 'node', args: ['x.js'] },
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRepoServers', () => {
  it('drops musterd, makes a folder-relative arg absolute, and leaves env alone', () => {
    expect(readRepoServers(dir)).toEqual([
      {
        name: 'whiteboard',
        command: 'node',
        args: [join(dir, 'packages/whiteboard/dist/mcp/index.js')],
        env: { WHITEBOARD_LINKED_BOARDS: 'team=docs/wireframes/team.squig.json' },
      },
    ]);
  });

  it('is empty without a .mcp.json', () => {
    rmSync(join(dir, '.mcp.json'));
    expect(readRepoServers(dir)).toEqual([]);
  });
});

describe('mirrorRepoServers', () => {
  it('writes the servers into an OpenCode folder beside musterd, once, and records them', async () => {
    provisioned(['opencode']);
    mkdirSync(join(dir, '.opencode'));
    writeFileSync(
      join(dir, '.opencode', 'opencode.json'),
      JSON.stringify({
        mcp: { musterd: { type: 'local', command: ['node', 'm.js'], enabled: true } },
      }),
    );

    const first = await mirrorRepoServers(dir, [opencode]);
    expect(first).toEqual({ changed: ['opencode'], servers: ['whiteboard'] });
    expect(describeMirror(first)).toContain('(whiteboard) into opencode');
    const cfg = opencodeCfg();
    expect(Object.keys(cfg.mcp).sort()).toEqual(['musterd', 'whiteboard']);
    expect(cfg.mcp['whiteboard']!.command).toEqual([
      'node',
      join(dir, 'packages/whiteboard/dist/mcp/index.js'),
    ]);
    const prov = loadProvisioning(dir);
    expect(prov.kind === 'valid' && prov.value.contributions[REPO_SERVERS_KEY]).toEqual([
      'repo-server opencode whiteboard',
    ]);

    // Nothing new: nothing written, nothing reported.
    expect(await mirrorRepoServers(dir, [opencode])).toEqual({
      changed: [],
      servers: ['whiteboard'],
    });
  });

  it('removes a server the repo dropped, and leaves musterd and the user’s own entries', async () => {
    provisioned(['codex']);
    mkdirSync(join(dir, '.codex'));
    writeFileSync(join(dir, '.codex', 'config.toml'), '[mcp_servers.mine]\ncommand = "x"\n');
    await mirrorRepoServers(dir, [codex]);
    expect(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.whiteboard]',
    );

    writeMcpJson({});
    const r = await mirrorRepoServers(dir, [codex]);
    expect(r.changed).toEqual(['codex']);
    const toml = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
    expect(toml).not.toContain('whiteboard');
    expect(toml).toContain('[mcp_servers.mine]');
    const prov = loadProvisioning(dir);
    expect(prov.kind === 'valid' && prov.value.contributions[REPO_SERVERS_KEY]).toBeUndefined();
  });

  it('touches nothing in a Claude Code-only folder — it reads .mcp.json itself', async () => {
    provisioned(['claude-code']);
    expect((await mirrorRepoServers(dir)).changed).toEqual([]);
  });
});
