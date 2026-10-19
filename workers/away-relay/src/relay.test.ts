import { describe, expect, it } from 'vitest';
import {
  credentialHashFor,
  deliverVerdict,
  hashesEqual,
  parseDaemonFrame,
  providerRefFrom,
  reconcileRelayPending,
  secondSocketVerdict,
  socketCredentialLive,
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
    expect(deliverVerdict('delivered', 3, 9_999, 1_000)).toBe('duplicate');
    expect(deliverVerdict('pending', 3, 9_999, 1_000)).toBe('duplicate');
    expect(deliverVerdict(null, 3, 500, 1_000)).toBe('expired');
    expect(deliverVerdict(null, 1_000, 9_999, 1_000)).toBe('full');
    expect(deliverVerdict(null, 3, 9_999, 1_000)).toBe('store');
  });

  it('a failed delivery is re-sent on re-push, not answered with the stored failure', () => {
    // ADR 659 §2: a retry is the daemon's decision, re-pushed — buildRelayPending makes the
    // dedupe id stable per ask+channel, so without this the stored ok:false would be final.
    expect(deliverVerdict('failed', 3, 9_999, 1_000)).toBe('retry');
    expect(deliverVerdict('failed', 3, 500, 1_000)).toBe('expired');
  });

  it('a second live socket is refused; a rotated credential replaces the stale socket', () => {
    const current = 'a'.repeat(64);
    const rotated = 'b'.repeat(64);
    // Same credential as the live socket: a second daemon is refused, not substituted.
    expect(secondSocketVerdict(current, current, current)).toBe('refuse');
    // The operator rotated the map: the new credential takes over from the stale socket.
    expect(secondSocketVerdict(current, rotated, rotated)).toBe('replace');
    // A credential the map does not name never replaces anything.
    expect(secondSocketVerdict(current, rotated, current)).toBe('refuse');
    expect(secondSocketVerdict(current, null, current)).toBe('refuse');
  });

  it('a cross-team credential does not authorize another team', () => {
    const reviveHash = 'a'.repeat(64);
    const otherHash = 'b'.repeat(64);
    const map = JSON.stringify({ revive: reviveHash, other: otherHash });
    // Team "other"'s credential hash is not team "revive"'s: no match, no socket, no frames.
    expect(credentialHashFor(map, 'revive')).toBe(reviveHash);
    expect(hashesEqual(otherHash, credentialHashFor(map, 'revive')!)).toBe(false);
    expect(socketCredentialLive(otherHash, credentialHashFor(map, 'revive'))).toBe(false);
    expect(secondSocketVerdict(reviveHash, otherHash, credentialHashFor(map, 'revive'))).toBe(
      'refuse',
    );
  });

  it('a rotated or revoked socket no longer receives callbacks', () => {
    // The callback route runs this same check before forwarding: callback bodies carry ask
    // tokens, so a silent revoked socket must get a 503 (provider retries), never the body.
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    expect(socketCredentialLive(oldHash, oldHash)).toBe(true);
    expect(socketCredentialLive(oldHash, newHash)).toBe(false);
    expect(socketCredentialLive(oldHash, credentialHashFor(JSON.stringify({}), 'revive'))).toBe(
      false,
    );
  });

  it("rotation or revocation refuses the old socket's next frame", () => {
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    expect(socketCredentialLive(oldHash, oldHash)).toBe(true);
    // Rotated: the map now names the new hash.
    expect(socketCredentialLive(oldHash, newHash)).toBe(false);
    // Revoked: the map names nothing for this team any more.
    expect(socketCredentialLive(oldHash, null)).toBe(false);
    expect(socketCredentialLive(null, newHash)).toBe(false);
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
