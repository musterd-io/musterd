import type { LaneDetail } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { registerLanes } from './lanes.js';

/**
 * ADR 582 §4 on the MCP surface: `lane_board {q:<lane id>}` is one lane in full — there is no
 * `lane_show` tool, because one argument reaches it without a tool's worth of standing context.
 * Done when an acceptor can review and reply from this one result.
 */

type Handler = (args: any) => Promise<{ content: { text: string }[] }>;

function laneBoard(client: any): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _schema: unknown, h: Handler) => {
      if (name === 'lane_board') handler = h;
    },
  };
  registerLanes(server as any, client);
  return handler!;
}

const DETAIL: LaneDetail = {
  lane: {
    id: '01M4VKS6SFNNN5TMWQR4NJ6TXT',
    team: 'dawn',
    project: 'runtime',
    title: 'find-work 4',
    detail: 'one call for a lane',
    owner_seat: 'TJ',
    role: null,
    scope: ['packages/mcp/src/tools/**'],
    depends_on: [],
    branch: 'feat/lane-show',
    goal_id: 'find-work',
    risk: [],
    merged: { pr: 2630, sha: 'abcdef1234567890', authorized_by: 'nick', verification: 'ancestor' },
    state: 'awaiting_acceptance',
    created_by: 'izzo',
    created_at: 0,
    claimed_at: 0,
    resolved_at: null,
    updated_at: 0,
  } as LaneDetail['lane'],
  warnings: [],
  history: [
    { ts: Date.UTC(2026, 9, 13, 9, 0), action: 'lane.opened', actor: 'izzo' },
    {
      ts: Date.UTC(2026, 9, 15, 10, 0),
      action: 'lane.claimed',
      actor: 'TJ',
      owner: 'TJ',
      kind: 'claim',
    },
    {
      ts: Date.UTC(2026, 9, 15, 10, 5),
      action: 'lane.state_changed',
      actor: 'TJ',
      from: 'claimed',
      to: 'active',
    },
  ],
  acceptance_ask: { id: '01M50ASK000000000000000000', to: 'schmidt' },
};

describe('lane_board {q} (ADR 582 §4)', () => {
  it('a lone id answers with the lane in full, ask id included', async () => {
    const asked: string[] = [];
    const client = {
      laneShow: async (id: string) => {
        asked.push(id);
        return DETAIL;
      },
      laneBoard: async () => {
        throw new Error('the board is not read for an id');
      },
    };
    const out = (await laneBoard(client)({ q: '01m4vks6sf' })).content[0]!.text;
    expect(asked).toEqual(['01M4VKS6SF']);
    expect(out).toContain('01M4VKS6SFNNN5TMWQR4NJ6TXT [awaiting_acceptance] "find-work 4"');
    expect(out).toContain('brief: one call for a lane');
    expect(out).toContain('merged: #2630 abcdef1234 ancestor authorized by nick');
    expect(out).toContain("reply_to:'01M50ASK000000000000000000'");
    expect(out).toContain('→ schmidt');
    expect(out).toContain('2026-10-15 10:00 TJ claimed by TJ');
    expect(out).toContain('2026-10-15 10:05 TJ claimed → active');
  });

  it('any other query is a search over the board, passed on as typed', async () => {
    const asked: unknown[] = [];
    const client = {
      laneShow: async () => {
        throw new Error('not reached');
      },
      laneBoard: async (q: { q?: string }) => {
        asked.push(q.q);
        return { lanes: [DETAIL.lane], warnings: [] };
      },
    };
    for (const q of ['goal:launch', 'standard', 'sync', 'area:ui goal:launch']) {
      const out = (await laneBoard(client)({ q })).content[0]!.text;
      expect(out).toContain('01M4VKS6SFNNN5TMWQR4NJ6TXT [awaiting_acceptance]');
    }
    expect(asked).toEqual(['goal:launch', 'standard', 'sync', 'area:ui goal:launch']);
  });

  it('says so when nothing matches the query', async () => {
    const client = {
      laneShow: async () => {
        throw new Error('not reached');
      },
      laneBoard: async () => ({ lanes: [], warnings: [] }),
    };
    const out = (await laneBoard(client)({ q: 'sync' })).content[0]!.text;
    expect(out).toContain('no lanes match "sync"');
  });

  it('without q the board is unchanged', async () => {
    const client = {
      laneShow: async () => {
        throw new Error('not reached');
      },
      laneBoard: async () => ({ lanes: [DETAIL.lane], warnings: [] }),
    };
    const out = (await laneBoard(client)({})).content[0]!.text;
    expect(out).toContain('01M4VKS6SFNNN5TMWQR4NJ6TXT [awaiting_acceptance]');
    expect(out).not.toContain('history:');
  });
});
