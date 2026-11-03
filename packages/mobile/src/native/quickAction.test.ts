import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  AppCallbackSchema,
  AppQuickActionSchema,
  appQuickActionSigningBytes,
} from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_ACTION_ORDER, quickResultText } from './notice';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import { fetchRoster, ROSTER_SKEW_MS, sendQuickAction } from './quickAction';

const KEY = `B${'Q'.repeat(86)}`;

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    open: vi.fn(),
    verifyEd25519: vi.fn(),
    questionPublicKey: vi.fn(async () => `B${'Q'.repeat(86)}`),
    sign: vi.fn(async () => 'signed-by-face-id'),
    signQuestion: vi.fn(async () => 'signed-silently'),
    randomNonce: vi.fn(async () => 'r'.repeat(32)),
    seal: vi.fn(async () => ({ v: 1, enc: 'ENC', ct: 'CT' })),
    questionEnrollment: vi.fn(() => null),
  },
  phoneKeysErrorCode: (e: unknown) => (e as { code?: string }).code ?? null,
}));

const identity = generateKeyPairSync('ed25519');
const PINNED = identity.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('base64url');
const NOW = 1_793_740_000_000;

const pin: PairingPin = {
  v: 1,
  identity: PINNED,
  receive: 'C'.repeat(87),
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(phoneKeys.questionEnrollment).mockReturnValue(null);
});

describe('sendQuickAction', () => {
  const posted = () =>
    vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('ok', { status: 202 }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it('signs silently once the question key is enrolled, and seals with purpose quick_action', async () => {
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValue({
      binding: 'bind-1',
      key: KEY,
      expires_at: NOW,
    });
    const fetchImpl = posted();
    const outcome = await sendQuickAction({
      pin,
      seat: 'fifty',
      action: 'check_inbox',
      now: NOW,
      fetchImpl,
    });
    expect(outcome).toBe('sent');
    expect(phoneKeys.sign).not.toHaveBeenCalled();
    expect(phoneKeys.signQuestion).toHaveBeenCalledWith(
      appQuickActionSigningBytes({
        team: 'revive',
        binding: 'bind-1',
        seat: 'fifty',
        action: 'check_inbox',
        nonce: 'r'.repeat(32),
        ts: NOW,
      }),
    );
    const seal = vi.mocked(phoneKeys.seal).mock.calls[0]![0];
    expect(seal.purpose).toBe('quick_action');
    const body = AppQuickActionSchema.parse(JSON.parse(seal.plaintext));
    expect(body).toMatchObject({ seat: 'fifty', action: 'check_inbox', key: 'question', ts: NOW });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://relay.example/app/revive/callback');
    const callback = AppCallbackSchema.parse(JSON.parse(String(init!.body)));
    expect(callback).toMatchObject({ kind: 'quick_action', binding: 'bind-1', ref: body.nonce });
    // The seal binds the route and its expiry, which the daemon wants inside ten minutes.
    if (callback.kind !== 'quick_action') throw new Error('kind');
    expect(callback.expires_at).toBeGreaterThan(NOW);
    expect(callback.expires_at).toBeLessThanOrEqual(NOW + 10 * 60_000);
    expect(Buffer.from(seal.aad, 'base64url').toString('utf8')).toBe(
      canonicalJson({
        team: 'revive',
        binding: 'bind-1',
        ref: body.nonce,
        expires_at: callback.expires_at,
      }),
    );
  });

  it('uses the Face ID key before the question key is enrolled for this binding', async () => {
    vi.mocked(phoneKeys.questionEnrollment).mockReturnValue({
      binding: 'other-binding',
      key: KEY,
      expires_at: NOW,
    });
    await sendQuickAction({ pin, seat: 'fifty', action: 'stop', now: NOW, fetchImpl: posted() });
    expect(phoneKeys.sign).toHaveBeenCalledOnce();
    expect(phoneKeys.signQuestion).not.toHaveBeenCalled();
    const body = JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext);
    expect(body.key).toBe('signing');
  });

  it('says cancelled when Face ID is turned down, and sends nothing', async () => {
    vi.mocked(phoneKeys.sign).mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'biometry-failed' }),
    );
    const fetchImpl = posted();
    expect(await sendQuickAction({ pin, seat: 'fifty', action: 'start', fetchImpl })).toBe(
      'cancelled',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tries twice, then fails without keeping it for later', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('down', { status: 503 }),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect(
      await sendQuickAction({ pin, seat: 'fifty', action: 'resume', fetchImpl, pauseMs: 0 }),
    ).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends nothing before the phone has a binding', async () => {
    const { binding: _binding, ...unbound } = pin;
    expect(await sendQuickAction({ pin: unbound, seat: 'fifty', action: 'start' })).toBe(
      'unpaired',
    );
    expect(phoneKeys.seal).not.toHaveBeenCalled();
  });
});

