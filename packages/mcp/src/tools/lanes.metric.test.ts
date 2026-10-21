import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { buildMcpServer } from '../index.js';

/**
 * ADR 673 §2: a seat declares what an experiment measures through `lane_update {metric}`. A metric
 * whose `source` names a number the daemon derives daily fills the chart on its own, so the tool
 * must carry `source` through to the daemon — without it a seat could only ever declare a manual
 * metric, and the derived sources had no way in (lane 01M5G8NKG4).
 */

const config = {
  server: 'http://127.0.0.1:1',
  team: 'dawn',
  agent_key: 'mskey_unused',
  surface: 'claude-code',
  provenance: 'session',
  workspace: 'repo',
  claim: { mode: 'seat', name: 'Ada' },
  bindingDir: process.cwd(),
} as McpConfig;

async function call(args: Record<string, unknown>) {
  const updateLane = vi.fn().mockRejectedValue(new Error('stop after the patch'));
  const client = { member: 'Ada', updateLane } as unknown as MusterdClient;
  const mcp = buildMcpServer(client, config, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const harness = new Client({ name: 'metric-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), harness.connect(clientTransport)]);
  try {
    const result = await harness.callTool({ name: 'lane_update', arguments: args });
    return { updateLane, result };
  } finally {
    await harness.close();
    await mcp.close();
  }
}

const metric = {
  name: 'wake latency p50',
  unit: 'ms',
  baseline: null,
  target: 5000,
  direction: 'down',
};

describe('lane_update metric.source (ADR 673 §2)', () => {
  it('carries a derived source through to the daemon', async () => {
    const { updateLane } = await call({
      id: 'lane-1',
      metric: { ...metric, source: 'wake_latency_p50_ms' },
    });
    expect(updateLane).toHaveBeenCalledWith(
      'lane-1',
      expect.objectContaining({
        metric: expect.objectContaining({ source: 'wake_latency_p50_ms' }),
      }),
    );
  });

  it('leaves source out when not given, so the daemon defaults it to manual', async () => {
    const { updateLane } = await call({ id: 'lane-1', metric });
    expect(updateLane.mock.calls[0]?.[1]?.metric).not.toHaveProperty('source');
  });

  it('refuses a source the protocol does not know, naming the known ones, before any call', async () => {
    const { updateLane, result } = await call({
      id: 'lane-1',
      metric: { ...metric, source: 'vibes' },
    });
    const content = result.content as { text?: string }[];
    expect(content[0]?.text).toContain('is not one of manual, wake_latency_p50_ms, dispute_rate');
    expect(updateLane).not.toHaveBeenCalled();
  });
});
