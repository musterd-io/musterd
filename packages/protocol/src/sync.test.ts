import { describe, expect, it } from 'vitest';
import {
  SYNC_PUSH_MAX_BATCH,
  SeatMoveRequestSchema,
  SeatMovedSchema,
  SyncMoveRequestSchema,
  SyncEventSchema,
  SyncPullResponseSchema,
  SyncPushRequestSchema,
  SyncStreamFrameSchema,
  syncEventId,
  syncEventTeam,
} from './sync.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The daemon↔hub sync wire format (ADR 325), increment 3b-i.
 *
 * The property under test throughout: a replicated event names its sender the way the rest of the
 * team does — by seat name — because `messages.from_member` is a daemon-private id that means
 * something different on every machine.
 */

const envelope = {
  id: '01M-a',
  v: PROTOCOL_VERSION,
  team: 'revive',
  from: 'ada',
  to: { kind: 'team' as const },
  act: 'message' as const,
  body: 'hi',
  ts: 1000,
};

const event = {
  envelope,
  origin_node: '01M-node',
  origin_seq: 1,
  from_provenance: null,
};

describe('the sync wire format (ADR 325)', () => {
  it('carries the envelope whole — the seat NAME, never a member id', () => {
    const parsed = SyncEventSchema.parse(event);
    expect(parsed.envelope.from).toBe('ada');
    // Member ids are daemon-private anchors (ADR 325): shipping one would dangle on the receiver,
    // or — worse — resolve to a DIFFERENT seat that happens to hold that id there.
    expect(JSON.stringify(parsed)).not.toContain('from_member');
  });

  it('rejects an envelope the act rules reject — one vocabulary, not two', () => {
    // Composed from EnvelopeSchema on purpose. A restated shape would drift, and the drift would
    // read as "this act is replicable but unvalidated".
    expect(() =>
      SyncEventSchema.parse({ ...event, envelope: { ...envelope, act: 'not-an-act' } }),
    ).toThrow();
    // The slug regex comes along too.
    expect(() =>
      SyncEventSchema.parse({ ...event, envelope: { ...envelope, team: 'Not A Slug' } }),
    ).toThrow();
  });

  it('refuses origin_seq 0 — next_seq starts at 1, so seq 0 never exists', () => {
    expect(() => SyncEventSchema.parse({ ...event, origin_seq: 0 })).toThrow();
    expect(() => SyncEventSchema.parse({ ...event, origin_seq: -1 })).toThrow();
    expect(() => SyncEventSchema.parse({ ...event, origin_seq: 1.5 })).toThrow();
    expect(SyncEventSchema.parse({ ...event, origin_seq: 1 }).origin_seq).toBe(1);
  });

  it('requires an origin node — an unattributed event has nothing to order it by', () => {
    expect(() => SyncEventSchema.parse({ ...event, origin_node: '' })).toThrow();
    const { origin_node: _omitted, ...without } = event;
    expect(() => SyncEventSchema.parse(without)).toThrow();
  });

  it('carries provenance and drops created_at', () => {
    // Provenance is an attested fact about the event (ADR 131 §4) and survives replication, which
    // is the whole reason ADRs 101/158 stamp attestation at insert. `created_at` is local receipt
    // time: shipping the origin's would assert a falsehood about when THIS machine learned of it.
    expect(SyncEventSchema.parse({ ...event, from_provenance: 'wake' }).from_provenance).toBe(
      'wake',
    );
    const parsed = SyncEventSchema.parse({ ...event, created_at: 999 } as never);
    expect(parsed).not.toHaveProperty('created_at');
  });

  it('bounds the batch', () => {
    expect(() =>
      SyncPushRequestSchema.parse({ events: new Array(SYNC_PUSH_MAX_BATCH + 1).fill(event) }),
    ).toThrow();
    expect(
      SyncPushRequestSchema.parse({ events: new Array(SYNC_PUSH_MAX_BATCH).fill(event) }).events,
    ).toHaveLength(SYNC_PUSH_MAX_BATCH);
    // An empty push is legal and is what an idle daemon sends: nothing to say is not an error.
    expect(SyncPushRequestSchema.parse({ events: [] }).events).toEqual([]);
  });

  it('a presence event parses under its tag and keys on the audit row id (presence replication)', () => {
    const ev = SyncEventSchema.parse({
      kind: 'presence',
      team: 'bravo',
      origin_node: 'n1',
      origin_seq: 3,
      event: {
        id: 'a1',
        ts: 1,
        actor: 'ada',
        action: 'presence.attached',
        target: 'ada',
        result: 'allow',
        detail: { presence: 'p1' },
      },
    });
    expect(syncEventId(ev)).toBe('a1');
    expect(syncEventTeam(ev)).toBe('bravo');
  });

  it('the pull response carries node liveness, defaulting to none for an older hub', () => {
    expect(SyncPullResponseSchema.parse({ events: [], hub_seq_high: 0 }).nodes).toEqual([]);
    expect(
      SyncPullResponseSchema.parse({
        events: [],
        hub_seq_high: 0,
        nodes: [{ id: 'n', label: 'l', last_seen_at: null }],
      }).nodes,
    ).toHaveLength(1);
  });
});

describe('SyncStreamFrameSchema (ADR 552)', () => {
  it('parses head, ping and pong', () => {
    expect(SyncStreamFrameSchema.parse({ type: 'head', seq: 7 })).toEqual({ type: 'head', seq: 7 });
    expect(SyncStreamFrameSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(SyncStreamFrameSchema.parse({ type: 'pong' })).toEqual({ type: 'pong' });
  });

  it('refuses a head with a bad seq and an unknown frame', () => {
    expect(SyncStreamFrameSchema.safeParse({ type: 'head', seq: -1 }).success).toBe(false);
    expect(SyncStreamFrameSchema.safeParse({ type: 'head', seq: 1.5 }).success).toBe(false);
    expect(SyncStreamFrameSchema.safeParse({ type: 'push' }).success).toBe(false);
  });
});

describe('the seat move (ADR 696)', () => {
  it('a move names its machine; the forward adds the seat and the mover', () => {
    expect(SeatMoveRequestSchema.parse({ to: 'macbook-air-2.lan' })).toEqual({
      to: 'macbook-air-2.lan',
    });
    expect(SeatMoveRequestSchema.safeParse({ to: '' }).success).toBe(false);
    // Omitted: the destination is the machine whose daemon took the request.
    expect(SeatMoveRequestSchema.parse({})).toEqual({});
    expect(SyncMoveRequestSchema.safeParse({ to: 'nB', seat: 'wallow' }).success).toBe(false);
    expect(SyncMoveRequestSchema.safeParse({ seat: 'wallow', actor: 'nick' }).success).toBe(false);
    expect(
      SyncMoveRequestSchema.parse({ to: 'nB', seat: 'wallow', actor: 'nick', only: true }),
    ).toEqual({ to: 'nB', seat: 'wallow', actor: 'nick', only: true });
  });

  it('a result carries the revoked enrollment so the destination can re-enroll it', () => {
    const moved = {
      seat: 'wallow',
      kind: 'agent',
      from: [{ node_id: 'nA', label: 'mac.lan' }],
      to: { node_id: 'nB', label: 'macbook-air-2.lan' },
      residency: { harness: 'claude-code', host: 'mac.lan', policy: { cooldown_ms: 900000 } },
    };
    expect(SeatMovedSchema.parse(moved)).toEqual(moved);
    expect(SeatMovedSchema.parse({ ...moved, residency: null }).residency).toBeNull();
    expect(SeatMovedSchema.safeParse({ ...moved, kind: 'service' }).success).toBe(false);
  });
});
