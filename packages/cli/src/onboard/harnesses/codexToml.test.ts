import { describe, expect, it } from 'vitest';
import {
  hasPlugin,
  hasServer,
  listServers,
  readPermissionProfile,
  readPlugin,
  readServer,
  readTopLevel,
  readServerEnv,
  removePermissionProfile,
  removePlugins,
  removeServers,
  renderPlugin,
  renderServer,
  upsertPermissionProfile,
  upsertPlugin,
  upsertServer,
} from './codexToml.js';

const USER = `# my codex config
model = "o3"

[tui]
theme = "dark"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

describe('renderServer', () => {
  it('renders a table + env subtable with TOML-quoted strings', () => {
    const out = renderServer('supabase', {
      command: 'npx',
      args: ['-y', '@supabase/mcp'],
      env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
    });
    expect(out).toContain('[mcp_servers.supabase]');
    expect(out).toContain('command = "npx"');
    expect(out).toContain('args = ["-y", "@supabase/mcp"]');
    expect(out).toContain('[mcp_servers.supabase.env]');
    expect(out).toContain('SUPABASE_ACCESS_TOKEN = "${SUPABASE_ACCESS_TOKEN}"');
  });

  it('omits the env subtable when there is no env', () => {
    expect(renderServer('x', { command: 'c', args: [], env: {} })).not.toContain('.env]');
  });

  it('escapes quotes and backslashes in values', () => {
    const out = renderServer('x', { command: 'a\\b"c', args: [], env: {} });
    expect(out).toContain('command = "a\\\\b\\"c"');
  });
});

describe('upsertServer', () => {
  it('adds a server additively, preserving all other content', () => {
    const out = upsertServer(USER, 'musterd', {
      command: 'node',
      args: ['/abs/index.js'],
      env: { MUSTERD_TOKEN: 'tok' },
    });
    expect(out).toContain('model = "o3"'); // user setting kept
    expect(hasServer(out, 'context7')).toBe(true); // user server kept
    expect(hasServer(out, 'musterd')).toBe(true);
    expect(out).toContain('theme = "dark"'); // [tui] kept
  });

  it('is per-server idempotent — re-adding replaces only that table', () => {
    let out = upsertServer(USER, 'musterd', { command: 'node', args: ['a'], env: {} });
    out = upsertServer(out, 'musterd', { command: 'node', args: ['b'], env: {} });
    expect(listServers(out).filter((s) => s === 'musterd')).toHaveLength(1);
    expect(out).toContain('args = ["b"]');
    expect(out).not.toContain('args = ["a"]');
    expect(hasServer(out, 'context7')).toBe(true);
  });

  it('writes into an empty config', () => {
    const out = upsertServer('', 'musterd', { command: 'node', args: [], env: {} });
    expect(out).toBe('[mcp_servers.musterd]\ncommand = "node"\nargs = []\n');
  });

  it('writes and reads back default_tools_approval_mode (ADR 495)', () => {
    const s = {
      command: 'node',
      args: ['/abs/index.js'],
      env: { MUSTERD_LAUNCH_SURFACE: 'codex' },
      default_tools_approval_mode: 'approve' as const,
    };
    const out = upsertServer(USER, 'musterd', s);
    expect(out).toContain('default_tools_approval_mode = "approve"');
    expect(readServer(out, 'musterd')).toEqual(s);
    // A table without the key reads back without it, so the fingerprint of an older entry differs.
    const bare = upsertServer(USER, 'musterd', { command: 'node', args: [], env: {} });
    expect(readServer(bare, 'musterd')).toEqual({ command: 'node', args: [], env: {} });
  });

  it("keeps a hand-added per-tool approval subtable when musterd's table is rewritten", () => {
    const hand = [
      '[mcp_servers.musterd]',
      'command = "node"',
      'args = ["a"]',
      '',
      '[mcp_servers.musterd.tools.team_join]',
      'approval_mode = "approve"',
      '',
    ].join('\n');
    const out = upsertServer(hand, 'musterd', {
      command: 'node',
      args: ['b'],
      env: {},
      default_tools_approval_mode: 'approve',
    });
    expect(out).toContain('[mcp_servers.musterd.tools.team_join]');
    expect(listServers(out).filter((s) => s === 'musterd')).toHaveLength(1);
  });

  it('refuses an approval mode Codex does not accept', () => {
    expect(() =>
      upsertServer('', 'musterd', {
        command: 'node',
        args: [],
        env: {},
        default_tools_approval_mode: 'bogus' as never,
      }),
    ).toThrow(/refusing to write an invalid Codex mcp_servers\.musterd/);
  });
});

describe('removeServers', () => {
  it('removes a server table (+ its .env) and leaves the rest intact', () => {
    const added = upsertServer(USER, 'musterd', {
      command: 'node',
      args: [],
      env: { K: 'v' },
    });
    const out = removeServers(added, ['musterd']);
    expect(hasServer(out, 'musterd')).toBe(false);
    expect(out).not.toContain('[mcp_servers.musterd.env]');
    expect(hasServer(out, 'context7')).toBe(true);
    expect(out).toContain('model = "o3"');
    expect(out).not.toMatch(/\n{3,}/); // no big gaps left behind
  });

  it('removes several at once and is a no-op for absent names', () => {
    const out = removeServers(USER, ['context7', 'nope']);
    expect(hasServer(out, 'context7')).toBe(false);
    expect(out).toContain('model = "o3"');
  });

  it('is a no-op on empty/whitespace input', () => {
    expect(removeServers('', ['x'])).toBe('');
    expect(removeServers('   \n', ['x'])).toBe('   \n');
  });
});

describe('listServers / hasServer', () => {
  it('lists server names from headers, ignoring .env subtables and other tables', () => {
    expect(listServers(USER)).toEqual(['context7']);
    const two = upsertServer(USER, 'musterd', { command: 'n', args: [], env: { A: 'b' } });
    expect(listServers(two).sort()).toEqual(['context7', 'musterd']);
  });
});

// The doctor could not see a baked value in `.codex/config.toml` at all, because nothing read the
// env subtable back — only Claude Code's `claude mcp get` was ever parsed (measured 2026-08-03).
describe('readServerEnv', () => {
  it("reads a server's env subtable back", () => {
    const toml = renderServer('musterd', {
      command: 'node',
      args: ['/x/bin.js'],
      env: { MUSTERD_SURFACE: 'codex', MUSTERD_AGENT_KEY: 'mskey_secret' },
    });
    expect(readServerEnv(toml, 'musterd')).toEqual({
      MUSTERD_SURFACE: 'codex',
      MUSTERD_AGENT_KEY: 'mskey_secret',
    });
  });

  it('returns an empty record for a server with no env, or one that is absent', () => {
    const bare = renderServer('musterd', { command: 'node', args: [], env: {} });
    expect(readServerEnv(bare, 'musterd')).toEqual({});
    expect(readServerEnv(bare, 'other')).toEqual({});
    expect(readServerEnv('', 'musterd')).toEqual({});
  });

  it("reads only the named server's env, never a neighbour's", () => {
    const toml =
      renderServer('musterd', { command: 'node', args: [], env: { MUSTERD_SURFACE: 'codex' } }) +
      '\n' +
      renderServer('other', { command: 'node', args: [], env: { MUSTERD_SURFACE: 'cursor' } });
    expect(readServerEnv(toml, 'musterd')).toEqual({ MUSTERD_SURFACE: 'codex' });
    expect(readServerEnv(toml, 'other')).toEqual({ MUSTERD_SURFACE: 'cursor' });
  });

  it('unescapes quoted values and tolerates a quoted key', () => {
    const toml = '[mcp_servers.musterd.env]\n"MUSTERD_DRIVER" = "a \\"quoted\\" name"\n';
    expect(readServerEnv(toml, 'musterd')).toEqual({ MUSTERD_DRIVER: 'a "quoted" name' });
  });
});

describe('Codex plugin tables (ADR 323)', () => {
  const ID = 'codex-security@openai-curated';

  it('renders a quoted [plugins."id"] table with enabled = true', () => {
    expect(renderPlugin(ID, { enabled: true })).toBe(
      `[plugins.${JSON.stringify(ID)}]\nenabled = true\n`,
    );
  });

  it('upserts additively and leaves mcp_servers + user settings intact', () => {
    const out = upsertPlugin(USER, ID, { enabled: true });
    expect(out).toContain('model = "o3"');
    expect(hasServer(out, 'context7')).toBe(true);
    expect(hasPlugin(out, ID)).toBe(true);
    expect(readPlugin(out, ID)).toEqual({ enabled: true });
  });

  it('removePlugins drops only that plugin table', () => {
    const added = upsertPlugin(USER, ID, { enabled: true });
    const out = removePlugins(added, [ID]);
    expect(hasPlugin(out, ID)).toBe(false);
    expect(hasServer(out, 'context7')).toBe(true);
    expect(out).toContain('model = "o3"');
  });
});

describe('the musterd permission profile (ADR 658)', () => {
  const deny = ['~/.musterd/musterd.db', '~/.musterd/note-key.json'];

  it('writes the profile and selects it, leaving every other byte alone', () => {
    const out = upsertPermissionProfile(USER, 'musterd', { deny, selected: true });
    expect(out.startsWith('default_permissions = "musterd"\n')).toBe(true);
    expect(out).toContain(USER.trim());
    expect(out).toContain('[permissions.musterd]\n');
    expect(out).toContain('extends = ":workspace"');
    expect(out).toContain('[permissions.musterd.filesystem]\n"~/.musterd/musterd.db" = "deny"\n');
    expect(readTopLevel(out, 'model')).toBe('o3');
    expect(readPermissionProfile(out, 'musterd')).toEqual({ deny, selected: true });
  });

  it('is idempotent, and an unselected write never adds default_permissions', () => {
    const once = upsertPermissionProfile(USER, 'musterd', { deny, selected: true });
    expect(upsertPermissionProfile(once, 'musterd', { deny, selected: true })).toBe(once);
    const quiet = upsertPermissionProfile(USER, 'musterd', { deny, selected: false });
    expect(quiet).not.toContain('default_permissions');
    expect(readPermissionProfile(quiet, 'musterd')).toEqual({ deny, selected: false });
  });

  it("removes its own tables and selection, never someone else's default_permissions", () => {
    const written = upsertPermissionProfile(USER, 'musterd', { deny, selected: true });
    expect(removePermissionProfile(written, 'musterd').trim()).toBe(USER.trim());
    const theirs = 'default_permissions = ":read-only"\n\n[tui]\ntheme = "dark"\n';
    expect(removePermissionProfile(theirs, 'musterd')).toContain(
      'default_permissions = ":read-only"',
    );
    expect(readPermissionProfile(USER, 'musterd')).toBeNull();
  });

  it('reads only top-level keys — a profile-scoped sandbox_mode is not one', () => {
    const toml = '[profiles.fast]\nsandbox_mode = "danger-full-access"\n';
    expect(readTopLevel(toml, 'sandbox_mode')).toBeNull();
    expect(readTopLevel('sandbox_mode = "workspace-write"\n', 'sandbox_mode')).toBe(
      'workspace-write',
    );
  });
});
