import { describe, expect, it } from 'vitest';
import {
  APP_ROSTER_MAX,
  AppCallbackSchema,
  AppDeliverySchema,
  AppQuickActionSchema,
  appAnswerSigningBytes,
  appQuestionAnswerSigningBytes,
  appQuickActionSigningBytes,
} from './appChannel.js';

const sealed = { v: 1, enc: 'abc', ct: 'def' } as const;
const body = {
  v: 1,
  action: 'start',
  nonce: 'n'.repeat(22),
  ts: 1_793_728_000_000,
  key: 'question',
  signature: 'sig',
} as const;

describe('the phone quick action (ADR 791)', () => {
  it('rides a callback whose ref is the nonce', () => {
    const cb = {
      app: 1,
      kind: 'quick_action',
      binding: 'b1',
      ref: body.nonce,
      expires_at: 1,
      sealed,
    };
    expect(AppCallbackSchema.parse(cb)).toEqual(cb);
    expect(AppCallbackSchema.safeParse({ ...cb, ref: 'short' }).success).toBe(false);
  });

  it('names one seat and one of the four actions; there is no Start everyone', () => {
    expect(AppQuickActionSchema.safeParse({ ...body, seat: 'ryder' }).success).toBe(true);
    expect(AppQuickActionSchema.safeParse(body).success).toBe(false);
    expect(
      AppQuickActionSchema.safeParse({ ...body, seat: 'ryder', action: 'check_pr' }).success,
    ).toBe(true);
    expect(AppQuickActionSchema.safeParse({ ...body, seat: 'ryder', action: 'nap' }).success).toBe(
      false,
    );
  });

  it('signs under its own domain tag', () => {
    const one = appQuickActionSigningBytes({
      team: 'revive',
      binding: 'b1',
      seat: 'ryder',
      action: 'resume',
      nonce: body.nonce,
      ts: body.ts,
    });
    expect(one.split('\n')).toEqual([
      'musterd-app-quick-action/v1',
      'revive',
      'b1',
      'ryder',
      'resume',
      body.nonce,
      String(body.ts),
    ]);
    const others = [
      appQuestionAnswerSigningBytes({
        team: 'revive',
        binding: 'b1',
        ask: 'ryder',
        token: 't',
        nonce: body.nonce,
        answer: { choice: 0 },
      }),
      appAnswerSigningBytes({
        team: 'revive',
        binding: 'b1',
        ask: 'ryder',
        token: 't',
        decision: 'approve',
        nonce: body.nonce,
        reported: false,
      }),
    ];
    for (const other of others) expect(other.split('\n')[0]).not.toBe(one.split('\n')[0]);
  });

  it('answers with the seat and started or offline, never capped', () => {
    const result = {
      v: 1,
      kind: 'quick_action_result',
      team: 'revive',
      binding: 'b1',
      nonce: body.nonce,
      action: 'start',
      seat: 'ryder',
      result: 'offline',
    };
    expect(AppDeliverySchema.parse(result)).toEqual(result);
    expect(AppDeliverySchema.safeParse({ ...result, result: 'capped' }).success).toBe(false);
  });

  it('sends a roster of seats with online, wakeable and one lane', () => {
    const roster = {
      v: 1,
      kind: 'roster',
      team: 'revive',
      binding: 'b1',
      ts: 5,
      seats: [
        { seat: 'ryder', online: true, wakeable: true, lane: { id: 'L1', title: 'Fix it' } },
        { seat: 'sloane', online: false, wakeable: false, lane: null },
      ],
    };
    expect(AppDeliverySchema.parse(roster)).toEqual(roster);
    const many = Array.from({ length: APP_ROSTER_MAX + 1 }, (_, i) => ({
      seat: `s${i}`,
      online: false,
      wakeable: false,
      lane: null,
    }));
    expect(AppDeliverySchema.safeParse({ ...roster, seats: many }).success).toBe(false);
  });
});
