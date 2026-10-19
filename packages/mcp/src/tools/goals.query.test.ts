import { describe, expect, it } from 'vitest';
import { registerGoals } from './goals.js';

/**
 * ADR 582 §1 on the MCP surface: `team_goals {q}` is one query over the Goals — bare words over the
 * id, the title and the story, plus `status:`. The query goes to the daemon, which reads it under
 * the seat's own authority.
 */

type Handler = (args: any) => Promise<{ content: { text: string }[] }>;

function teamGoals(client: any): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _schema: unknown, h: Handler) => {
      if (name === 'team_goals') handler = h;
    },
  };
  registerGoals(server as any, client);
  return handler!;
}

const GOAL = {
  id: 'find-work',
  title: 'Finding work on the board',
  wave: null,
  depends_on: [],
  declared_by: 'nick',
  declared_at: 0,
  status: 'in-flight',
  epoch: 0,
};

describe('team_goals {q} (ADR 582 §1)', () => {
  it('passes the query on and renders what came back', async () => {
    const asked: unknown[] = [];
    const client = {
      goals: async (q?: string) => {
        asked.push(q);
        return { goals: [GOAL] };
      },
    };
    const out = (await teamGoals(client)({ q: 'status:in-flight' })).content[0]!.text;
    expect(asked).toEqual(['status:in-flight']);
    expect(out).toContain('find-work [in-flight] "Finding work on the board"');
  });

  it('reads the whole board with no query', async () => {
    const asked: unknown[] = [];
    const client = {
      goals: async (q?: string) => {
        asked.push(q);
        return { goals: [GOAL] };
      },
    };
    const out = (await teamGoals(client)({})).content[0]!.text;
    expect(asked).toEqual([undefined]);
    expect(out).toContain('find-work [in-flight]');
  });

  it('says so when nothing matches', async () => {
    const client = {
      goals: async () => ({ goals: [] }),
    };
    const out = (await teamGoals(client)({ q: 'absent' })).content[0]!.text;
    expect(out).toContain('no goals match "absent"');
  });
});