describe('fetchRoster', () => {
  const roster = {
    v: 1,
    kind: 'roster',
    team: 'revive',
    binding: 'bind-1',
    ts: NOW,
    seats: [
      { seat: 'cider', online: true, wakeable: true, lane: { id: 'L1', title: 'phone' } },
      { seat: 'fifty', online: false, wakeable: false, lane: null },
    ],
  };
  const ref = `roster-${NOW - ROSTER_SKEW_MS}`;
  const r = { team: 'revive', binding: 'bind-1', ref, expires_at: NOW - ROSTER_SKEW_MS + 600_000 };

  function served(body: unknown) {
    vi.mocked(phoneKeys.open).mockImplementation(async ({ aad }) => {
      if (Buffer.from(aad, 'base64url').toString('utf8') !== canonicalJson(r))
        throw new Error('sealed-open-failed');
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const signed = Buffer.concat([
        Buffer.from(`musterd-app/v1 signed\n${canonicalJson(r)}\n`, 'utf8'),
        payload,
      ]);
      return JSON.stringify({
        p: payload.toString('base64url'),
        s: cryptoSign(null, signed, identity.privateKey).toString('base64url'),
      });
    });
    vi.mocked(phoneKeys.verifyEd25519).mockImplementation(
      async ({ publicKey, message, signature }) =>
        cryptoVerify(
          null,
          Buffer.from(message, 'base64url'),
          createPublicKey({
            key: Buffer.concat([
              Buffer.from('302a300506032b6570032100', 'hex'),
              Buffer.from(publicKey, 'base64url'),
            ]),
            format: 'der',
            type: 'spki',
          }),
          Buffer.from(signature, 'base64url'),
        ),
    );
    return vi.fn(async (url: string) =>
      String(url).endsWith(`/app/revive/body/bind-1/${ref}`)
        ? Response.json({ ...r, sealed: { v: 1, enc: 'AA', ct: 'BB' } })
        : new Response('no', { status: 404 }),
    ) as unknown as typeof fetch;
  }

  it('pulls roster-<now-30s> and opens it like any delivery', async () => {
    expect(await fetchRoster({ pin, now: NOW, fetchImpl: served(roster) })).toEqual(roster);
  });

  it('refuses anything that is not a roster', async () => {
    const held = { v: 1, kind: 'held', team: 'revive', binding: 'bind-1', count: 1, until: NOW };
    expect(await fetchRoster({ pin, now: NOW, fetchImpl: served(held) })).toEqual({
      miss: 'gone',
    });
  });

  it('says unreachable when the relay is down', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await fetchRoster({ pin, now: NOW, fetchImpl })).toEqual({ miss: 'unreachable' });
  });
});

describe('quick action copy', () => {
  it('shows all five actions, Stop last', () => {
    expect(QUICK_ACTION_ORDER).toEqual(['start', 'check_inbox', 'check_pr', 'resume', 'stop']);
  });

  it('says what reached the seat, or that it waits', () => {
    expect(quickResultText('cider', 'check_inbox', 'started')).toBe('Check inbox reached cider.');
    expect(quickResultText('fifty', 'stop', 'offline')).toBe(
      'fifty is offline. Stop waits in its inbox.',
    );
  });
});
