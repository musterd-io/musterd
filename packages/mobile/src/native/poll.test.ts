import {
  AppCallbackSchema,
  AppPollCloseSchema,
  AppPollOpenSchema,
  appPollOpenSigningBytes,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import { pollReasonText, sendPollClose, sendPollOpen } from './poll';

/** Twitch polls from the phone (ADR 807 §5): what the app signs, seals and sends. */

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    sign: vi.fn(async () => 'signed-by-face-id'),
    signQuestion: vi.fn(async () => 'signed-silently'),
    randomNonce: vi.fn(async () => 'r'.repeat(32)),
    seal: vi.fn(async () => ({ v: 1, enc: 'ENC', ct: 'CT' })),
    questionEnrollment: vi.fn(() => ({ binding: 'bind-1', key: 'k' })),
    questionPublicKey: vi.fn(async () => 'k'),
  },
  phoneKeysErrorCode: (e: unknown) => (e as { code?: string }).code ?? null,
}));

const NOW = 1_793_740_000_000;
const SPEC = { question: 'What next?', options: ['Camera', 'Ask the team'], minutes: 5 };
const pin: PairingPin = {
  v: 1,
  identity: 'I'.repeat(43),
  receive: 'C'.repeat(87),
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

beforeEach(() => vi.clearAllMocks());

const accepted = () => vi.fn(async () => new Response('ok', { status: 202 }));

describe('sendPollOpen', () => {
  it('signs the exact spec with Face ID, never the silent key, and seals it as poll_open', async () => {
    const fetchImpl = accepted();
    const out = await sendPollOpen({ pin, spec: SPEC, now: NOW, fetchImpl, pauseMs: 0 });
    expect(out).toEqual({ sent: true, nonce: 'r'.repeat(32) });
    expect(phoneKeys.signQuestion).not.toHaveBeenCalled();
    expect(phoneKeys.sign).toHaveBeenCalledWith(
      appPollOpenSigningBytes({
        team: 'revive',
        binding: 'bind-1',
        spec: SPEC,
        nonce: 'r'.repeat(32),
        ts: NOW,
      }),
    );
    const seal = vi.mocked(phoneKeys.seal).mock.calls[0]![0];
    expect(seal.purpose).toBe('poll_open');
    expect(AppPollOpenSchema.parse(JSON.parse(seal.plaintext))).toMatchObject({
      spec: SPEC,
      ts: NOW,
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example/app/revive/callback');
    const cb = AppCallbackSchema.parse(JSON.parse(String(init.body)));
    expect(cb).toMatchObject({ kind: 'poll_open', binding: 'bind-1', ref: 'r'.repeat(32) });
    if (cb.kind !== 'poll_open') throw new Error('kind');
    expect(cb.expires_at).toBeLessThanOrEqual(NOW + 10 * 60_000);
    expect(Buffer.from(seal.aad, 'base64url').toString('utf8')).toBe(
      canonicalJson({ team: 'revive', binding: 'bind-1', ref: cb.ref, expires_at: cb.expires_at }),
    );
  });

  it('says cancelled when Face ID is dismissed, and unpaired with no binding', async () => {
    vi.mocked(phoneKeys.sign).mockRejectedValueOnce({ code: 'biometry-failed' });
    expect(await sendPollOpen({ pin, spec: SPEC, now: NOW, fetchImpl: accepted() })).toEqual({
      sent: false,
      why: 'cancelled',
    });
    const { binding: _b, ...unbound } = pin;
    expect(await sendPollOpen({ pin: unbound, spec: SPEC, now: NOW })).toEqual({
      sent: false,
      why: 'unpaired',
    });
  });
});

describe('sendPollClose', () => {
  it('ends or cancels the named poll, signed with Face ID and sealed as poll_close', async () => {
    const fetchImpl = accepted();
    const out = await sendPollClose({
      pin,
      pollId: 'P'.repeat(26),
      how: 'cancel',
      now: NOW,
      fetchImpl,
      pauseMs: 0,
    });
    expect(out).toMatchObject({ sent: true });
    const seal = vi.mocked(phoneKeys.seal).mock.calls[0]![0];
    expect(seal.purpose).toBe('poll_close');
    expect(AppPollCloseSchema.parse(JSON.parse(seal.plaintext))).toMatchObject({
      poll_id: 'P'.repeat(26),
      how: 'cancel',
      key: 'signing',
    });
  });
});

describe('pollReasonText', () => {
  it('says a refusal as the person reads it', () => {
    expect(pollReasonText('not_live')).toBe('Polls open while you’re live on Twitch.');
    expect(pollReasonText('not_admin')).toBe('Only a team admin can run polls.');
    expect(pollReasonText(undefined)).toMatch(/Try again/);
  });
});
