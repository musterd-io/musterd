import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursor } from './cursor.js';

let cwd: string;
let origCwd: string;
const cfgPath = () => join(cwd, '.cursor', 'mcp.json');

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-cursorprov-'));
  process.chdir(cwd);
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('cursor.provision — remote servers (ADR 708)', () => {
  it('writes a remote server by url, additively, and unprovisions exactly it', async () => {
    await cursor.provision!({
      servers: [{ name: 'local-tool', command: 'npx', args: ['-y', 'tool@latest'], env: {} }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const result = await cursor.provision!({
      servers: [{ name: 'expo', url: 'https://mcp.expo.dev/mcp', args: [], env: {} }],
      permissions: { allow: [], ask: [], deny: [] },
    });
    expect(result.servers).toEqual(['expo']);
    const cfg = JSON.parse(readFileSync(cfgPath(), 'utf8')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(cfg.mcpServers['expo']).toEqual({ url: 'https://mcp.expo.dev/mcp' });
    expect(cfg.mcpServers['local-tool']).toMatchObject({ command: 'npx' });
    await cursor.unprovision!({
      servers: ['expo'],
      permissions: { allow: [], ask: [], deny: [] },
    });
    const after = JSON.parse(readFileSync(cfgPath(), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers['expo']).toBeUndefined();
    expect(after.mcpServers['local-tool']).toBeDefined();
  });
});
