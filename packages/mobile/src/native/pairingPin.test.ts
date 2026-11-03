import { describe, expect, it, vi } from 'vitest';
import {
  forgetPairing,
  httpsOrigin,
  loadPairingPin,
  readPairingPin,
  savePairingPin,
} from './pairingPin';
import { phoneKeys } from './phoneKeys';

vi.mock('./phoneKeys', () => ({
  phoneKeys: { savePairingPin: vi.fn(), loadPairingPin: vi.fn() },
}));

const identity = 'A'.repeat(43);
const receive = 'B'.repeat(87);

const pin = {
  v: 1 as const,
  identity,
  receive,
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

describe('readPairingPin', () => {
  it('accepts an https origin and stores it without a trailing slash', () => {
    expect(httpsOrigin('https://relay.example')).toBe(true);
    expect(httpsOrigin('https://relay.example/')).toBe(true);
    expect(readPairingPin({ ...pin, relay: 'https://relay.example/' })?.relay).toBe(
      'https://relay.example',
    );
  });

  it('rejects a relay that is not an https origin, and a short key', () => {
    expect(httpsOrigin('http://relay.example')).toBe(false);
    expect(httpsOrigin('https://user:pw@relay.example')).toBe(false);
    expect(httpsOrigin('https://relay.example/app')).toBe(false);
    expect(readPairingPin({ ...pin, relay: 'https://relay.example/app' })).toBeNull();
    expect(readPairingPin({ ...pin, identity: 'short' })).toBeNull();
  });

  it('writes the validated JSON and reads it back', async () => {
    vi.mocked(phoneKeys.savePairingPin).mockResolvedValue(undefined);
    vi.mocked(phoneKeys.loadPairingPin).mockResolvedValue(JSON.stringify(pin));
    await savePairingPin(pin);
    expect(phoneKeys.savePairingPin).toHaveBeenCalledWith(JSON.stringify(pin));
    expect(await loadPairingPin()).toEqual(pin);
    vi.mocked(phoneKeys.loadPairingPin).mockResolvedValue('not json');
    expect(await loadPairingPin()).toBeNull();
  });

  it('stores a pin with no binding, and refuses a binding that is the wrong shape', async () => {
    vi.mocked(phoneKeys.savePairingPin).mockResolvedValue(undefined);
    const { binding: _binding, ...waiting } = pin;
    await savePairingPin(waiting);
    const stored = JSON.parse(String(vi.mocked(phoneKeys.savePairingPin).mock.calls.at(-1)?.[0]));
    expect(stored).toEqual(waiting);
    expect(stored).not.toHaveProperty('binding');
    expect(readPairingPin(waiting)).toEqual(waiting);
    expect(readPairingPin({ ...pin, binding: '' })).toBeNull();
    expect(readPairingPin({ ...pin, binding: true })).toBeNull();
  });
});

describe('forgetPairing (lane 01M6FJFW66)', () => {
  it('forgets the native store and clears the kept answers', async () => {
    const forgetNative = vi.fn(() => true);
    const clearOutbox = vi.fn(async () => {});
    expect(await forgetPairing({ forgetNative, clearOutbox })).toBe(true);
    expect(forgetNative).toHaveBeenCalledOnce();
    expect(clearOutbox).toHaveBeenCalledOnce();
  });

  it('reports a partial forget, and still clears the outbox', async () => {
    const clearOutbox = vi.fn(async () => {});
    expect(await forgetPairing({ forgetNative: () => false, clearOutbox })).toBe(false);
    expect(clearOutbox).toHaveBeenCalledOnce();
  });

  it('reports a native throw as not forgotten', async () => {
    const forgetNative = () => {
      throw new Error('unavailable');
    };
    expect(await forgetPairing({ forgetNative, clearOutbox: async () => {} })).toBe(false);
  });

  it('is not undone by an outbox that fails to clear', async () => {
    const clearOutbox = async () => {
      throw new Error('keychain');
    };
    expect(await forgetPairing({ forgetNative: () => true, clearOutbox })).toBe(true);
  });
});
