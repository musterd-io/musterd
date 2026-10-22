import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseToolkit, type Toolkit } from './toolkit.js';
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
});
