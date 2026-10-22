import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadToolkit, parseToolkit, type Toolkit } from './toolkit.js';
import { provisionToolkitIntoHarnesses } from './toolkitProvision.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-toolkit-provision-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const iosLike = (): Toolkit =>
  parseToolkit({
    toolkit: 'ios-like',
    charter: 'test',
    tools: {
      mcp_servers: [
        { name: 'expo', url: 'https://mcp.expo.dev/mcp' },
        { name: 'xcodebuild', command: 'npx', args: ['-y', 'xcodebuildmcp@latest', 'mcp'] },
      ],
      permissions: { allow: ['Read'], ask: [], deny: [] },
    },
  });

describe('provisionToolkitIntoHarnesses (ADR 708)', () => {
  it('provisions every named harness that can, in the target cwd', async () => {
    const outcomes = await provisionToolkitIntoHarnesses(iosLike(), ['opencode', 'cursor'], dir);
    expect(outcomes.map((o) => o.harness)).toEqual(['opencode', 'cursor']);
    for (const o of outcomes) {
      expect(o.servers).toEqual(['expo', 'xcodebuild']);
      expect(o.error).toBeUndefined();
    }
    const oc = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(oc.mcp['expo']).toEqual({ type: 'remote', url: 'https://mcp.expo.dev/mcp' });
    const cu = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cu.mcpServers['expo']).toEqual({ url: 'https://mcp.expo.dev/mcp' });
    expect(process.cwd()).not.toBe(dir); // the caller's cwd is restored
  });

  it('reports an unknown harness instead of failing the others', async () => {
    const outcomes = await provisionToolkitIntoHarnesses(iosLike(), ['nope', 'opencode'], dir);
    expect(outcomes[0]).toMatchObject({ harness: 'nope', servers: [] });
    expect(outcomes[0]!.error).toContain('unknown harness');
    expect(outcomes[0]!.skipped).toEqual(['expo', 'xcodebuild']);
    expect(outcomes[1]!.servers).toEqual(['expo', 'xcodebuild']);
  });

  it('does nothing for no toolkit, or a toolkit with nothing to provision', async () => {
    expect(await provisionToolkitIntoHarnesses(undefined, ['opencode'], dir)).toEqual([]);
    const empty = parseToolkit({ toolkit: 'empty', charter: 'test' });
    expect(await provisionToolkitIntoHarnesses(empty, ['opencode'], dir)).toEqual([]);
    expect(existsSync(join(dir, '.opencode', 'opencode.json'))).toBe(false);
  });

  it('writes the ios toolkit into grok, codex, opencode, and cursor without dropping an existing server', async () => {
    mkdirSync(join(dir, '.grok'), { recursive: true });
    writeFileSync(
      join(dir, '.grok', 'config.toml'),
      '[mcp_servers.musterd]\ncommand = "node"\nargs = ["bin.js"]\n\n[mcp_servers.musterd.env]\nMUSTERD_TEAM = "fixture"\n\n[permission]\nallow = [\n  "Read",\n]\n',
    );
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      join(dir, '.codex', 'config.toml'),
      '[mcp_servers.musterd]\ncommand = "node"\nargs = ["bin.js"]\n',
    );
    const ios = loadToolkit(dir, 'ios');
    const outcomes = await provisionToolkitIntoHarnesses(
      ios,
      ['grok', 'codex', 'opencode', 'cursor'],
      dir,
    );
    expect(outcomes.map((o) => o.harness)).toEqual(['grok', 'codex', 'opencode', 'cursor']);
    for (const o of outcomes) {
      expect(o.error).toBeUndefined();
      expect(o.servers).toEqual(['expo', 'xcodebuild', 'apple-docs']);
    }
    const grok = readFileSync(join(dir, '.grok', 'config.toml'), 'utf8');
    expect(grok.match(/\[permission\]/g)).toHaveLength(1);
    expect(grok).toContain('"Read"');
    expect(grok).toContain('[mcp_servers.musterd]');
    expect(grok).toContain('MUSTERD_TEAM');
    expect(grok).toContain('url = "https://mcp.expo.dev/mcp"');
    expect(grok).toContain('xcodebuildmcp@latest');
    expect(grok).toContain('@kimsungwhee/apple-docs-mcp@latest');
    const codex = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('[mcp_servers.musterd]');
    expect(codex).toContain('url = "https://mcp.expo.dev/mcp"');
    expect(codex).toContain('xcodebuildmcp@latest');
    const oc = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')) as {
      mcp: Record<string, { type?: string; url?: string; command?: string | string[] }>;
    };
    expect(oc.mcp['expo']).toEqual({ type: 'remote', url: 'https://mcp.expo.dev/mcp' });
    expect(oc.mcp['xcodebuild']).toMatchObject({
      type: 'local',
      command: ['npx', '-y', 'xcodebuildmcp@latest', 'mcp'],
    });
    expect(oc.mcp['apple-docs']).toMatchObject({
      type: 'local',
      command: ['npx', '-y', '@kimsungwhee/apple-docs-mcp@latest'],
    });
    const cu = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url?: string; command?: string }>;
    };
    expect(cu.mcpServers['expo']).toEqual({ url: 'https://mcp.expo.dev/mcp' });
    expect(cu.mcpServers['xcodebuild']).toMatchObject({ command: 'npx' });
    expect(cu.mcpServers['apple-docs']).toMatchObject({ command: 'npx' });
  });

  it('writes the ios toolkit into muse settings under XDG_CONFIG_HOME', async () => {
    const prev = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = dir;
    try {
      const [outcome] = await provisionToolkitIntoHarnesses(loadToolkit(dir, 'ios'), ['muse'], dir);
      expect(outcome).toMatchObject({
        harness: 'muse',
        servers: ['expo', 'xcodebuild', 'apple-docs'],
      });
      expect(outcome!.error).toBeUndefined();
      const settings = JSON.parse(readFileSync(join(dir, 'muse', 'settings.json'), 'utf8')) as {
        mcpServers: Record<string, { transport?: string; url?: string; command?: string }>;
      };
      expect(settings.mcpServers['expo']).toMatchObject({
        transport: 'http',
        url: 'https://mcp.expo.dev/mcp',
      });
      expect(settings.mcpServers['xcodebuild']).toMatchObject({
        transport: 'stdio',
        command: 'npx',
      });
      expect(settings.mcpServers['apple-docs']).toMatchObject({
        transport: 'stdio',
        command: 'npx',
      });
    } finally {
      if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = prev;
    }
  });

  it('reports claude-code as three servers or an error, and does not require a config file', async () => {
    const [outcome] = await provisionToolkitIntoHarnesses(
      loadToolkit(dir, 'ios'),
      ['claude-code'],
      dir,
    );
    expect(outcome!.harness).toBe('claude-code');
    if (outcome!.error) expect(outcome!.error.length).toBeGreaterThan(0);
    else expect(outcome!.servers).toEqual(['expo', 'xcodebuild', 'apple-docs']);
  });
});
