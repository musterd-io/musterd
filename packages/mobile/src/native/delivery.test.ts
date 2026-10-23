import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeliveryExpiredError,
  DeliveryUnverifiedError,
  openDelivery,
  type DeliveryRoute,
} from './delivery';
import { phoneKeys, type SealedBody } from './phoneKeys';

/**
 * The composition's contract with the daemon, held byte-for-byte: the route JSON literal below
 * is what `canonicalJson` must produce for {@link ROUTE} (the daemon signs it), the signing
 * message is `appSeal.ts`'s `signingBytes` written out again here, and the `verifyEd25519`
 * mock is *real* Ed25519 over exactly those bytes — so a one-byte drift in either direction
 * fails this suite rather than shipping. Only the two native calls are mocked; everything
 * between them is the code under test.
 */
vi.mock('./phoneKeys', () => ({
  phoneKeys: { open: vi.fn(), verifyEd25519: vi.fn() },
}));

const identity = generateKeyPairSync('ed25519');
const PINNED = identity.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12) // drop the fixed Ed25519 SPKI prefix, leaving the raw 32-byte key
  .toString('base64url');

const SIGN_DOMAIN = 'musterd-app/v1 signed';
const ROUTE: DeliveryRoute = {
  team: 'revive',
  binding: 'bind-1',
  ref: 'ask-9f3k',
  expires_at: 4_102_444_800_000,
};
/** canonicalJson(ROUTE): keys sorted (binding, expires_at, ref, team) — the daemon's exact bytes. */
const ROUTE_JSON =
  '{"binding":"bind-1","expires_at":4102444800000,"ref":"ask-9f3k","team":"revive"}';
const AAD = Buffer.from(ROUTE_JSON, 'utf8').toString('base64url');

const DELIVERY = {
  v: 1,
  kind: 'ask',
  team: 'revive',
  binding: 'bind-1',
  ask: {
    id: 'ask-9f3k',
    from: 'slippy',
    from_kind: 'human',
    body: 'Accept lane 01M… from cider?',
    tier: 'standard',
    species: null,
    action_class: 'advisory',
    ts: 1_792_730_000_000,
  },
  token: 'tok_4f2z',
  nonce: 'nonce-8f1a2b3c4d5e6f70',
  expires_at: 4_102_444_800_000,
};

const SEALED: SealedBody = {
  v: 1,
  enc: Buffer.alloc(65, 4).toString('base64url'),
  ct: Buffer.alloc(48, 7).toString('base64url'),
};

/** The inner `{p,s}` JSON the daemon seals in, with a real signature over `signingBytes`. */
function makeInner(delivery: unknown, signOver?: Buffer): string {
  const payload = Buffer.from(JSON.stringify(delivery), 'utf8');
  const signed =
    signOver ?? Buffer.concat([Buffer.from(`${SIGN_DOMAIN}\n${ROUTE_JSON}\n`, 'utf8'), payload]);
  const sig = cryptoSign(null, signed, identity.privateKey);
  return JSON.stringify({ p: payload.toString('base64url'), s: sig.toString('base64url') });
}

/** The inner JSON for arbitrary payload bytes, signed correctly over them. */
function innerOverRawBytes(payload: Buffer): string {
  const signed = Buffer.concat([Buffer.from(`${SIGN_DOMAIN}\n${ROUTE_JSON}\n`, 'utf8'), payload]);
  const sig = cryptoSign(null, signed, identity.privateKey);
  return JSON.stringify({ p: payload.toString('base64url'), s: sig.toString('base64url') });
}

const INPUT = { sealed: SEALED, route: ROUTE, pinnedIdentity: PINNED, now: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  // The native open, faithfully: refuse any body whose AAD is not the sealed route's, exactly
  // as HPKE does — a body moved to another route does not open.
  vi.mocked(phoneKeys.open).mockImplementation(async (i) => {
    if (i.aad !== AAD) throw new Error('sealed-open-failed');
    return makeInner(DELIVERY);
  });
  // The native verify, faithfully: real Ed25519 over the exact bytes the composition passes.
  vi.mocked(phoneKeys.verifyEd25519).mockImplementation(
    async ({ publicKey, message, signature }) => {
      try {
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
      } catch {
        return false;
      }
    },
  );
});

