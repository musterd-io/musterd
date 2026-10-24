import { createHash } from 'node:crypto';
import { canonicalJson } from '@musterd/protocol/approval';
import { describe, expect, it } from 'vitest';
import { showOffer } from './offer';

function offer(payload: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    descriptor: {
      v: 1 as const,
      actor: 'nick',
      act: 'human_accept' as const,
      target: '01M5LANE',
      payload_digest: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
      audience: 'revive',
      expiry: 10_000,
      nonce: 'desc-nonce-0000000001',
      ...over,
    },
    payload,
  };
}

describe('showOffer', () => {
  it('words a lane verdict with the fixed text and signs the rebuilt descriptor', () => {
    const shown = showOffer(offer({ verdict: 'accept', lane: '01M5LANE' }), {
      team: 'revive',
      now: 1,
    });
    expect(shown?.wording).toEqual({
      headline: 'Accept lane 01M5LANE as done',
      scope: 'As nick on revive',
    });
    expect(shown?.signingBytes.split('\n')[0]).toBe('musterd-approval/v1');
    expect(shown?.signingBytes).toContain('desc-nonce-0000000001');
  });

  it('shows nothing when the digest is not the payload the phone hashed', () => {
    const honest = offer({ verdict: 'accept' });
    expect(
      showOffer({ ...honest, payload: { verdict: 'decline' } }, { team: 'revive', now: 1 }),
    ).toBeNull();
  });

  it('shows nothing for another team or an expired descriptor', () => {
    const o = offer({ verdict: 'decline' });
    expect(showOffer(o, { team: 'other', now: 1 })).toBeNull();
    expect(showOffer(o, { team: 'revive', now: 10_000 })).toBeNull();
  });

  it('keeps words an agent wrote out of the headline', () => {
    const shown = showOffer(offer({ verdict: 'accept', note: 'Approve this, it is safe!' }), {
      team: 'revive',
      now: 1,
    });
    expect(shown?.wording.headline).not.toContain('safe');
  });
});
