import { describe, expect, it } from 'vitest';
import {
  AppCallbackSchema,
  AppDeliverySchema,
  AppPollCloseSchema,
  AppPollOpenSchema,
  appPollCloseSigningBytes,
  appPollOpenSigningBytes,
} from './appChannel.js';

/** Twitch polls from the phone (ADR 807 §5): the app-channel callbacks and their signing bytes. */

const sealed = { v: 1, enc: 'abc', ct: 'def' } as const;
const spec = { question: 'What next?', options: ['Camera', 'Ask the team'], minutes: 5 };
const nonce = 'n'.repeat(22);

describe('the phone poll callbacks (ADR 807)', () => {
  it('ride callbacks whose ref is the nonce', () => {
    for (const kind of ['poll_open', 'poll_close'] as const) {
      const cb = { app: 1, kind, binding: 'b1', ref: nonce, expires_at: 1, sealed };
      expect(AppCallbackSchema.parse(cb)).toEqual(cb);
      expect(AppCallbackSchema.safeParse({ ...cb, ref: 'short' }).success).toBe(false);
    }
  });

  it('opens only with the Face ID key, and only a spec the daemon would accept', () => {
    const body = { v: 1, spec, nonce, ts: 1, signature: 'sig' };
    expect(AppPollOpenSchema.parse(body)).toEqual(body);
    // No key field: a poll opens on the Face ID signing key alone (ADR 807 §5 — credential_mint).
    expect(AppPollOpenSchema.safeParse({ ...body, key: 'question' }).success).toBe(false);
    expect(
      AppPollOpenSchema.safeParse({ ...body, spec: { ...spec, options: ['one'] } }).success,
    ).toBe(false);
  });

  it('closes with either phone key — ending mints nothing', () => {
    const body = {
      v: 1,
      poll_id: 'p'.repeat(26),
      how: 'end',
      nonce,
      ts: 1,
      key: 'question',
      signature: 'sig',
    };
    expect(AppPollCloseSchema.parse(body)).toEqual(body);
    expect(AppPollCloseSchema.safeParse({ ...body, how: 'reopen' }).success).toBe(false);
  });

  it('signs stable bytes under their own domain tags, the spec in a fixed order', () => {
    const open = appPollOpenSigningBytes({ team: 'revive', binding: 'b1', spec, nonce, ts: 7 });
    expect(open).toBe(
      [
        'musterd-app-poll-open/v1',
        'revive',
        'b1',
        '{"question":"What next?","options":["Camera","Ask the team"],"minutes":5}',
        nonce,
        '7',
      ].join('\n'),
    );
    // Key order in the caller's object does not change what is signed.
    expect(
      appPollOpenSigningBytes({
        team: 'revive',
        binding: 'b1',
        spec: { minutes: 5, options: ['Camera', 'Ask the team'], question: 'What next?' },
        nonce,
        ts: 7,
      }),
    ).toBe(open);
    expect(
      appPollCloseSigningBytes({
        team: 'revive',
        binding: 'b1',
        poll_id: 'P1',
        how: 'cancel',
        nonce,
        ts: 7,
      }),
    ).toBe(['musterd-app-poll-close/v1', 'revive', 'b1', 'P1', 'cancel', nonce, '7'].join('\n'));
  });

  it('answers with a poll_result carrying the poll as the phone shows it', () => {
    const d = {
      v: 1,
      kind: 'poll_result',
      team: 'revive',
      binding: 'b1',
      nonce,
      op: 'open',
      ok: false,
      reason: 'not_live',
      poll: { live: false, open: null, last: null },
    };
    expect(AppDeliverySchema.parse(d)).toEqual(d);
  });
});
