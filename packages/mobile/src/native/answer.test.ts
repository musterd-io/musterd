import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { AppCallbackSchema, appAnswerSigningBytes } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerNotification, sendAnswer } from './answer';
import type { PairingPin } from './pairingPin';
import { phoneKeys, type SealedBody } from './phoneKeys';
import type { PushRoute } from './push';

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    open: vi.fn(),
    verifyEd25519: vi.fn(),
    sign: vi.fn(),
    signAll: vi.fn(),
    seal: vi.fn(),
  },
  phoneKeysErrorCode: (error: unknown) =>
    (error as { code?: string } | null)?.code === 'biometry-failed' ? 'biometry-failed' : null,
}));

const identity = generateKeyPairSync('ed25519');
const PINNED = identity.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('base64url');

const ROUTE: PushRoute = {
  team: 'revive',
  binding: 'bind-1',
  ref: 'ask-9f3k',
  expires_at: 4_102_444_800_000,
};
const ROUTE_JSON = canonicalJson(ROUTE);
const AAD = Buffer.from(ROUTE_JSON, 'utf8').toString('base64url');
const SEALED: SealedBody = { v: 1, enc: 'AA', ct: 'BB' };

function delivery(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: 'ask',
    team: 'revive',
    binding: 'bind-1',
    ask: {
      id: 'ask-9f3k',
      from: 'slippy',
      from_kind: 'human',
      body: 'Ship it?',
      tier: 'standard',
      species: null,
      action_class: 'advisory',
      ts: 1,
    },
    token: 'tok_4f2z',
    nonce: 'nonce-8f1a2b3c4d5e6f70',
    expires_at: ROUTE.expires_at,
    ...over,
  };
}

function innerFor(body: unknown, routeJson = ROUTE_JSON): string {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const signed = Buffer.concat([
    Buffer.from(`musterd-app/v1 signed\n${routeJson}\n`, 'utf8'),
    payload,
  ]);
  const signature = cryptoSign(null, signed, identity.privateKey);
  return JSON.stringify({ p: payload.toString('base64url'), s: signature.toString('base64url') });
}

const pin: PairingPin = {
  v: 1,
  identity: PINNED,
  receive: 'C'.repeat(87),
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

const userInfo = { musterd: { v: 1, ...ROUTE, sealed: SEALED } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(phoneKeys.open).mockImplementation(async (input) => {
    if (input.aad !== AAD) throw new Error('sealed-open-failed');
    return innerFor(delivery());
  });
  vi.mocked(phoneKeys.verifyEd25519).mockImplementation(
    async ({ publicKey, message, signature }) => {
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(publicKey, 'base64url'),
        ]),
        format: 'der',
        type: 'spki',
      });
      return cryptoVerify(
        null,
        Buffer.from(message, 'base64url'),
        key,
        Buffer.from(signature, 'base64url'),
      );
    },
  );
  vi.mocked(phoneKeys.sign).mockResolvedValue('c2ln');
  vi.mocked(phoneKeys.signAll).mockResolvedValue(['c2ln', 'ZGVzYw']);
  vi.mocked(phoneKeys.seal).mockResolvedValue({ v: 1, enc: 'RU5D', ct: 'Q1Q' });
});