describe('openDelivery', () => {
  it('opens, verifies and parses a delivery the daemon sealed', async () => {
    const result = await openDelivery(INPUT);
    expect(result).toEqual(DELIVERY);
    expect(phoneKeys.open).toHaveBeenCalledWith({ sealed: SEALED, purpose: 'deliver', aad: AAD });
    // The signed message, assembled independently: domain line + canonical route + payload bytes.
    const payload = Buffer.from(JSON.stringify(DELIVERY), 'utf8');
    const expectedMessage = Buffer.concat([
      Buffer.from(`${SIGN_DOMAIN}\n${ROUTE_JSON}\n`, 'utf8'),
      payload,
    ]).toString('base64url');
    expect(phoneKeys.verifyEd25519).toHaveBeenCalledWith({
      publicKey: PINNED,
      message: expectedMessage,
      signature: expect.any(String),
    });
  });

  it('refuses a body moved to another route — the route is the AAD', async () => {
    await expect(
      openDelivery({ ...INPUT, route: { ...ROUTE, ref: 'ask-other' } }),
    ).rejects.toBeInstanceOf(DeliveryUnverifiedError);
    expect(phoneKeys.verifyEd25519).not.toHaveBeenCalled(); // the seal never opened
  });

  it('refuses an unsupported sealed body version without opening anything', async () => {
    await expect(
      openDelivery({ ...INPUT, sealed: { ...SEALED, v: 2 } as unknown as SealedBody }),
    ).rejects.toBeInstanceOf(DeliveryUnverifiedError);
    expect(phoneKeys.open).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the native open refuses',
      async () =>
        void vi.mocked(phoneKeys.open).mockRejectedValueOnce(new Error('sealed-open-failed')),
    ],
    [
      'the inner body is not JSON',
      async () => void vi.mocked(phoneKeys.open).mockResolvedValueOnce('not json'),
    ],
    [
      'the inner body has no signature',
      async () =>
        void vi.mocked(phoneKeys.open).mockResolvedValueOnce(JSON.stringify({ p: 'e30' })),
    ],
    [
      'the inner signature is not a string',
      async () =>
        void vi.mocked(phoneKeys.open).mockResolvedValueOnce(JSON.stringify({ p: 'e30', s: 5 })),
    ],
    [
      'the payload half is not base64url',
      async () =>
        void vi.mocked(phoneKeys.open).mockResolvedValueOnce(JSON.stringify({ p: '***', s: 'AA' })),
    ],
    [
      'the pinned key is malformed (the native check rejects)',
      async () =>
        void vi
          .mocked(phoneKeys.verifyEd25519)
          .mockRejectedValueOnce(new Error('sealed-open-failed')),
    ],
  ])('shows the one generic failure when %s', async (_name, arrange) => {
    await arrange();
    await expect(openDelivery(INPUT)).rejects.toMatchObject({
      name: 'DeliveryUnverifiedError',
      message: 'an ask could not be verified',
    });
  });

  it('shows the one generic failure for a signature made over other bytes', async () => {
    // A daemon signature over a *different* route with a perfectly valid seal: the bytes the
    // composition assembles are not the bytes that were signed, so real Ed25519 says no.
    const foreignRoute = '{"binding":"bind-1","expires_at":1,"ref":"ask-9f3k","team":"revive"}';
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(
      makeInner(
        DELIVERY,
        Buffer.concat([
          Buffer.from(`${SIGN_DOMAIN}\n${foreignRoute}\n`, 'utf8'),
          Buffer.from(JSON.stringify(DELIVERY), 'utf8'),
        ]),
      ),
    );
    await expect(openDelivery(INPUT)).rejects.toBeInstanceOf(DeliveryUnverifiedError);
  });

  it('shows the one generic failure for a payload the schema refuses', async () => {
    // Signed correctly — the daemon's own bytes fail schema parsing (a field is missing).
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(makeInner({ ...DELIVERY, token: undefined }));
    await expect(openDelivery(INPUT)).rejects.toBeInstanceOf(DeliveryUnverifiedError);
  });

  it('shows the one generic failure for signed bytes that are not the payload JSON', async () => {
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(
      innerOverRawBytes(Buffer.from('{"v":1,', 'utf8')),
    );
    await expect(openDelivery(INPUT)).rejects.toBeInstanceOf(DeliveryUnverifiedError);
  });

  it('drops an expired delivery distinctly, at expires_at', async () => {
    const expired = { ...DELIVERY, expires_at: 2_000_000_000_000 };
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(makeInner(expired));
    await expect(openDelivery({ ...INPUT, now: 2_000_000_000_000 })).rejects.toBeInstanceOf(
      DeliveryExpiredError,
    );
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(makeInner(expired));
    const lastTick = await openDelivery({ ...INPUT, now: 1_999_999_999_999 });
    expect(lastTick.expires_at).toBe(2_000_000_000_000);
  });

  it('does not expire a delivery without an expiry', async () => {
    const held = {
      v: 1,
      kind: 'held',
      team: 'revive',
      binding: 'bind-1',
      count: 3,
      until: 2_000_000_000_000,
    };
    vi.mocked(phoneKeys.open).mockResolvedValueOnce(makeInner(held));
    const result = await openDelivery({ ...INPUT, now: 9_999_999_999_999 });
    expect(result).toEqual(held);
  });
});
