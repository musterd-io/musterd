import * as client from 'openid-client';

/**
 * GitHub and Google sign-in (ADR 620 decisions 1, 3, 5). Every endpoint is pinned here — never
 * discovered, never taken from a request. Google is OpenID Connect: the ID token's signature,
 * issuer, audience, expiry and nonce are verified by `openid-client`, and the identity is the
 * validated `sub` under the pinned issuer. GitHub is plain OAuth 2: there is no ID token and no
 * nonce, the access token is used once against the pinned `/user` endpoint, and the identity is
 * the numeric user id — never the login name or an email. Provider tokens are dropped after that.
 */
export type ProviderId = 'github' | 'google';
export const PROVIDERS: readonly ProviderId[] = ['github', 'google'];

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ProviderEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  /** GitHub only: the user endpoint the access token is spent on. */
  user_endpoint?: string;
}

export const PINNED: Record<ProviderId, ProviderEndpoints> = {
  google: {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  },
  github: {
    issuer: 'https://github.com',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    user_endpoint: 'https://api.github.com/user',
  },
};

/** Tests only: replace the pinned endpoints with a local fake and allow plain http to it. */
export interface ProviderOverrides {
  endpoints?: Partial<Record<ProviderId, ProviderEndpoints>>;
  fetch?: typeof fetch;
  insecure?: boolean;
}

const SCOPE: Record<ProviderId, string> = { google: 'openid email', github: '' };

export function callbackUrl(issuer: string, p: ProviderId): string {
  return `${issuer}/auth/${p}/callback`;
}

function configFor(p: ProviderId, creds: ProviderCredentials, o: ProviderOverrides = {}) {
  const ep = o.endpoints?.[p] ?? PINNED[p];
  const { user_endpoint: _u, ...server } = ep;
  const config = new client.Configuration(
    server,
    creds.clientId,
    undefined,
    client.ClientSecretPost(creds.clientSecret),
  );
  if (o.fetch) config[client.customFetch] = o.fetch as never;
  if (o.insecure) client.allowInsecureRequests(config);
  return { config, userEndpoint: ep.user_endpoint };
}

export interface StartedFlow {
  url: string;
  state: string;
  pkceVerifier: string;
  nonce: string | null;
}

/** The authorization URL for a fresh transaction, and the secrets the console must keep. */
export async function startFlow(
  p: ProviderId,
  creds: ProviderCredentials,
  issuer: string,
  o?: ProviderOverrides,
): Promise<StartedFlow> {
  const { config } = configFor(p, creds, o);
  const pkceVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = p === 'google' ? client.randomNonce() : null;
  const params: Record<string, string> = {
    redirect_uri: callbackUrl(issuer, p),
    code_challenge: await client.calculatePKCECodeChallenge(pkceVerifier),
    code_challenge_method: 'S256',
    state,
  };
  if (SCOPE[p]) params.scope = SCOPE[p];
  if (nonce) params.nonce = nonce;
  return { url: client.buildAuthorizationUrl(config, params).href, state, pkceVerifier, nonce };
}

export interface ProviderIdentity {
  provider: ProviderId | 'email';
  subject: string;
  /** A provider-verified email, kept for display only — never used to find or link an account. */
  email: string | null;
}

/**
 * Finish the flow: exchange the code (checking state and PKCE, and for Google the ID token and
 * nonce) and return who signed in. `query` is the callback's own query string; the URL it is read
 * against is rebuilt from the pinned issuer, never from the request's Host.
 */
export async function finishFlow(
  p: ProviderId,
  creds: ProviderCredentials,
  issuer: string,
  query: string,
  tx: { state: string; pkceVerifier: string; nonce: string | null },
  o?: ProviderOverrides,
): Promise<ProviderIdentity> {
  const { config, userEndpoint } = configFor(p, creds, o);
  const current = new URL(`${callbackUrl(issuer, p)}?${query}`);
  const tokens = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: tx.pkceVerifier,
    expectedState: tx.state,
    ...(tx.nonce ? { expectedNonce: tx.nonce, idTokenExpected: true } : {}),
  });
  if (p === 'google') {
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error('google returned no subject');
    const email =
      typeof claims.email === 'string' && claims.email_verified === true ? claims.email : null;
    return { provider: 'google', subject: claims.sub, email };
  }
  const doFetch = o?.fetch ?? fetch;
  const res = await doFetch(userEndpoint ?? PINNED.github.user_endpoint!, {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'musterd-console',
    },
  });
  if (!res.ok) throw new Error(`github user endpoint answered ${res.status}`);
  const user = (await res.json()) as { id?: unknown };
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id))
    throw new Error('github returned no numeric id');
  return { provider: 'github', subject: String(user.id), email: null };
}
