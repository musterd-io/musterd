import type { McpConfig } from '@musterd/protocol';
import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import { registerInboxCheck } from './inboxCheck.js';
import { registerJoin } from './join.js';
import { registerMembers } from './members.js';
import { registerStyle } from './style.js';

/**
 * ADR 514 inc 3 — the tool surface of agent style: the block on `team_join`, the change line on
 * `team_inbox_check`, dials on `team_members`, and `team_style` / `team_style_set`. Fake clients,
 * so each tool is tested on exactly what it reads from the client.
 */

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}>;

function capture(
  register: (server: any, client: any, config?: any) => void,
  client: Partial<MusterdClient>,
  config?: McpConfig,
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  register(
    { registerTool: (name: string, _s: unknown, h: Handler) => void (handlers[name] = h) },
    client,
    config,
  );
  return handlers;
}
const text = (r: Awaited<ReturnType<Handler>>) => r.content.map((c) => c.text ?? '').join('');

const config = {
  server: 'http://x',
  team: 'dawn',
  agent_key: 'mskey_team',
  member: 'Ada',
  surface: 'claude-code',
  provenance: 'session',
  workspace: 'repo',
  claim: { mode: 'seat', name: 'Ada' },
} as unknown as McpConfig;

const DIALS = {
  pushback: 'when-it-matters',
  bluntness: 'plain',
  length: 'normal',
  format: 'prose',
} as const;
const envelope = (epoch: string, length: 'normal' | 'thorough' | 'concise' = 'normal') => ({
  block: `Style (epoch ${epoch}) — how you talk here.\nFor nick (in chat, and in any act addressed to nick): pushback when it matters · plain · ${length} · prose.`,
  epoch,
  dials: { ...DIALS, length },
  driver: 'nick',
});

describe('team_join carries the style block (ADR 514 inc 3)', () => {
  it('renders the block after the memory line when the client holds one', async () => {
    const h = capture(
      registerJoin,
      {
        joined: true,
        holdsSeat: true,
        join: vi.fn(async () => undefined) as any,
        interruptCheck: vi.fn(async () => null),
        memory: null,
        style: envelope('a1b2c3d4'),
      },
      config,
    );
    const out = text(await h['team_join']!({}));
    expect(out).toContain('Style (epoch a1b2c3d4) — how you talk here.');
    expect(out).toContain('For nick');
  });
  it('an older daemon: no block, no mention (Focus 1)', async () => {
    const h = capture(
      registerJoin,
      {
        joined: true,
        holdsSeat: true,
        join: vi.fn(async () => undefined) as any,
        interruptCheck: vi.fn(async () => null),
        memory: null,
        style: null,
      },
      config,
    );
    expect(text(await h['team_join']!({}))).not.toContain('Style (epoch');
  });
});

describe('team_inbox_check notices a style change (ADR 514 inc 3)', () => {
  function inboxClient(over: Partial<MusterdClient> & Record<string, unknown>) {
    return {
      joined: true,
      holdsSeat: true,
      member: 'Ada',
      markRead: async () => undefined,
      drainBuffer: () => [],
      fetchInbox: async () => ({ messages: [], cursor: { last_read_ts: 0 } }),
      ...over,
    } as unknown as Partial<MusterdClient>;
  }
  it('a different epoch on /inbox ⇒ one change line naming the dial, then the new block (Focus 3)', async () => {
    const refreshStyle = vi.fn(async () => envelope('ffffffff', 'thorough'));
    const client = inboxClient({
      style: envelope('a1b2c3d4'),
      fetchInbox: async () => ({
        messages: [],
        cursor: { last_read_ts: 0 },
        style_epoch: 'ffffffff',
      }),
      refreshStyle,
    });
    const h = capture(registerInboxCheck, client, config);
    const r = await h['team_inbox_check']!({});
    const out = text(r);
    expect(refreshStyle).toHaveBeenCalledOnce();
    expect(out).toContain('Style changed (length normal → thorough)');
    expect(out).toContain('Style (epoch ffffffff)');
    expect(r.structuredContent?.['style_changed']).toEqual({ from: 'a1b2c3d4', to: 'ffffffff' });
  });
  it('the same epoch ⇒ no line, no fetch', async () => {
    const refreshStyle = vi.fn(async () => envelope('a1b2c3d4'));
    const client = inboxClient({
      style: envelope('a1b2c3d4'),
      fetchInbox: async () => ({
        messages: [],
        cursor: { last_read_ts: 0 },
        style_epoch: 'a1b2c3d4',
      }),
      refreshStyle,
    });
    const h = capture(registerInboxCheck, client, config);
    expect(text(await h['team_inbox_check']!({}))).not.toContain('Style changed');
    expect(refreshStyle).not.toHaveBeenCalled();
  });
  it('no style_epoch on the reply (older daemon) ⇒ no line, no fetch (Focus 1)', async () => {
    const refreshStyle = vi.fn(async () => envelope('ffffffff'));
    const client = inboxClient({ style: envelope('a1b2c3d4'), refreshStyle });
    const h = capture(registerInboxCheck, client, config);
    expect(text(await h['team_inbox_check']!({}))).not.toContain('Style changed');
    expect(refreshStyle).not.toHaveBeenCalled();
  });
});