describe('answerNotification', () => {
  it('signs the advisory answer and posts it to the relay callback', async () => {
    const fetchImpl = vi.fn(async () => new Response('accepted', { status: 202 }));
    const outcome = await answerNotification({
      action: 'musterd.answer.approve',
      userInfo,
      pin,
      now: 1,
      fetchImpl,
    });
    expect(outcome).toBe('sent');
    const message = appAnswerSigningBytes({
      team: 'revive',
      binding: 'bind-1',
      ask: 'ask-9f3k',
      token: 'tok_4f2z',
      decision: 'approve',
      nonce: 'nonce-8f1a2b3c4d5e6f70',
      reported: false,
    });
    expect(phoneKeys.sign).toHaveBeenCalledWith(message);
    expect(phoneKeys.seal).toHaveBeenCalledWith({
      recipientPublic: pin.receive,
      plaintext: JSON.stringify({
        v: 1,
        token: 'tok_4f2z',
        decision: 'approve',
        nonce: 'nonce-8f1a2b3c4d5e6f70',
        signature: 'c2ln',
      }),
      purpose: 'answer',
      aad: AAD,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://relay.example/app/revive/callback');
    expect(AppCallbackSchema.parse(JSON.parse(String(init?.body)))).toMatchObject({
      app: 1,
      kind: 'answer',
      binding: 'bind-1',
      ref: 'ask-9f3k',
      expires_at: ROUTE.expires_at,
    });
  });

  it('does not sign a pin that has no binding yet', async () => {
    const { binding: _binding, ...waiting } = pin;
    expect(
      await answerNotification({
        action: 'musterd.answer.approve',
        userInfo,
        pin: waiting,
        now: 1,
      }),
    ).toBe('unverified');
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });

  it('does not sign when the phone is unpaired, the ask is listed, or the delivery expired', async () => {
    expect(
      await answerNotification({ action: 'musterd.answer.approve', userInfo, pin: null, now: 1 }),
    ).toBe('unpaired');
    vi.mocked(phoneKeys.open).mockImplementation(async () =>
      innerFor(delivery({ ask: { ...delivery().ask, action_class: 'privileged' } })),
    );
    expect(
      await answerNotification({ action: 'musterd.answer.approve', userInfo, pin, now: 1 }),
    ).toBe('refused');
    vi.mocked(phoneKeys.open).mockImplementation(async () => innerFor(delivery({ expires_at: 1 })));
    expect(
      await answerNotification({ action: 'musterd.answer.reject', userInfo, pin, now: 1_000 }),
    ).toBe('stale');
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });

  it('opens a fetched body under the response route, not the push route', async () => {
    const fetched = { ...ROUTE, expires_at: ROUTE.expires_at + 1 };
    const fetchedJson = canonicalJson(fetched);
    const fetchedAad = Buffer.from(fetchedJson, 'utf8').toString('base64url');
    vi.mocked(phoneKeys.open).mockImplementation(async (input) => {
      if (input.aad !== fetchedAad) throw new Error('sealed-open-failed');
      return innerFor(delivery({ expires_at: fetched.expires_at }), fetchedJson);
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/callback')) return new Response('accepted', { status: 202 });
      return Response.json({ ...fetched, sealed: SEALED });
    });
    const outcome = await answerNotification({
      action: 'musterd.answer.reject',
      userInfo: { musterd: { v: 1, ...ROUTE } },
      pin,
      now: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toBe('sent');
    expect(phoneKeys.sign).toHaveBeenCalledWith(expect.stringContaining('\nreject\n'));
    expect(phoneKeys.seal).toHaveBeenCalledWith(expect.objectContaining({ aad: fetchedAad }));
    const post = fetchImpl.mock.calls.find((call) => String(call[0]).endsWith('/callback'));
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.expires_at).toBe(fetched.expires_at);
  });

  it('reports Face ID cancel, and a relay that did not accept the callback', async () => {
    vi.mocked(phoneKeys.sign).mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'biometry-failed' }),
    );
    expect(
      await answerNotification({ action: 'musterd.answer.approve', userInfo, pin, now: 1 }),
    ).toBe('cancelled');
    vi.mocked(phoneKeys.sign).mockResolvedValue('c2ln');
    const fetchImpl = vi.fn(async () => new Response('no', { status: 503 }));
    expect(
      await answerNotification({
        action: 'musterd.answer.approve',
        userInfo,
        pin,
        now: 1,
        fetchImpl,
      }),
    ).toBe('undelivered');
  });
});

function offer(verdict: 'accept' | 'decline', over: Record<string, unknown> = {}) {
  const payload = { lane: '01M5LANE', verdict, ask_id: 'ask-9f3k' };
  return {
    descriptor: {
      v: 1 as const,
      actor: 'nick',
      act: 'human_accept' as const,
      target: '01M5LANE',
      payload_digest: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
      audience: 'revive',
      expiry: ROUTE.expires_at,
      nonce: `desc-nonce-${verdict}-0001`,
      ...over,
    },
    payload,
  };
}

