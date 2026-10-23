import { describe, expect, it, vi } from 'vitest';
import { httpsOrigin, loadPairingPin, readPairingPin, savePairingPin } from './pairingPin';
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
});
