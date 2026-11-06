import { describe, expect, it } from 'vitest';
import {
  reconcileRelayPending,
  RelayAppBodyFrameSchema,
  RelayDaemonFrameSchema,
  RelayServerFrameSchema,
  RELAY_PING,
  RELAY_PONG,
  RELAY_PROTOCOL_VERSION,
} from './relay.js';

describe('away relay heartbeat (ADR 756)', () => {
  it('the fixed ping and pong texts are the schema frames at this protocol version', () => {
    expect(RelayDaemonFrameSchema.parse(JSON.parse(RELAY_PING)).type).toBe('ping');
    expect(RelayServerFrameSchema.parse(JSON.parse(RELAY_PONG)).type).toBe('pong');
    expect(JSON.parse(RELAY_PING).protocol).toBe(RELAY_PROTOCOL_VERSION);
  });
});

describe('away relay frames (ADR 659)', () => {
  it('parses each daemon frame and refuses a wrong version or shape', () => {
    expect(
      RelayDaemonFrameSchema.parse({
        protocol: RELAY_PROTOCOL_VERSION,
        type: 'reconcile',
        pending: [{ ask_ref: 'a1', dedupe_id: 'a1:slack', expires_at: 10 }],
      }).type,
    ).toBe('reconcile');
    expect(
      RelayDaemonFrameSchema.safeParse({ protocol: 2, type: 'resolve', ask_ref: 'a1' }).success,
    ).toBe(false);
    expect(
      RelayDaemonFrameSchema.safeParse({
        protocol: RELAY_PROTOCOL_VERSION,
        type: 'deliver',
        ask_ref: 'a1',
        dedupe_id: 'd1',
        expires_at: 10,
        post: { url: 'not a url', body: 'x' },
      }).success,
    ).toBe(false);
    // An install_state frame may carry the mint-registered Cloud destination.
    const hash = 'a'.repeat(64);
    expect(
      RelayDaemonFrameSchema.parse({
        protocol: RELAY_PROTOCOL_VERSION,
        type: 'install_state',
        state_hash: hash,
        destination: 'https://cloud.example',
      }),
    ).toMatchObject({ type: 'install_state', destination: 'https://cloud.example' });
    expect(
      RelayDaemonFrameSchema.safeParse({
        protocol: RELAY_PROTOCOL_VERSION,
        type: 'install_state',
        state_hash: hash,
        destination: 'x'.repeat(257),
      }).success,
    ).toBe(false);
    // No frame may carry a credential-shaped field past the boundary.
    expect(
      RelayServerFrameSchema.safeParse({
        protocol: RELAY_PROTOCOL_VERSION,
        type: 'callback',
        ask_ref: 'a1',
        body: 'payload',
      }).success,
    ).toBe(true);
  });

  it('reconcile keeps only rows the daemon still stands behind and unexpired', () => {
    const relay = [
      { ask_ref: 'live', dedupe_id: 'l', expires_at: 2_000 },
      { ask_ref: 'gone', dedupe_id: 'g', expires_at: 2_000 },
      { ask_ref: 'stale', dedupe_id: 's', expires_at: 500 },
    ];
    const daemon = [
      { ask_ref: 'live', dedupe_id: 'l', expires_at: 2_000 },
      { ask_ref: 'stale', dedupe_id: 's', expires_at: 500 },
    ];
    expect(reconcileRelayPending(relay, daemon, 1_000)).toEqual({
      kept: ['live'],
      dropped: ['gone', 'stale'],
    });
  });
});

describe('app_body ended (ADR 802)', () => {
  it('an app_body may say the binding ended; an unknown value is refused', () => {
    const base = { protocol: 1, type: 'app_body', request_id: 'r', sealed: null };
    expect(RelayAppBodyFrameSchema.safeParse({ ...base, ended: 'superseded' }).success).toBe(true);
    expect(RelayAppBodyFrameSchema.safeParse({ ...base, ended: 'revoked' }).success).toBe(true);
    expect(RelayAppBodyFrameSchema.safeParse(base).success).toBe(true);
    expect(RelayAppBodyFrameSchema.safeParse({ ...base, ended: 'gone' }).success).toBe(false);
  });
});

describe('app_nudge carries nothing but where to push (ADR 819)', () => {
  const nudge = (over: Record<string, unknown> = {}) => ({
    protocol: RELAY_PROTOCOL_VERSION,
    type: 'app_nudge',
    binding: 'b1',
    push: { token: 'a'.repeat(64), environment: 'production' },
    dedupe_id: 'nudge:b1:1',
    ...over,
  });

  it('round-trips through the daemon frame union', () => {
    expect(RelayDaemonFrameSchema.parse(nudge())).toEqual(nudge());
  });

  it('refuses any content riding it', () => {
    expect(RelayDaemonFrameSchema.safeParse(nudge({ sealed: { enc: 'e', ct: 'c' } })).success).toBe(
      false,
    );
    expect(RelayDaemonFrameSchema.safeParse(nudge({ title: 'landed X' })).success).toBe(false);
  });
});
