import { describe, expect, it } from 'vitest';
import {
  HostProvisionReportBodySchema,
  HostProvisionSchema,
  HostProvisionsClaimBodySchema,
  HostProvisionsClaimResponseSchema,
  SponsoredAgentHostingSchema,
} from './hostProvisions.js';
import { WakeOrderSchema } from './residency.js';

describe('host provision schemas (ADR 463)', () => {
  const row = {
    id: '01ABC',
    team: 'acme',
    agent: 'dana-scout',
    sponsor: 'dana',
    host: 'dana-mbp',
    state: 'claimed',
    claimed_by: 'dana-mbp',
    claimed_at: 1,
    ready_at: null,
    failed_reason: null,
    created_at: 0,
  };
  it('round-trips a row and a claim response', () => {
    // `kind` and `move` default on parse: a payload from before they existed is a mint.
    expect(HostProvisionSchema.parse(row)).toEqual({ ...row, kind: 'mint', move: null });
    expect(HostProvisionsClaimResponseSchema.parse({ provisions: [row] }).provisions).toHaveLength(
      1,
    );
  });
  it('a move row keeps its harness, and a claim that omits kinds does not gain a default', () => {
    const move = {
      ...row,
      kind: 'move' as const,
      move: { harness: 'muse', policy: { cooldown_ms: 60_000 } },
    };
    expect(HostProvisionSchema.parse(move)).toEqual(move);
    expect(
      HostProvisionsClaimBodySchema.parse({ host: 'dana-mbp', kinds: ['mint', 'move'] }),
    ).toEqual({ host: 'dana-mbp', kinds: ['mint', 'move'] });
  });
  it('refuses an unknown state', () => {
    expect(HostProvisionSchema.safeParse({ ...row, state: 'running' }).success).toBe(false);
  });
  it('a failed report needs a reason; a ready report refuses one', () => {
    expect(HostProvisionReportBodySchema.safeParse({ state: 'failed' }).success).toBe(false);
    expect(HostProvisionReportBodySchema.safeParse({ state: 'ready', reason: 'x' }).success).toBe(
      false,
    );
    expect(HostProvisionReportBodySchema.parse({ state: 'failed', reason: 'clone' })).toEqual({
      state: 'failed',
      reason: 'clone',
    });
  });
  it('claim body bounds the host label', () => {
    expect(HostProvisionsClaimBodySchema.safeParse({ host: '' }).success).toBe(false);
    expect(HostProvisionsClaimBodySchema.safeParse({ host: 'x'.repeat(121) }).success).toBe(false);
    expect(HostProvisionsClaimBodySchema.parse({ host: 'dana-mbp' })).toEqual({ host: 'dana-mbp' });
  });
  it('hosting is sponsor_host or connect_link', () => {
    expect(SponsoredAgentHostingSchema.options).toEqual(['sponsor_host', 'connect_link']);
  });
  it('a wake order may carry reason provisioned, and nothing else', () => {
    const order = {
      lease_id: 'l',
      seat: 'dana-scout',
      act_id: 'a',
      act: 'message',
      sender: 'dana',
      lane: 'immediate',
      composed_line: 'x',
      expires_at: 1,
    };
    expect(WakeOrderSchema.parse({ ...order, reason: 'provisioned' }).reason).toBe('provisioned');
    expect(WakeOrderSchema.safeParse({ ...order, reason: 'other' }).success).toBe(false);
  });
  it('a provisioned wake carries no act (ADR 463 §2: no fake directed act); any other act-less one is refused', () => {
    const bare = {
      lease_id: 'l',
      seat: 'dana-scout',
      lane: 'immediate',
      derivation: 'immediate',
      composed_line: 'you were just created by dana',
      expires_at: 1,
    };
    expect(WakeOrderSchema.safeParse({ ...bare, reason: 'provisioned' }).success).toBe(true);
    expect(WakeOrderSchema.safeParse(bare).success).toBe(false);
    expect(
      WakeOrderSchema.safeParse({ ...bare, reason: 'provisioned', derivation: 'work_order' })
        .success,
    ).toBe(false);
  });
});
