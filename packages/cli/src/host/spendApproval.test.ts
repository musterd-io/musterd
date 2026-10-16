import { askContract, makeEnvelope, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  SPEND_APPROVAL_WAKE_ENDED,
  armSpendApproval,
  awaitSpendApproval,
  spendApprovalAskBody,
  type AwaitSpendApprovalInput,
  type SpendApprovalSeat,
} from './spendApproval.js';

const WINDOW = askContract('blocking').timeout_ms;

function reply(act: 'accept' | 'decline' | 'wait', askId: string, until?: string): Envelope {
  return makeEnvelope({
    id: `${act}-${askId}-${until ?? 'x'}`,
    team: 'dawn',
    from: 'nick',
    to: { kind: 'team' },
    act,
    body: act,
    meta:
      act === 'wait'
        ? { in_reply_to: askId, ask_ref: askId, until: until ?? '1h' }
        : { in_reply_to: askId },
  });
}

/** A clock the waiter sleeps by jumping, and a seat whose inbox is a function of what it sent. */
function world(opts: {
  pollMs?: number;
  inbox: (sent: Envelope[]) => Envelope[];
  onSend?: (envelope: Envelope, ac: AbortController) => void;
}) {
  const sent: Envelope[] = [];
  let t = 0;
  let n = 0;
  const ac = new AbortController();
  const seat: SpendApprovalSeat = {
    send: async (envelope) => {
      sent.push(envelope);
      opts.onSend?.(envelope, ac);
      return {};
    },
    inbox: async () => ({ messages: opts.inbox(sent) }),
  };
  const input: AwaitSpendApprovalInput = {
    team: 'dawn',
    from: 'scout',
    seat: 'scout',
    leaseId: 'L1',
    spentUsd: 1.25,
    thresholdUsd: 1,
    laneId: '01LANE',
    signal: ac.signal,
    seatClient: seat,
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error('aborted');
      t += ms;
    },
    pollMs: opts.pollMs ?? 1_000,
    mintId: () => `id${++n}`,
  };
  return {
    sent,
    ac,
    run: (over: Partial<AwaitSpendApprovalInput> = {}) => awaitSpendApproval({ ...input, ...over }),
  };
}

