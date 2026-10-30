/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { MusterdClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { registerQuestion } from './question.js';

type Handler = (args: any) => Promise<{ content: { text: string }[] }>;

function capture(lanes: Array<{ id: string; state: string; branch?: string | null }> = []) {
  const sent: Envelope[] = [];
  let handler: Handler | undefined;
  const client = {
    holdsSeat: true,
    roster: async () => ({
      members: [
        { name: 'nick', kind: 'human' },
        { name: 'ryder', kind: 'agent' },
      ],
    }),
    laneBoard: async () => ({ lanes, warnings: [] }),
    sendEnvelope: async (e: Envelope) => {
      sent.push(e);
      return {};
    },
    markSeen: () => {},
  } as unknown as MusterdClient;
  const server = {
    registerTool: (_n: string, _s: unknown, h: Handler) => {
      handler = h;
    },
  };
  registerQuestion(server as any, client, { team: 'revive', member: 'ryder' } as McpConfig, {
    branchOf: async () => 'perf/ledger-rows-cache',
  });
  if (!handler) throw new Error('no handler registered');
  return { handler, sent };
}

describe('team_question (ADR 773)', () => {
  it('sends one question ask, no tier, and tells the seat to end its turn', async () => {
    const { handler, sent } = capture();
    const res = await handler({
      to: 'nick',
      text: 'Re-run the red shard, or fix the flake first?',
      options: [{ label: 'Re-run', consequence: 'Fastest' }, { label: 'Fix the flake' }],
    });
    expect(sent).toHaveLength(1);
    const meta = sent[0]!.meta as Record<string, any>;
    expect(sent[0]!.act).toBe('ask');
    expect(meta['species']).toBe('consult');
    expect(meta['tier']).toBeUndefined();
    expect(meta['question'].options[0].label).toBe('Re-run');
    expect(meta['question'].audience).toBe('addressee');
    expect(res.content[0]!.text).toContain('End your turn now');
  });

  it('defaults the context to the one live claimed lane and its branch', async () => {
    const { handler, sent } = capture([
      { id: 'L1', state: 'active', branch: 'feat/x' },
      { id: 'L0', state: 'done' },
    ]);
    await handler({ to: 'nick', text: 'ok?' });
    expect((sent[0]!.meta as any).question.context).toEqual({ lane: 'L1', branch: 'feat/x' });
  });

  it('with no single lane, the workspace branch still rides', async () => {
    const { handler, sent } = capture([
      { id: 'L1', state: 'active' },
      { id: 'L2', state: 'claimed' },
    ]);
    await handler({ to: 'nick', text: 'ok?' });
    expect((sent[0]!.meta as any).question.context).toEqual({ branch: 'perf/ledger-rows-cache' });
  });

  it('refuses a seat as the addressee, and sends nothing', async () => {
    const { handler, sent } = capture();
    const res = await handler({ to: 'ryder', text: 'ok?' });
    expect(res.content[0]!.text).toContain('is a seat, not a person');
    expect(sent).toEqual([]);
  });

  it("'@team' and anyone:true open the question to every person", async () => {
    const { handler, sent } = capture();
    await handler({ to: '@team', text: 'ok?' });
    await handler({ to: 'nick', text: 'ok?', anyone: true, blocking: true });
    expect(sent[0]!.to).toEqual({ kind: 'team' });
    expect((sent[0]!.meta as any).question.audience).toBe('team');
    expect((sent[1]!.meta as any).question).toMatchObject({ audience: 'team', blocking: true });
  });
});
