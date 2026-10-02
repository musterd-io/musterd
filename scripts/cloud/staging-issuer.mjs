#!/usr/bin/env node
/**
 * The STAGING console issuer (cloud increment 1D, lane 01M3Z42764): a stand-in for increment 2's
 * console, so a deployed cloud-mode server has a JWKS to trust and an operator can create a team on
 * it. The token shape is the test issuer's (`packages/server/src/cloud/testIssuer.ts`): ES256,
 * `aud` = the server's MUSTERD_CONSOLE_AUDIENCE, 60 s of life, a fresh `jti`. Increment 2's KMS-signed
 * console retires it (lane 01M3Z43V58).
 *
 *   node scripts/cloud/staging-issuer.mjs init
 *     Generates a P-256 key into ~/.musterd/cloud/staging-issuer.jwk (mode 600; refuses to replace
 *     one) and writes its PUBLIC JWKS into workers/staging-jwks/wrangler.toml for the worker that
 *     serves it. The private key never leaves that file.
 *
 *   node scripts/cloud/staging-issuer.mjs create-team <slug> --creator <name> [--display <text>]
 *     Mints one console token and POSTs it to https://<slug>.<suffix>/teams. The server answers
 *     with credentials it shows once; they go to ~/.musterd/cloud/teams/<slug>.json (mode 600).
 *     Prints the slug, the creator and the file — never a credential (hard rule 5).
 *
 * Env: MUSTERD_CONSOLE_AUDIENCE (default https://musterd.dev), MUSTERD_CLOUD_HOST_SUFFIX (default
 * musterd.dev). Both must match what the server runs with (deploy/cloud/fly.toml [env]).
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(homedir(), '.musterd', 'cloud');
const KEY = join(DIR, 'staging-issuer.jwk');
const WRANGLER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'workers',
  'staging-jwks',
  'wrangler.toml',
);
const AUDIENCE = process.env.MUSTERD_CONSOLE_AUDIENCE ?? 'https://musterd.dev';
const SUFFIX = process.env.MUSTERD_CLOUD_HOST_SUFFIX ?? 'musterd.dev';

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
}

function readKey() {
  const mode = statSync(KEY).mode & 0o777;
  if (mode & 0o077) throw new Error(`${KEY} is mode ${mode.toString(8)}; chmod 600 it`);
  const jwk = JSON.parse(readFileSync(KEY, 'utf8'));
  return { kid: jwk.kid, key: createPrivateKey({ key: jwk, format: 'jwk' }) };
}

function init() {
  if (existsSync(KEY)) throw new Error(`${KEY} exists; the staging key is not replaced in place`);
  const kid = `staging-${randomUUID()}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writePrivate(KEY, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid }));
  const jwks = JSON.stringify({
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }],
  });
  const toml = readFileSync(WRANGLER, 'utf8').replace(/^JWKS = .*$/m, `JWKS = '${jwks}'`);
  writeFileSync(WRANGLER, toml);
  console.log(`staging issuer key ${kid} written to ${KEY} (mode 600)`);
  console.log(
    `public JWKS written to ${WRANGLER} — deploy it: (cd workers/staging-jwks && wrangler deploy)`,
  );
}

function token() {
  const { kid, key } = readKey();
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid })}.${b64({
    iss: 'musterd-console-staging',
    sub: 'acct_staging_operator',
    aud: AUDIENCE,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  })}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

async function createTeam(args) {
  const slug = args[0];
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i > 0 ? args[i + 1] : undefined;
  };
  const creator = flag('creator');
  if (!slug || !creator)
    throw new Error('usage: create-team <slug> --creator <name> [--display <text>]');
  const out = join(DIR, 'teams', `${slug}.json`);
  if (existsSync(out)) throw new Error(`${out} exists; that team's credentials are already saved`);
  const res = await fetch(`https://${slug}.${SUFFIX}/teams`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug, display: flag('display'), creator: { name: creator } }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 201) {
    // Error bodies carry a code and a reason, never a credential.
    throw new Error(`POST /teams answered ${res.status}: ${JSON.stringify(body)}`);
  }
  writePrivate(out, JSON.stringify({ host: `https://${slug}.${SUFFIX}`, ...body }, null, 2));
  console.log(
    `team ${body.team.slug} created; ${creator} is its admin; credentials in ${out} (mode 600)`,
  );
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'init') init();
  else if (cmd === 'create-team') await createTeam(rest);
  else throw new Error('usage: staging-issuer.mjs init | create-team <slug> --creator <name>');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