describe('armSpendApproval', () => {
  it('arms a positive threshold for an agent or a service, and nothing else', () => {
    expect(armSpendApproval('agent', 1.5)).toBe(1.5);
    expect(armSpendApproval('service', 2)).toBe(2);
    expect(armSpendApproval('human', 1.5)).toBeUndefined();
    expect(armSpendApproval(undefined, 1.5)).toBeUndefined();
    expect(armSpendApproval('agent', null)).toBeUndefined();
    expect(armSpendApproval('agent', Number.NaN)).toBeUndefined();
    expect(armSpendApproval('agent', Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(armSpendApproval('agent', 0)).toBeUndefined();
    expect(armSpendApproval('agent', -1)).toBeUndefined();
  });
});

describe('spendApprovalAskBody', () => {
  it('names the seat, the lease, the spent dollars, the threshold, and the lane when set', () => {
    expect(
      spendApprovalAskBody({ seat: 'scout', leaseId: 'L1', spentUsd: 1.25, thresholdUsd: 1 }),
    ).toBe('scout lease L1 spent $1.2500, approval $1.0000');
    const withLane = spendApprovalAskBody({
      seat: 'scout',
      leaseId: 'L1',
      spentUsd: 1.25,
      thresholdUsd: 1,
      laneId: '01LANE',
    });
    expect(withLane).toBe('scout lease L1 spent $1.2500, approval $1.0000, lane 01LANE');
    expect(withLane.toLowerCase()).not.toContain('prompt');
  });
});

describe('awaitSpendApproval', () => {
  it('sends one blocking approve ask and returns accept', async () => {
    const w = world({ inbox: (sent) => [reply('accept', sent[0]!.id)] });
    await expect(w.run()).resolves.toBe('accept');
    const asks = w.sent.filter((e) => e.act === 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.meta).toMatchObject({ species: 'approve', tier: 'blocking' });
    expect(asks[0]!.body).toContain('scout');
    expect(asks[0]!.body).toContain('lease L1');
    expect(asks[0]!.body).toContain('lane 01LANE');
    expect(asks[0]!.to).toEqual({ kind: 'team' });
  });

  it('returns decline', async () => {
    const w = world({ inbox: (sent) => [reply('decline', sent[0]!.id)] });
    await expect(w.run()).resolves.toBe('decline');
    expect(w.sent.filter((e) => e.act === 'ask')).toHaveLength(1);
  });

  it('a wait of 1m extends once; the same wait does not keep the clock moving', async () => {
    let polls = 0;
    let abort = (): void => undefined;
    const w = world({
      pollMs: 2 * 60_000,
      inbox: (sent) => {
        polls += 1;
        if (polls >= 3) abort();
        return [reply('wait', sent[0]!.id, '1m')];
      },
    });
    abort = () => w.ac.abort();
    await expect(w.run()).resolves.toBe('wake_ended');
    expect(w.sent.filter((e) => e.act === 'ask')).toHaveLength(1);
    expect(w.sent.filter((e) => e.act === 'status_update')).toHaveLength(1);
    expect(w.sent.find((e) => e.act === 'status_update')!.meta).toMatchObject({
      ask_ref: 'id1',
      ask_outcome: 'held',
    });
  });

  it('an indefinite wait extends by one blocking window', async () => {
    let polls = 0;
    let abort = (): void => undefined;
    const w = world({
      pollMs: WINDOW - 1_000,
      inbox: (sent) => {
        polls += 1;
        if (polls === 1) return [];
        if (polls >= 4) abort();
        return [reply('wait', sent[0]!.id, 'indefinite')];
      },
    });
    abort = () => w.ac.abort();
    await expect(w.run()).resolves.toBe('wake_ended');
    expect(w.sent.filter((e) => e.act === 'status_update')).toHaveLength(0);
    expect(w.sent.filter((e) => e.act === 'ask')).toHaveLength(1);
  });

  it('on the blocking timeout records ask.held, re-notifies, and does not accept', async () => {
    const w = world({
      pollMs: WINDOW,
      inbox: () => [],
      onSend: (envelope, ac) => {
        if (envelope.act === 'status_update') ac.abort();
      },
    });
    await expect(w.run()).resolves.toBe('wake_ended');
    const asks = w.sent.filter((e) => e.act === 'ask');
    const held = w.sent.filter((e) => e.act === 'status_update');
    const notes = w.sent.filter((e) => e.act === 'message');
    expect(asks).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(held[0]!.meta).toMatchObject({ ask_ref: asks[0]!.id, ask_outcome: 'held' });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(asks[0]!.body);
    expect(w.sent.filter((e) => e.act === 'accept')).toHaveLength(0);
  });

  it('a later accept after the held record returns accept', async () => {
    const w = world({
      pollMs: WINDOW,
      inbox: (sent) =>
        sent.some((e) => e.act === 'status_update') ? [reply('accept', sent[0]!.id)] : [],
    });
    await expect(w.run()).resolves.toBe('accept');
    expect(w.sent.filter((e) => e.act === 'ask')).toHaveLength(1);
    expect(w.sent.filter((e) => e.act === 'status_update')).toHaveLength(1);
  });

  it('abort before the ask sends nothing and returns wake_ended', async () => {
    const w = world({ inbox: () => [] });
    w.ac.abort();
    await expect(w.run()).resolves.toBe('wake_ended');
    expect(w.sent).toHaveLength(0);
  });

  it('a thrown ask send declines', async () => {
    const w = world({ inbox: () => [] });
    const seat: SpendApprovalSeat = {
      send: async () => {
        throw new Error('down');
      },
      inbox: async () => ({ messages: [] }),
    };
    await expect(w.run({ seatClient: seat })).resolves.toBe('decline');
  });

  it('an inbox throw keeps the call held', async () => {
    let polls = 0;
    const sent: Envelope[] = [];
    const ac = new AbortController();
    const seat: SpendApprovalSeat = {
      send: async (envelope) => {
        sent.push(envelope);
        return {};
      },
      inbox: async () => {
        polls += 1;
        if (polls > 2) ac.abort();
        throw new Error('inbox down');
      },
    };
    const result = await awaitSpendApproval({
      team: 'dawn',
      from: 'scout',
      seat: 'scout',
      leaseId: 'L1',
      spentUsd: 1,
      thresholdUsd: 1,
      signal: ac.signal,
      seatClient: seat,
      now: () => 0,
      sleep: async (_ms, signal) => {
        if (signal.aborted) throw new Error('aborted');
      },
      pollMs: 1_000,
      mintId: () => `id${sent.length + 1}`,
    });
    expect(result).toBe('wake_ended');
    expect(sent.filter((e) => e.act === 'ask')).toHaveLength(1);
    expect(sent.filter((e) => e.act === 'accept' || e.act === 'decline')).toHaveLength(0);
  });
});

describe('the wake-ended sentence', () => {
  it('fits the wake report reason field', () => {
    expect(SPEND_APPROVAL_WAKE_ENDED).toBe('wake ended during the spend approval hold');
    expect(SPEND_APPROVAL_WAKE_ENDED.length).toBeLessThanOrEqual(200);
  });
});
