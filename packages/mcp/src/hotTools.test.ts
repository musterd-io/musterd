import { describe, expect, it } from 'vitest';
import { ALWAYS_LOAD_META_KEY, HOT_TOOLS, TOOL_NAMES } from './index.js';

/**
 * Lane 01M4S53E79: the hot tools carry Claude Code's per-tool upfront-load key on the real
 * `tools/list` listing, and nothing else does. Every always-loaded schema is standing context in
 * every turn, so the set is pinned rather than allowed to grow by accident.
 */
describe('hot tools load without a schema search', () => {
  it('marks exactly the hot tools with anthropic/alwaysLoad on the wire', async () => {
    const tools = await listedTools();
    const marked = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META_KEY] === true)
      .map((t) => t.name)
      .sort();
    expect(marked).toEqual([...HOT_TOOLS].sort());
  });

  it('every hot tool is a registered tool', () => {
    for (const name of HOT_TOOLS) expect(TOOL_NAMES).toContain(name);
  });
});

async function listedTools(): Promise<{ name: string; _meta?: Record<string, unknown> }[]> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { buildMcpServer } = await import('./index.js');
  const config = {
    server: 'http://127.0.0.1:1',
    team: 'dawn',
    agent_key: 'mskey_unused',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: process.cwd(),
  } as Parameters<typeof buildMcpServer>[1];
  const mcp = buildMcpServer({ member: 'Ada' } as Parameters<typeof buildMcpServer>[0], config, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'hot-tools', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  try {
    return (await harness.listTools()).tools as { name: string; _meta?: Record<string, unknown> }[];
  } finally {
    await harness.close();
    await mcp.close();
  }
}