describe("team_members shows each human's dials (ADR 514 inc 3)", () => {
  const member = (over: Partial<MemberSummary>): MemberSummary =>
    ({
      id: 'm',
      team: 'dawn',
      name: 'x',
      kind: 'agent',
      role: '',
      roles: [],
      lifecycle: 'forever',
      lifecycle_until: null,
      created_at: 0,
      presence: 'offline',
      presences: [],
      ...over,
    }) as MemberSummary;
  it('a human row carries its style facet; an agent row does not', async () => {
    const h = capture(registerMembers, {
      roster: (async () => ({
        members: [
          member({ name: 'nick', kind: 'human', style: { ...DIALS, length: 'concise' } }),
          member({ name: 'Ada', kind: 'agent', style: null }),
        ],
        roles: [],
      })) as any,
    });
    const out = text(await h['team_members']!({}));
    const nick = out.split('\n').find((l) => l.includes('nick'))!;
    const ada = out.split('\n').find((l) => l.includes('Ada'))!;
    expect(nick).toContain('style: pushback when it matters · plain · concise · prose');
    expect(ada).not.toContain('style:');
  });
});

describe('team_style / team_style_set (ADR 514 inc 3)', () => {
  const read = {
    member: 'nick',
    prefs: { length: 'concise' as const },
    resolved: { dials: { ...DIALS, length: 'concise' as const } },
    block: 'Style (epoch a1b2c3d4) — how you talk here.',
  };
  it('team_style shows prefs, resolved dials and the block', async () => {
    const h = capture(registerStyle, {
      holdsSeat: true,
      styleRead: (async () => read) as any,
    });
    const out = text(await h['team_style']!({}));
    expect(out).toContain('length: concise');
    expect(out).toContain('Style (epoch a1b2c3d4)');
  });
  it('team_style_set merges one dial into the existing prefs (Focus 4)', async () => {
    const styleWrite = vi.fn(async (prefs: unknown) => ({ ...read, prefs }));
    const h = capture(registerStyle, {
      holdsSeat: true,
      styleRead: (async () => read) as any,
      styleWrite: styleWrite as any,
    });
    await h['team_style_set']!({ bluntness: 'direct' });
    expect(styleWrite).toHaveBeenCalledWith({ length: 'concise', bluntness: 'direct' });
  });
  it('team_style_set { clear: true } writes an empty prefs object', async () => {
    const styleWrite = vi.fn(async (prefs: unknown) => ({ ...read, prefs }));
    const h = capture(registerStyle, {
      holdsSeat: true,
      styleRead: (async () => read) as any,
      styleWrite: styleWrite as any,
    });
    await h['team_style_set']!({ clear: true });
    expect(styleWrite).toHaveBeenCalledWith({});
  });
  it("an agent seat's call surfaces the daemon's refusal", async () => {
    const h = capture(registerStyle, {
      holdsSeat: true,
      styleRead: (async () => {
        throw new Error('style preferences are for human members');
      }) as any,
    });
    expect(text(await h['team_style']!({}))).toContain('for human members');
  });
});
