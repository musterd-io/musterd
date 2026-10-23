import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { MusterdClient } from '../client.js';
import {
  isLaneResolve,
  MAX_INBOX_WAIT_MS,
  registerInboxCheck,
  resolveInboxWaitMs,
  waitForDirectedAct,
  waitForWake,
} from './inboxCheck.js';

type Handler = (args: any) => Promise<{ content: { text: string }[]; structuredContent?: any }>;

function capture(client: Partial<MusterdClient>): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: string, _schema: unknown, h: Handler) => {
      handler = h;
    },
  };
  registerInboxCheck(server as any, client as any);
  if (!handler) throw new Error('no handler registered');
  return handler;
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

const directed = makeEnvelope({
  id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
  team: 'dawn',
  from: 'nick',
  to: { kind: 'member', name: 'lazara' },
  act: 'message',
  body: 'partner done, fetch me',
  ts: 1000,
});

function fakeClient(over: Partial<MusterdClient>): Partial<MusterdClient> {
  return {
    joined: true,
    holdsSeat: true,
    lastJoinError: null,
    drainBuffer: () => [],
    markRead: (async () => undefined) as any,
    ...over,
  };
}

describe('resolveInboxWaitMs', () => {
  it('defaults to no block and converts seconds', () => {
    expect(resolveInboxWaitMs(undefined)).toBe(0);
    expect(resolveInboxWaitMs(0)).toBe(0);
    expect(resolveInboxWaitMs(5)).toBe(5_000);
  });

  it('clamps past the harness tool timeout', () => {
    expect(resolveInboxWaitMs(600)).toBe(MAX_INBOX_WAIT_MS);
  });

  it('rejects negative and non-finite waits', () => {
    expect(() => resolveInboxWaitMs(-1)).toThrow(/non-negative/);
    expect(() => resolveInboxWaitMs(Number.NaN)).toThrow(/non-negative/);
    expect(() => resolveInboxWaitMs(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
  });
});

describe('waitForDirectedAct', () => {
  it('resolves true on the first directed act and unsubscribes', async () => {
    let listener: ((env: any) => void) | undefined;
    const off = vi.fn();
    const client = {
      onDirected: (fn: (env: any) => void) => {
        listener = fn;
        return off;
      },
    };
    const pending = waitForDirectedAct(client as any, 5_000);
    listener!(directed);
    await expect(pending).resolves.toBe(true);
    expect(off).toHaveBeenCalledOnce();
  });

  it('resolves false on timeout', async () => {
    const client = { onDirected: () => () => undefined };
    await expect(waitForDirectedAct(client as any, 20)).resolves.toBe(false);
  });
});

describe('team_inbox_check wait', () => {
  it('returns at once when an act is already waiting, and lets go of its listener', async () => {
    const off = vi.fn();
    const handler = capture(
      fakeClient({
        onDirected: (() => off) as any,
        fetchInbox: (async () => ({ messages: [directed], cursor: null })) as any,
      }),
    );
    const started = Date.now();
    const r = await handler({ unread_only: true, limit: 50, wait: 30 });
    expect(text(r)).toContain('partner done');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(off).toHaveBeenCalledOnce();
  });

  // Review (big-body, 01M5JBSTS7): an act delivered after the empty pre-check started but before
  // the wait subscribed fired no listener, so the wait slept to its timeout. Armed first, it wakes.
  it('wakes on a directed act delivered while the pre-check is in flight (no lost wakeup)', async () => {
    let listener: ((env: any) => void) | undefined;
    let calls = 0;
    const handler = capture(
      fakeClient({
        onDirected: ((fn: (env: any) => void) => {
          listener = fn;
          return () => undefined;
        }) as any,
        fetchInbox: (async () => {
          calls++;
          if (calls === 1) {
            // The pre-check's read already happened server-side; the act lands in the gap.
            listener?.(directed);
            return { messages: [], cursor: null };
          }
          return { messages: [directed], cursor: null };
        }) as any,
      }),
    );
    const started = Date.now();
    const r = await handler({ unread_only: true, limit: 50, wait: 30 });
    expect(text(r)).toContain('partner done');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('wakes on the named lane resolving while the pre-check reads that lane', async () => {
    let deliver: ((env: any) => void) | undefined;
    const handler = capture(
      fakeClient({
        onDirected: (() => () => undefined) as any,
        onDelivery: ((fn: (env: any) => void) => {
          deliver = fn;
          return () => undefined;
        }) as any,
        laneShow: (async () => {
          // The lane read says active; its resolve broadcast arrives before the wait would subscribe.
          deliver?.(
            makeEnvelope({
              id: '01EEEEEEEEEEEEEEEEEEEEEEEE',
              team: 'dawn',
              from: 'nick',
              to: { kind: 'team' },
              act: 'message',
              body: '[lane] resolved "x"',
              ts: 1000,
              meta: { lane_resolve: { lane: 'L1', title: 'x', state: 'done' } },
            }),
          );
          return { lane: { state: 'active', branch: 'feat/holder-work' } };
        }) as any,
        fetchInbox: (async () => ({ messages: [], cursor: null })) as any,
      }),
    );
    const started = Date.now();
    const r = await handler({ unread_only: true, limit: 50, wait: 30, until_lane: 'L1' });
    expect(text(r)).toContain('wait woke: lane L1 resolved');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('blocks in one call until a directed act arrives, then returns it', async () => {
    let listener: ((env: any) => void) | undefined;
    let calls = 0;
    const handler = capture(
      fakeClient({
        onDirected: ((fn: (env: any) => void) => {
          listener = fn;
          return () => undefined;
        }) as any,
        fetchInbox: (async () => {
          calls++;
          return calls < 2
            ? { messages: [], cursor: null }
            : { messages: [directed], cursor: null };
        }) as any,
      }),
    );
    const started = Date.now();
    const pending = handler({ unread_only: true, limit: 50, wait: 30 });
    // Let the pre-check fetch resolve and the wait subscribe before delivering.
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener!(directed);
    const r = await pending;
    expect(text(r)).toContain('partner done');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out and returns the ordinary empty reply', async () => {
    const handler = capture(
      fakeClient({
        onDirected: (() => () => undefined) as any,
        fetchInbox: (async () => ({ messages: [], cursor: null })) as any,
      }),
    );
    const started = Date.now();
    const r = await handler({ unread_only: true, limit: 50, wait: 0.05 });
    expect(text(r)).toContain('no new messages');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('isLaneResolve reads only the daemon resolve broadcast for that lane', () => {
    const broadcast = makeEnvelope({
      id: '01BBBBBBBBBBBBBBBBBBBBBBBB',
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: '[lane] resolved "x"',
      ts: 1000,
      meta: { lane_resolve: { lane: 'L1', title: 'x', state: 'done' } },
    });
    expect(isLaneResolve(broadcast, 'L1')).toBe(true);
    expect(isLaneResolve(broadcast, 'L2')).toBe(false);
    expect(isLaneResolve(directed, 'L1')).toBe(false);
  });

  it('isLaneResolve also reads the ADR 724 directed "file is free" act for that lane', () => {
    const freed = makeEnvelope({
      id: '01DDDDDDDDDDDDDDDDDDDDDDDD',
      team: 'dawn',
      from: 'board',
      to: { kind: 'member', name: 'ada' },
      act: 'message',
      body: "[lane] bo's lane \"x\" is released: 'src/a.py' is free.",
      ts: 1000,
      meta: { lane_freed: { lane: 'L1', holder: 'bo', ended: 'released', paths: ['src/a.py'] } },
    });
    expect(isLaneResolve(freed, 'L1')).toBe(true);
    expect(isLaneResolve(freed, 'L2')).toBe(false);
  });

  it('waitForWake wakes on the named lane resolving, not on another lane', async () => {
    let deliver: ((env: any) => void) | undefined;
    const client = {
      onDirected: () => () => undefined,
      onDelivery: (fn: (env: any) => void) => {
        deliver = fn;
        return () => undefined;
      },
    };
    const pending = waitForWake(client as any, 5_000, 'L1');
    const other = makeEnvelope({
      id: '01CCCCCCCCCCCCCCCCCCCCCCCC',
      team: 'dawn',
      from: 'nick',
      to: { kind: 'team' },
      act: 'message',
      body: '[lane] resolved "y"',
      ts: 1000,
      meta: { lane_resolve: { lane: 'L2', title: 'y', state: 'done' } },
    });
    deliver!(other);
    const winner = await Promise.race([
      pending.then(() => 'woke'),
      new Promise((r) => setTimeout(() => r('still waiting'), 30)),
    ]);
    expect(winner).toBe('still waiting');
    deliver!({ ...other, meta: { lane_resolve: { lane: 'L1', title: 'x', state: 'done' } } });
    await expect(pending).resolves.toMatchObject({ woke: 'lane' });
  });

  it('until_lane wakes with the holder branch and needs no partner message', async () => {
    let deliver: ((env: any) => void) | undefined;
    let laneShows = 0;
    const handler = capture(
      fakeClient({
        onDirected: (() => () => undefined) as any,
        onDelivery: ((fn: (env: any) => void) => {
          deliver = fn;
          return () => undefined;
        }) as any,
        laneShow: (async () => ({
          lane: { state: laneShows++ === 0 ? 'active' : 'done', branch: 'feat/holder-work' },
        })) as any,
        fetchInbox: (async () => ({ messages: [], cursor: null })) as any,
      }),
    );
    const pending = handler({ unread_only: true, limit: 50, wait: 30, until_lane: 'L1' });
    await vi.waitFor(() => expect(deliver).toBeDefined());
    deliver!(
      makeEnvelope({
        id: '01DDDDDDDDDDDDDDDDDDDDDDDD',
        team: 'dawn',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: '[lane] resolved "x"',
        ts: 1000,
        meta: { lane_resolve: { lane: 'L1', title: 'x', state: 'done' } },
      }),
    );
    const r = await pending;
    expect(text(r)).toContain('wait woke: lane L1 resolved');
    expect(text(r)).toContain('holder branch feat/holder-work');
  });

  it('until_lane already done returns at once with its branch', async () => {
    const off = vi.fn();
    const handler = capture(
      fakeClient({
        onDirected: (() => () => undefined) as any,
        onDelivery: (() => off) as any,
        laneShow: (async () => ({
          lane: { state: 'done', branch: 'feat/holder-work' },
        })) as any,
        fetchInbox: (async () => ({ messages: [], cursor: null })) as any,
      }),
    );
    const r = await handler({ unread_only: true, limit: 50, wait: 30, until_lane: 'L1' });
    expect(text(r)).toContain('holder branch feat/holder-work');
    expect(off).toHaveBeenCalledOnce();
  });

  it('rejects an invalid wait instead of blocking', async () => {
    const handler = capture(
      fakeClient({
        fetchInbox: (async () => ({ messages: [], cursor: null })) as any,
      }),
    );
    const r = await handler({ unread_only: true, limit: 50, wait: -1 });
    expect(text(r)).toContain("Can't wait");
  });
});