function listed(over: Record<string, unknown> = {}) {
  return {
    ...delivery({
      ask: { ...delivery().ask, action_class: 'privileged' },
      approval: { approve: offer('accept'), reject: offer('decline') },
    }),
    ...over,
  } as Parameters<typeof sendAnswer>[0]['delivery'];
}

describe('sendAnswer from the app', () => {
  const keyed: PairingPin = { ...pin, device_key_id: '01M5DEVICEKEY' };
  const accepted = () => vi.fn(async () => new Response('accepted', { status: 202 }));

  it('signs a listed act and the descriptor it rebuilt under one Face ID, naming the device key', async () => {
    const fetchImpl = accepted();
    const outcome = await sendAnswer({
      pin: keyed,
      route: ROUTE,
      delivery: listed(),
      decision: 'approve',
      reported: false,
      now: 1,
      fetchImpl,
    });
    expect(outcome).toBe('sent');
    expect(phoneKeys.sign).not.toHaveBeenCalled();
    const [messages] = vi.mocked(phoneKeys.signAll).mock.calls[0]!;
    expect(messages[0]).toContain('musterd-app-answer/v1');
    expect(messages[1]).toBe(
      [
        'musterd-approval/v1',
        'nick',
        'human_accept',
        '01M5LANE',
        offer('accept').descriptor.payload_digest,
        'revive',
        String(ROUTE.expires_at),
        'desc-nonce-accept-0001',
      ].join('\n'),
    );
    const sealed = JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext);
    expect(sealed.approval).toEqual({
      key_id: '01M5DEVICEKEY',
      nonce: 'desc-nonce-accept-0001',
      signature: 'ZGVzYw',
    });
  });

  it('signs the decline offer on a reject, and carries "I did not expect this"', async () => {
    await sendAnswer({
      pin: keyed,
      route: ROUTE,
      delivery: listed(),
      decision: 'reject',
      reported: true,
      now: 1,
      fetchImpl: accepted(),
    });
    const [messages] = vi.mocked(phoneKeys.signAll).mock.calls[0]!;
    expect(messages[0]!.endsWith('\nreported')).toBe(true);
    expect(messages[1]).toContain('desc-nonce-decline-0001');
    const sealed = JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext);
    expect(sealed.reported).toBe(true);
    expect(sealed.approval.nonce).toBe('desc-nonce-decline-0001');
  });

  it('never reports an approve, and an advisory answer signs once', async () => {
    await sendAnswer({
      pin,
      route: ROUTE,
      delivery: delivery() as Parameters<typeof sendAnswer>[0]['delivery'],
      decision: 'approve',
      reported: true,
      now: 1,
      fetchImpl: accepted(),
    });
    expect(phoneKeys.signAll).not.toHaveBeenCalled();
    expect(vi.mocked(phoneKeys.sign).mock.calls[0]![0].endsWith('\n-')).toBe(true);
    const sealed = JSON.parse(vi.mocked(phoneKeys.seal).mock.calls[0]![0].plaintext);
    expect(sealed.reported).toBeUndefined();
  });

  it('signs nothing for a digest that does not match its payload, or with no device key', async () => {
    const tampered = listed({
      approval: {
        approve: { ...offer('accept'), payload: { lane: '01M5OTHER', verdict: 'accept' } },
        reject: offer('decline'),
      },
    });
    expect(
      await sendAnswer({
        pin: keyed,
        route: ROUTE,
        delivery: tampered,
        decision: 'approve',
        reported: false,
        now: 1,
      }),
    ).toBe('unverified');
    expect(
      await sendAnswer({
        pin,
        route: ROUTE,
        delivery: listed(),
        decision: 'approve',
        reported: false,
        now: 1,
      }),
    ).toBe('unpaired');
    expect(phoneKeys.signAll).not.toHaveBeenCalled();
    expect(phoneKeys.sign).not.toHaveBeenCalled();
  });

  it('refuses a privileged ask that carries no offer', async () => {
    expect(
      await sendAnswer({
        pin: keyed,
        route: ROUTE,
        delivery: delivery({
          ask: { ...delivery().ask, action_class: 'privileged' },
        }) as Parameters<typeof sendAnswer>[0]['delivery'],
        decision: 'approve',
        reported: false,
        now: 1,
      }),
    ).toBe('refused');
  });
});
