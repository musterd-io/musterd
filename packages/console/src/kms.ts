import { createHash, createSign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { derToP1363, publicJwkFromPem, type PublicJwk, type TokenSigner } from './tokens.js';

/**
 * Cloud KMS over REST (ADR 685). A service-account JWT is exchanged for a bearer, then two calls:
 * `getPublicKey` and `asymmetricSign`. The private key never leaves Google. No KMS SDK (hard rule 6).
 * Errors name the call and the HTTP status. They never include the assertion, the signature, or
 * the credential file.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KMS_ORIGIN = 'https://cloudkms.googleapis.com/v1/';
const SCOPE = 'https://www.googleapis.com/auth/cloudkms';
const FETCH_TIMEOUT_MS = 5_000;
/** Refresh the bearer this long before Google says it expires. */
const TOKEN_SKEW_MS = 60_000;

/**
 * A cryptoKeyVersion resource name. Checked before it is concatenated onto the KMS origin, so it
 * cannot become another host.
 */
export const KMS_KEY_VERSION =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,30}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/[1-9][0-9]{0,5}$/;

export interface KmsCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface KmsSignerOptions {
  credentials: KmsCredentials;
  fetch?: typeof fetch;
  now?: () => number;
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');

function assertKeyVersion(keyVersion: string): void {
  if (!KMS_KEY_VERSION.test(keyVersion))
    throw new Error('MUSTERD_CONSOLE_KMS_KEY is not a Cloud KMS cryptoKeyVersion resource name');
}

/** Parse a service-account JSON. The message names neither the email nor the key. */
export function serviceAccountFrom(raw: string): KmsCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('console KMS credentials are missing client_email or private_key');
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('console KMS credentials are missing client_email or private_key');
  const rec = parsed as Record<string, unknown>;
  const clientEmail = typeof rec['client_email'] === 'string' ? rec['client_email'] : '';
  const privateKey = typeof rec['private_key'] === 'string' ? rec['private_key'] : '';
  if (!clientEmail || !privateKey.includes('PRIVATE KEY'))
    throw new Error('console KMS credentials are missing client_email or private_key');
  return { clientEmail, privateKey };
}

/**
 * Read the credential file. Refuses a file group or other users can read (mode 600).
 * An error names the variable, never the path or the contents.
 */
export async function loadServiceAccount(path: string): Promise<KmsCredentials> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error('MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE could not be read');
  }
  if ((info.mode & 0o077) !== 0)
    throw new Error('MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE must not be readable by other users');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error('MUSTERD_CONSOLE_KMS_CREDENTIALS_FILE could not be read');
  }
  return serviceAccountFrom(raw);
}

function assertion(creds: KmsCredentials, nowS: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowS,
      exp: nowS + 3600,
    }),
  );
  const input = `${header}.${payload}`;
  const sig = createSign('RSA-SHA256');
  sig.update(input);
  sig.end();
  return `${input}.${sig.sign(creds.privateKey).toString('base64url')}`;
}

/**
 * A signer bound to one cryptoKeyVersion. The public JWK is cached for the process. The bearer
 * is cached until a minute before it expires. `sign` sends a precomputed SHA-256 so Cloud KMS
 * does not hash the input a second time, then converts the DER signature to ieee-p1363.
 */
export function kmsSigner(cfg: { keyVersion: string }, opts: KmsSignerOptions): TokenSigner {
  assertKeyVersion(cfg.keyVersion);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = `${KMS_ORIGIN}${cfg.keyVersion}`;
  let published: PublicJwk | null = null;
  let loading: Promise<PublicJwk> | null = null;
  let bearer: { token: string; expMs: number } | null = null;
  let exchanging: Promise<string> | null = null;

  async function call(label: string, url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`console KMS ${label} failed`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`console KMS ${label} failed (HTTP ${res.status})`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`console KMS ${label} failed`);
    }
  }

  async function accessToken(): Promise<string> {
    const t = now();
    if (bearer && t < bearer.expMs - TOKEN_SKEW_MS) return bearer.token;
    exchanging ??= (async () => {
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion(opts.credentials, Math.floor(now() / 1000)),
      });
      const parsed = await call('token exchange', TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const rec = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const token = typeof rec['access_token'] === 'string' ? rec['access_token'] : '';
      const expiresIn = typeof rec['expires_in'] === 'number' ? rec['expires_in'] : 3600;
      if (!token) throw new Error('console KMS token exchange failed');
      bearer = { token, expMs: now() + expiresIn * 1000 };
      return token;
    })().finally(() => {
      exchanging = null;
    });
    return exchanging;
  }

  async function fetchPublic(): Promise<PublicJwk> {
    const token = await accessToken();
    const parsed = await call('public key', `${base}/publicKey`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const pem =
      parsed && typeof parsed === 'object' && typeof (parsed as { pem?: unknown }).pem === 'string'
        ? (parsed as { pem: string }).pem
        : '';
    if (!pem) throw new Error('console KMS public key failed');
    try {
      return publicJwkFromPem(pem);
    } catch {
      throw new Error('console KMS public key failed');
    }
  }

  return {
    publicJwk() {
      if (published) return Promise.resolve(published);
      loading ??= fetchPublic()
        .then((jwk) => {
          published = jwk;
          return jwk;
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    async sign(input) {
      const token = await accessToken();
      const digest = createHash('sha256').update(input).digest('base64');
      const parsed = await call('sign', `${base}:asymmetricSign`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ digest: { sha256: digest } }),
      });
      const signature =
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { signature?: unknown }).signature === 'string'
          ? (parsed as { signature: string }).signature
          : '';
      if (!signature) throw new Error('console KMS sign failed');
      try {
        return derToP1363(Buffer.from(signature, 'base64'));
      } catch {
        throw new Error('console KMS sign failed');
      }
    },
  };
}
