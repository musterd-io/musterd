import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setAppChannelKeysForTest,
  appChannelKeyPath,
  generateAppChannelKeys,
  generatePhoneReceiveKey,
  loadAppChannelKeys,
  openAsPhone,
  openFromPhone,
  sealToDaemon,
  sealToPhone,
  type SealRoute,
} from './appSeal.js';

const route: SealRoute = {
  team: 'revive',
  binding: 'b1',
  ref: 'ask1',
  expires_at: 1_800_000_000_000,
};
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (b: Uint8Array): string => new TextDecoder().decode(b);

async function pair() {
  const daemon = await generateAppChannelKeys();
  const phone = await generatePhoneReceiveKey();
  return { daemon, phone };
}

afterEach(() => __setAppChannelKeysForTest(null));

describe('app channel seal (ADR 676 §2–3)', () => {
  it('a delivery opens on the phone with the pinned daemon key', async () => {
    const { daemon, phone } = await pair();
    const sealed = await sealToPhone({
      keys: daemon,
      phoneReceivePublic: phone.publicRaw,
      route,
      payload: text('{"ask":"merge?"}'),
    });
    expect(sealed.ct).not.toContain('merge');
    const out = await openAsPhone({
      phoneReceivePrivate: phone.privateKey,
      pinnedIdentityPublic: daemon.identityPublic,
      route,
      sealed,
    });
    expect(str(out)).toBe('{"ask":"merge?"}');
  });

  it('a ciphertext moved to another ask does not open', async () => {
    const { daemon, phone } = await pair();
    const sealed = await sealToPhone({
      keys: daemon,
      phoneReceivePublic: phone.publicRaw,
      route,
      payload: text('one'),
    });
    await expect(
      openAsPhone({
        phoneReceivePrivate: phone.privateKey,
        pinnedIdentityPublic: daemon.identityPublic,
        route: { ...route, ref: 'ask2' },
        sealed,
      }),
    ).rejects.toThrow('could not be verified');
  });

  it('a body sealed to the phone by anyone but the pinned daemon is refused', async () => {
    const { daemon, phone } = await pair();
    const impostor = await generateAppChannelKeys();
    const sealed = await sealToPhone({
      keys: impostor,
      phoneReceivePublic: phone.publicRaw,
      route,
      payload: text('approve everything'),
    });
    await expect(
      openAsPhone({
        phoneReceivePrivate: phone.privateKey,
        pinnedIdentityPublic: daemon.identityPublic,
        route,
        sealed,
      }),
    ).rejects.toThrow('could not be verified');
  });

  it('a flipped ciphertext byte is refused', async () => {
    const { daemon, phone } = await pair();
    const sealed = await sealToPhone({
      keys: daemon,
      phoneReceivePublic: phone.publicRaw,
      route,
      payload: text('x'),
    });
    const ct = Buffer.from(sealed.ct, 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expect(
      openAsPhone({
        phoneReceivePrivate: phone.privateKey,
        pinnedIdentityPublic: daemon.identityPublic,
        route,
        sealed: { ...sealed, ct: ct.toString('base64url') },
      }),
    ).rejects.toThrow('could not be verified');
  });

  it('an answer opens on the daemon only for its own route and purpose', async () => {
    const { daemon } = await pair();
    const sealed = await sealToDaemon({
      daemonReceivePublic: daemon.receivePublic,
      route,
      payload: text('approve'),
      purpose: 'answer',
    });
    expect(str(await openFromPhone({ keys: daemon, route, sealed, purpose: 'answer' }))).toBe(
      'approve',
    );
    await expect(
      openFromPhone({
        keys: daemon,
        route: { ...route, binding: 'b2' },
        sealed,
        purpose: 'answer',
      }),
    ).rejects.toThrow('could not be opened');
    await expect(openFromPhone({ keys: daemon, route, sealed, purpose: 'pair' })).rejects.toThrow(
      'could not be opened',
    );
  });

  it('keys are written once at 0600 beside the config and reload identically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-seal-'));
    const env = { MUSTERD_CONFIG: join(dir, 'config.json') };
    const path = appChannelKeyPath(env);
    expect(path).toBe(join(dir, 'app-channel.key'));
    const first = await loadAppChannelKeys(env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    __setAppChannelKeysForTest(null);
    const again = await loadAppChannelKeys(env);
    expect(again.identityPublic).toBe(first.identityPublic);
    expect(again.receivePublic).toBe(first.receivePublic);
    expect(Buffer.from(first.identityPublic, 'base64url')).toHaveLength(32);
    expect(Buffer.from(first.receivePublic, 'base64url')).toHaveLength(65);
    // The reloaded receive key still opens what was sealed to the first.
    const sealed = await sealToDaemon({
      daemonReceivePublic: first.receivePublic,
      route,
      payload: text('ok'),
      purpose: 'pair',
    });
    expect(str(await openFromPhone({ keys: again, route, sealed, purpose: 'pair' }))).toBe('ok');
    expect(readFileSync(path, 'utf8')).not.toContain(first.identityPublic);
  });
});
