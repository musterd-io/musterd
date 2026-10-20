import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify,
} from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kmsSigner, loadServiceAccount, serviceAccountFrom } from './kms.js';
import { derToP1363, publicJwkFromPem, signConsoleToken } from './tokens.js';

const KEY =
  'projects/musterd-kms/locations/global/keyRings/console/cryptoKeys/console-signing/cryptoKeyVersions/1';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const creds = {
  clientEmail: 'console-signer@musterd-kms.iam.gserviceaccount.com',
  privateKey: rsaPem,
};
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();

interface Hit {
  url: string;
  body: string;
}

function mock(over: { tokenStatus?: number; pem?: string; signature?: string } = {}): {
  fetch: typeof fetch;
  hits: Hit[];
} {
  const hits: Hit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const raw = init?.body;
    const body =
      typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? raw.toString() : '';
    hits.push({ url, body });
    if (url.endsWith('/token')) {
      if ((over.tokenStatus ?? 200) !== 200)
        return new Response('SECRETLEAK assertion echo', { status: over.tokenStatus });
      return Response.json({ access_token: 'ya29.test-bearer', expires_in: 3600 });
    }
    if (url.endsWith('/publicKey'))
      return Response.json({ pem: over.pem ?? pem, algorithm: 'EC_SIGN_P256_SHA256' });
    if (url.endsWith(':asymmetricSign')) {
      const signature =
        over.signature ??
        cryptoSign('sha256', Buffer.from('fixed'), ec.privateKey).toString('base64');
      return Response.json({ signature });
    }
    return new Response('no', { status: 404 });
  };
  return { fetch: fetchImpl, hits };
}

describe('kmsSigner (ADR 685)', () => {
  it('refuses a resource name that is not a cryptoKeyVersion, before any request', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response('no');
    };
    expect(() =>
      kmsSigner(
        { keyVersion: 'https://evil.example/SECRET' },
        { credentials: creds, fetch: fetchImpl },
      ),
    ).toThrow(/MUSTERD_CONSOLE_KMS_KEY/);
    try {
      kmsSigner(
        { keyVersion: 'https://evil.example/SECRET' },
        { credentials: creds, fetch: fetchImpl },
      );
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
      expect(String(e)).not.toContain('evil.example');
    }
    expect(called).toBe(false);
  });

  it('caches the bearer and the public key, and sends a precomputed SHA-256', async () => {
    const canned = cryptoSign('sha256', Buffer.from('fixed'), ec.privateKey);
    const { fetch: doFetch, hits } = mock({ signature: canned.toString('base64') });
    const signer = kmsSigner({ keyVersion: KEY }, { credentials: creds, fetch: doFetch });
    const jwk = await signer.publicJwk();
    expect(jwk).toEqual(publicJwkFromPem(pem));
    await signer.publicJwk();
    const input = Buffer.from('header.payload');
    const raw = Buffer.from(await signer.sign(input));
    await signer.sign(input);
    expect(hits.filter((h) => h.url.endsWith('/token'))).toHaveLength(1);
    expect(hits.filter((h) => h.url.endsWith('/publicKey'))).toHaveLength(1);
    expect(hits.filter((h) => h.url.endsWith(':asymmetricSign'))).toHaveLength(2);
    const signHit = hits.find((h) => h.url.endsWith(':asymmetricSign'));
    expect(JSON.parse(signHit!.body)).toEqual({
      digest: { sha256: createHash('sha256').update(input).digest('base64') },
    });
    expect(signHit!.url).toBe(`https://cloudkms.googleapis.com/v1/${KEY}:asymmetricSign`);
    expect(raw.equals(derToP1363(canned))).toBe(true);
    expect(
      verify('sha256', Buffer.from('fixed'), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, raw),
    ).toBe(true);
  });

  it('names the HTTP status and does not echo the response or the assertion', async () => {
    const { fetch: doFetch } = mock({ tokenStatus: 401 });
    const signer = kmsSigner({ keyVersion: KEY }, { credentials: creds, fetch: doFetch });
    await expect(signer.publicJwk()).rejects.toThrow(
      'console KMS token exchange failed (HTTP 401)',
    );
    try {
      await signer.publicJwk();
    } catch (e) {
      const msg = String(e);
      expect(msg).not.toContain('SECRETLEAK');
      expect(msg).not.toContain('PRIVATE KEY');
      expect(msg).not.toContain('ya29');
    }
  });

  it('refuses a public key that is not EC P-256', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const { fetch: doFetch } = mock({ pem: other });
    const signer = kmsSigner({ keyVersion: KEY }, { credentials: creds, fetch: doFetch });
    await expect(signer.publicJwk()).rejects.toThrow('console KMS public key failed');
  });

  it('turns a transport failure into a fixed sentence', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED https://evil.example/SECRET');
    };
    const signer = kmsSigner({ keyVersion: KEY }, { credentials: creds, fetch: fetchImpl });
    await expect(signer.sign(Buffer.from('x'))).rejects.toThrow(
      'console KMS token exchange failed',
    );
    try {
      await signer.sign(Buffer.from('x'));
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
  });
});

describe('loadServiceAccount', () => {
  it('reads a mode-600 file and refuses one other users can read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kms-'));
    const path = join(dir, 'signer.json');
    const raw = JSON.stringify({
      client_email: 'console-signer@musterd-kms.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n',
    });
    await writeFile(path, raw, { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(loadServiceAccount(path)).rejects.toThrow(/must not be readable by other users/);
    await chmod(path, 0o600);
    expect(await loadServiceAccount(path)).toEqual(serviceAccountFrom(raw));
    await expect(loadServiceAccount(join(dir, 'missing.json'))).rejects.toThrow(
      /could not be read/,
    );
  });

  it('does not echo a credential that is not a service-account key', () => {
    expect(() => serviceAccountFrom('{"private_key":"SECRETLEAK"}')).toThrow(
      /client_email or private_key/,
    );
    try {
      serviceAccountFrom('{"private_key":"SECRETLEAK"}');
    } catch (e) {
      expect(String(e)).not.toContain('SECRETLEAK');
    }
  });
});

const liveKey = process.env['MUSTERD_CONSOLE_KMS_KEY'];
const liveFile = process.env['MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE'];

describe('Cloud KMS, this machine', () => {
  it.skipIf(!liveKey || !liveFile)(
    'signs with the configured key and the published JWK verifies it',
    async () => {
      const signer = kmsSigner(
        { keyVersion: liveKey! },
        { credentials: await loadServiceAccount(liveFile!) },
      );
      const jwk = await signer.publicJwk();
      const { token } = await signConsoleToken(signer, {
        iss: 'https://app.musterd.io',
        sub: 'acct_live',
        aud: 'https://cloud.test',
        nowS: Math.floor(Date.now() / 1000),
      });
      const [h, p, s] = token.split('.');
      expect(JSON.parse(Buffer.from(h!, 'base64url').toString()).kid).toBe(jwk.kid);
      expect(
        verify(
          'sha256',
          Buffer.from(`${h}.${p}`),
          {
            key: createPublicKey({ key: jwk, format: 'jwk' }),
            dsaEncoding: 'ieee-p1363',
          },
          Buffer.from(s!, 'base64url'),
        ),
      ).toBe(true);
    },
  );
});
