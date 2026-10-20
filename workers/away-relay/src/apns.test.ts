import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetApnsTokenForTest, apnsConfigFrom, apnsProviderToken, sendApns } from './apns.js';
import { appCallbackRef, apnsPayload, parseDaemonFrame, type DaemonFrame } from './relay.js';

/**
 * The relay's push to the musterd app (ADR 676 §9): the provider token is a JWT Apple can verify,
 * the push carries ciphertext and route only, and a body too big for APNs goes by ref.
 */

async function p8(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...der));
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const TOKEN = 'ab'.repeat(32);

function appDeliver(ct: string): Extract<DaemonFrame, { type: 'app_deliver' }> {
  return {
    protocol: 1,
    type: 'app_deliver',
    ask_ref: 'ask-1',
    dedupe_id: 'ask-1:app:b1',
    expires_at: 1_800_000_300_000,
    binding: 'b1',
    push: { token: TOKEN, environment: 'development' },
    sealed: { v: 1, enc: 'E'.repeat(87), ct },
  };
}

afterEach(() => __resetApnsTokenForTest());

describe('APNs provider token and send (ADR 676 §9)', () => {
  it('mints an ES256 JWT that verifies under the key, naming the key id and Apple team', async () => {
    const { pem, publicKey } = await p8();
    const jwt = await apnsProviderToken(
      { keyP8: pem, keyId: 'KEY123', teamId: 'D27MJGWNY3', topic: 'io.musterd.app' },
      1_800_000_000_000,
    );
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h!)))).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c!)))).toEqual({
      iss: 'D27MJGWNY3',
      iat: 1_800_000_000,
    });
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromB64url(sig!),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it('posts to the environment’s host with alert headers, reuses the token, and re-mints on ExpiredProviderToken', async () => {
    const { pem } = await p8();
    const config = { keyP8: pem, keyId: 'K', teamId: 'T', topic: 'io.musterd.app' };
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const ok = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return new Response(null, { status: 200, headers: { 'apns-id': 'apns-1' } });
    });
    const input = { body: '{}', expiresAt: 1_800_000_300_000, collapseId: 'ask-1' };
    const push = { token: TOKEN, environment: 'development' as const };
    await expect(sendApns(config, push, input, 1_800_000_000_000, ok)).resolves.toEqual({
      ok: true,
      status: 200,
      apnsId: 'apns-1',
    });
    expect(calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(calls[0]!.headers).toMatchObject({
      'apns-topic': 'io.musterd.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '1800000300',
      'apns-collapse-id': 'ask-1',
    });
    await sendApns(config, { ...push, environment: 'production' }, input, 1_800_000_600_000, ok);
    expect(calls[1]!.url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
    expect(calls[1]!.headers['authorization']).toBe(calls[0]!.headers['authorization']);

    const expired = vi.fn(async () =>
      Response.json({ reason: 'ExpiredProviderToken' }, { status: 403 }),
    );
    await expect(sendApns(config, push, input, 1_800_000_700_000, expired)).resolves.toEqual({
      ok: false,
      status: 403,
      reason: 'ExpiredProviderToken',
    });
    await sendApns(config, push, input, 1_800_000_800_000, ok);
    expect(calls[2]!.headers['authorization']).not.toBe(calls[0]!.headers['authorization']);
  });

  it('reports APNs’ reason for a dead token, and a network failure as not ok', async () => {
    const { pem } = await p8();
    const config = { keyP8: pem, keyId: 'K', teamId: 'T', topic: 'io.musterd.app' };
    const input = { body: '{}', expiresAt: 1_800_000_300_000, collapseId: 'x'.repeat(65) };
    const push = { token: TOKEN, environment: 'production' as const };
    let headers: Record<string, string> = {};
    const gone = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>;
      return Response.json({ reason: 'Unregistered' }, { status: 410 });
    });
    await expect(sendApns(config, push, input, 1_800_000_000_000, gone)).resolves.toEqual({
      ok: false,
      status: 410,
      reason: 'Unregistered',
    });
    // A collapse id past Apple's 64 bytes is left off rather than sent and refused.
    expect(headers['apns-collapse-id']).toBeUndefined();
    const down = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(sendApns(config, push, input, 1_800_000_000_000, down)).resolves.toEqual({
      ok: false,
    });
  });

  it('needs every piece of operator config', () => {
    expect(apnsConfigFrom({ APNS_KEY_P8: 'k', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't' })).toBeNull();
    expect(
      apnsConfigFrom({ APNS_KEY_P8: 'k', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't', APNS_TOPIC: 'o' }),
    ).toEqual({ keyP8: 'k', keyId: 'i', teamId: 't', topic: 'o' });
  });
});

describe('app frames and payload (ADR 676 §2)', () => {
  it('a small sealed body rides in the push with its route; a large one goes by ref', () => {
    const small = apnsPayload('revive', appDeliver('c'.repeat(2_000)));
    expect(small.inline).toBe(true);
    const parsed = JSON.parse(small.body);
    expect(parsed.aps).toMatchObject({
      'mutable-content': 1,
      'interruption-level': 'time-sensitive',
    });
    expect(parsed.musterd).toMatchObject({
      team: 'revive',
      binding: 'b1',
      ref: 'ask-1',
      expires_at: 1_800_000_300_000,
    });
    expect(parsed.musterd.sealed.ct).toHaveLength(2_000);
    expect(new TextEncoder().encode(small.body).length).toBeLessThanOrEqual(4_096);

    const large = apnsPayload('revive', appDeliver('c'.repeat(3_100)));
    expect(large.inline).toBe(false);
    expect(JSON.parse(large.body).musterd.sealed).toBeUndefined();
  });

  it('parses app_deliver and app_body, refusing a bad push token or a non-base64url seal', () => {
    const good = appDeliver('abc');
    expect(parseDaemonFrame(JSON.stringify(good))?.type).toBe('app_deliver');
    expect(
      parseDaemonFrame(
        JSON.stringify({ ...good, push: { token: 'XYZ', environment: 'production' } }),
      ),
    ).toBeNull();
    expect(
      parseDaemonFrame(JSON.stringify({ ...good, sealed: { v: 1, enc: 'a', ct: 'not base64!' } })),
    ).toBeNull();
    expect(
      parseDaemonFrame(
        JSON.stringify({ protocol: 1, type: 'app_body', request_id: 'r', sealed: null }),
      ),
    ).toEqual({ protocol: 1, type: 'app_body', request_id: 'r', sealed: null });
  });

  it('an app callback is checked for shape only, and names the ref its frame carries', () => {
    const sealed = { v: 1, enc: 'e', ct: 'c' };
    expect(appCallbackRef(JSON.stringify({ app: 1, kind: 'redeliver', binding: 'b1' }))).toBe('b1');
    expect(
      appCallbackRef(
        JSON.stringify({
          app: 1,
          kind: 'answer',
          binding: 'b1',
          ref: 'ask-1',
          expires_at: 1,
          sealed,
        }),
      ),
    ).toBe('ask-1');
    expect(
      appCallbackRef(JSON.stringify({ app: 1, kind: 'answer', binding: 'b1', ref: 'a' })),
    ).toBeNull();
    expect(appCallbackRef(JSON.stringify({ app: 2, kind: 'redeliver', binding: 'b1' }))).toBeNull();
    expect(appCallbackRef('payload=x')).toBeNull();
  });
});
