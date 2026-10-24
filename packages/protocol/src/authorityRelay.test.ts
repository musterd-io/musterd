import { describe, expect, it } from 'vitest';
import { AuthorityRelayRequestSchema, AuthorityRelayResponseSchema } from './authorityRelay.js';

describe('authority relay wire contract (ADR 729)', () => {
  it('accepts a named key-list operation and rejects a generic proxy shape', () => {
    expect(
      AuthorityRelayRequestSchema.safeParse({ op: 'keys.list', actor: 'swetha' }).success,
    ).toBe(true);
    expect(
      AuthorityRelayRequestSchema.safeParse({
        op: 'http',
        method: 'POST',
        path: '/teams/revive/grants',
        body: {},
      }).success,
    ).toBe(false);
  });

  it('rejects unknown operations and extra request fields', () => {
    expect(
      AuthorityRelayRequestSchema.safeParse({ op: 'credential.mint', actor: 'swetha' }).success,
    ).toBe(false);
    expect(
      AuthorityRelayRequestSchema.safeParse({
        op: 'keys.list',
        actor: 'swetha',
        token: 'mscr_never-forward-this',
      }).success,
    ).toBe(false);
  });

  it('limits lane answer forwarding to a referenced ask and known answer fields', () => {
    expect(
      AuthorityRelayRequestSchema.safeParse({
        op: 'lane.answer',
        actor: 'swetha',
        ask_id: '01M5P5DPKC65K434AEN3P5P4QK',
        act: 'accept',
        body: 'Reviewed.',
      }).success,
    ).toBe(true);
    expect(
      AuthorityRelayRequestSchema.safeParse({
        op: 'lane.answer',
        actor: 'swetha',
        ask_id: '01M5P5DPKC65K434AEN3P5P4QK',
        act: 'accept',
        body: 'Reviewed.',
        path: '/teams/revive/messages',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed descriptor payload JSON at the protocol boundary', () => {
    expect(
      AuthorityRelayRequestSchema.safeParse({
        op: 'descriptor.create',
        actor: 'swetha',
        act: 'admin.roster',
        target: 'swetha',
        payload_json: '{broken',
      }).success,
    ).toBe(false);
  });

  it('rejects credential fields in otherwise valid operation responses', () => {
    expect(
      AuthorityRelayResponseSchema.safeParse({
        op: 'keys.list',
        keys: [],
        credential: 'mscr_must-not-cross',
      }).success,
    ).toBe(false);
    expect(AuthorityRelayResponseSchema.safeParse({ op: 'keys.list', keys: [] }).success).toBe(
      true,
    );
  });
});
