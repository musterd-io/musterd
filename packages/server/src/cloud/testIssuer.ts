import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * The increment-1 TEST ISSUER (spec §5.2): a JWKS and an ES256 signer with the console's token
 * shape, so cloud mode's admin path is exercised before the console exists (increment 2 swaps
 * `MUSTERD_CONSOLE_JWKS_URL` to the real one). Tests only: no runtime module imports this file
 * (`loopbackAudit.test.ts` pins it), and a server trusts it only when its JWKS URL points here.
 */
export interface TestIssuer {
  readonly kid: string;
  /** `http://127.0.0.1:<port>/jwks` once `serve()` resolved. */
  readonly url: string;
  /** How many times the JWKS was fetched — the cache's refetch discipline is observable. */
  readonly fetches: number;
  jwks(): { keys: Record<string, unknown>[] };
  /** A signed compact JWS; `header` overrides land on the protected header. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
  /** A token in the console's shape for `aud`: fresh `jti`, 60 s life; `over` replaces claims. */
  token(aud: string, over?: Record<string, unknown>): string;
  /** Replace the signing key (new kid); the JWKS publishes only the new one. */
  rotate(): void;
  /** While down, the JWKS answers 503 (still counted in `fetches`). */
  setDown(down: boolean): void;
  serve(): Promise<void>;
  close(): Promise<void>;
}

export function testIssuer(opts: { kid?: string } = {}): TestIssuer {
  let key: { kid: string; priv: KeyObject; pub: KeyObject };
  const fresh = (kid: string) => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { kid, priv: privateKey, pub: publicKey };
  };
  key = fresh(opts.kid ?? randomUUID());
  let server: Server | null = null;
  let url = '';
  let fetches = 0;
  let down = false;
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

  const issuer: TestIssuer = {
    get kid() {
      return key.kid;
    },
    get url() {
      return url;
    },
    get fetches() {
      return fetches;
    },
    jwks: () => ({
      keys: [{ ...key.pub.export({ format: 'jwk' }), kid: key.kid, alg: 'ES256', use: 'sig' }],
    }),
    sign(claims, header = {}) {
      const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: key.kid, ...header })}.${b64(claims)}`;
      const sig = sign('sha256', Buffer.from(input), { key: key.priv, dsaEncoding: 'ieee-p1363' });
      return `${input}.${sig.toString('base64url')}`;
    },
    token(aud, over = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: 'musterd-console-test',
        sub: 'acct_test',
        aud,
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        ...over,
      };
      for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
      return issuer.sign(claims);
    },
    rotate() {
      key = fresh(randomUUID());
    },
    setDown(v) {
      down = v;
    },
    async serve() {
      server = createServer((req, res) => {
        if (req.url !== '/jwks') {
          res.writeHead(404).end();
          return;
        }
        fetches++;
        if (down) {
          res.writeHead(503).end();
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(issuer.jwks()));
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      const addr = server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/jwks`;
    },
    async close() {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    },
  };
  return issuer;
}
