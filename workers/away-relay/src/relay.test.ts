import { describe, expect, it } from 'vitest';
import {
  credentialHashFor,
  deliverVerdict,
  hashesEqual,
  parseDaemonFrame,
  providerRefFrom,
  reconcileRelayPending,
} from './relay.js';

describe('away relay pure rules (ADR 659)', () => {
  it('parses daemon frames and refuses malformed, wrong-version, and oversized ones', () => {
    expect(
      parseDaemonFrame(JSON.stringify({ protocol: 1, type: 'resolve', ask_ref: 'a1' }))?.type,
    ).toBe('resolve');
    expect(
      parseDaemonFrame(JSON.stringify({ protocol: 2, type: 'resolve', ask_ref: 'a1' })),
    ).toBeNull();
    expect(parseDaemonFrame('not json')).toBeNull();
    expect(
      parseDaemonFrame(
        JSON.stringify({
          protocol: 1,
          type: 'deliver',
          ask_ref: 'a1',
          dedupe_id: 'd1',
          expires_at: 10,
          post: { url: 'https://provider.example/post', body: 'x'.repeat(70_000) },
        }),
      ),
    ).toBeNull();
  });

  it('a duplicate dedupe id is the same delivery; expired and full relays refuse', () => {
    expect(deliverVerdict(true, 3, 9_999, 1_000)).toBe('duplicate');
    expect(deliverVerdict(false, 3, 500, 1_000)).toBe('expired');
    expect(deliverVerdict(false, 1_000, 9_999, 1_000)).toBe('full');
    expect(deliverVerdict(false, 3, 9_999, 1_000)).toBe('store');
  });

  it('the credential map authenticates by hash only; a bad map authenticates nobody', () => {
    const hash = 'a'.repeat(64);
    expect(credentialHashFor(JSON.stringify({ revive: hash }), 'revive')).toBe(hash);
    expect(credentialHashFor(JSON.stringify({ revive: hash }), 'other')).toBeNull();
    expect(credentialHashFor('not json', 'revive')).toBeNull();
    expect(credentialHashFor(JSON.stringify({ revive: 'clear-credential' }), 'revive')).toBeNull();
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, 'b'.repeat(64))).toBe(false);
  });

  it('provider coordinates come from the provider JSON; reconcile drops what the daemon dropped', () => {
    expect(providerRefFrom(JSON.stringify({ channel: 'C1', ts: '123.4' }))).toBe('C1:123.4');
    expect(providerRefFrom('not json')).toBeUndefined();
    expect(
      reconcileRelayPending(
        [
          { ask_ref: 'keep', dedupe_id: 'k', expires_at: 2_000 },
          { ask_ref: 'drop', dedupe_id: 'd', expires_at: 2_000 },
        ],
        [{ ask_ref: 'keep', dedupe_id: 'k', expires_at: 2_000 }],
        1_000,
      ),
    ).toEqual({ kept: ['keep'], dropped: ['drop'] });
  });
});
