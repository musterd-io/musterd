import { AppCallbackSchema } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b64urlEncode, utf8Encode } from './bytes';
import { sendPairingRequest } from './pair';
import { pairingChallenge, readPairingQr } from './pairingQr';
import { phoneKeys } from './phoneKeys';

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    prepareNotifications: vi.fn(),
    getPushToken: vi.fn(),
    getPublicKeys: vi.fn(),
    generateAttestationKey: vi.fn(),
    seal: vi.fn(),
    savePairingPin: vi.fn(),
  },
  phoneKeysErrorCode: (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (
      code === 'unavailable' ||
      code === 'biometry-failed' ||
      code === 'key-invalidated' ||
      code === 'sealed-open-failed' ||
      code === 'attest-failed'
    ) {
      return code;
    }
    return null;
  },
}));

const b64 = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString('base64url');
const identity = b64(32, 1);
const receive = b64(65, 2);
const signing = b64(65, 3);
const phoneReceive = b64(65, 4);
const code = 'd'.repeat(43);
const keyId = b64(32, 5);

const read = readPairingQr(
  JSON.stringify({
    v: 1,
    relay: 'wss://relay.example/socket',
    team: 'revive',
    pairing: 'pair-1',
    code,
    expires_at: 4_102_444_800_000,
    daemon_identity_public_key: identity,
    daemon_receive_public_key: receive,
  }),
  1,
);
if (!read.ok) throw new Error('fixture');
const scanned = read.scanned;

const token = 'ab'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(phoneKeys.prepareNotifications).mockResolvedValue(undefined);
  vi.mocked(phoneKeys.getPushToken).mockResolvedValue({
    token,
    environment: 'production',
  });
  vi.mocked(phoneKeys.getPublicKeys).mockResolvedValue({
    signing,
    receive: phoneReceive,
  });
  vi.mocked(phoneKeys.generateAttestationKey).mockResolvedValue({
    keyId,
    attestation: 'attest-object',
  });
  vi.mocked(phoneKeys.seal).mockResolvedValue({ v: 1, enc: 'RU5D', ct: 'Q1Q' });
  vi.mocked(phoneKeys.savePairingPin).mockResolvedValue(undefined);
});

describe('sendPairingRequest', () => {
  it('seals the request to the daemon and stores a pin with no binding after 202', async () => {
    const fetchImpl = vi.fn(async () => new Response('accepted', { status: 202 }));
    const outcome = await sendPairingRequest({ scanned, fetchImpl, sleep: async () => {} });
    expect(outcome).toBe('waiting');
    expect(phoneKeys.generateAttestationKey).toHaveBeenCalledWith(
      pairingChallenge(code, signing, phoneReceive),
    );
    const route = canonicalJson({
      team: 'revive',
      binding: 'pairing',
      ref: 'pair-1',
      expires_at: scanned.qr.expires_at,
    });
    expect(phoneKeys.seal).toHaveBeenCalledWith({
      recipientPublic: receive,
      plaintext: JSON.stringify({
        v: 1,
        code,
        signing_public_key: signing,
        receive_public_key: phoneReceive,
        attest_key_id: keyId,
        attestation: 'attest-object',
        push_token: token,
        push_environment: 'production',
      }),
      purpose: 'pair',
      aad: b64urlEncode(utf8Encode(route)),
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://relay.example/app/revive/callback');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const callback = AppCallbackSchema.parse(JSON.parse(String(init?.body)));
    expect(callback).toMatchObject({
      app: 1,
      kind: 'pair',
      binding: 'pairing',
      ref: 'pair-1',
      expires_at: scanned.qr.expires_at,
    });
    const stored = JSON.parse(String(vi.mocked(phoneKeys.savePairingPin).mock.calls[0]?.[0]));
    expect(stored).toEqual({
      v: 1,
      identity,
      receive,
      relay: 'https://relay.example',
      team: 'revive',
    });
    expect(stored).not.toHaveProperty('binding');
  });

  it('omits the push token when registration never returns one', async () => {
    vi.mocked(phoneKeys.getPushToken).mockResolvedValue(null);
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    await sendPairingRequest({ scanned, fetchImpl, sleep: async () => {} });
    const plaintext = JSON.parse(String(vi.mocked(phoneKeys.seal).mock.calls[0]?.[0].plaintext));
    expect(plaintext).not.toHaveProperty('push_token');
    expect(phoneKeys.getPushToken).toHaveBeenCalledTimes(4);
  });

  it('does not store a pin when the relay does not accept the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    expect(await sendPairingRequest({ scanned, fetchImpl, sleep: async () => {} })).toBe(
      'undelivered',
    );
    expect(phoneKeys.savePairingPin).not.toHaveBeenCalled();
  });

  it('names a cancelled Face ID and an attestation the device refused', async () => {
    vi.mocked(phoneKeys.getPublicKeys).mockRejectedValue(
      Object.assign(new Error('no'), { code: 'biometry-failed' }),
    );
    expect(await sendPairingRequest({ scanned, sleep: async () => {} })).toBe('cancelled');
    expect(phoneKeys.generateAttestationKey).not.toHaveBeenCalled();

    vi.mocked(phoneKeys.getPublicKeys).mockResolvedValue({ signing, receive: phoneReceive });
    vi.mocked(phoneKeys.generateAttestationKey).mockRejectedValue(
      Object.assign(new Error('no'), { code: 'attest-failed' }),
    );
    expect(await sendPairingRequest({ scanned, sleep: async () => {} })).toBe('attest-failed');
    expect(phoneKeys.seal).not.toHaveBeenCalled();
  });
});
