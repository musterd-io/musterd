/**
 * Cloud mode (spec 2026-09-29 §5): `MUSTERD_MODE=cloud` is one flag with a defined set of effects.
 * This module holds the configuration half — the variables cloud mode requires and how they are
 * read. Every cloud effect elsewhere keys on `config.mode === 'cloud'`; self-hosted is untouched.
 *
 * Hard rule 5: these variables carry database passwords. An error names the variable, never its
 * value, and nothing here logs.
 */

export interface CloudConfig {
  /** The pooled app-role login (`musterd_app`, RLS-bound) for the coordination store. */
  databaseAppUrl: string;
  /** The pooled operator login (`musterd_operator`, BYPASSRLS) for the coordination store. */
  databaseOperatorUrl: string;
  /** The trace store's twins (ADR 445 §3: a separate database in Cloud). */
  traceDatabaseAppUrl: string;
  traceDatabaseOperatorUrl: string;
  /** Where the console publishes its signing keys (§4.3); the test issuer until increment 2. */
  consoleJwksUrl: string;
  /** The `aud` a console token must carry to be accepted by this team server (§4.3). */
  consoleAudience: string;
  /** Team hosts are `<slug>.<hostSuffix>` (§5.3); lowercase, no leading dot. */
  hostSuffix: string;
  /**
   * Connections per Postgres pool (one pool per role per store). Optional `MUSTERD_PG_POOL_SIZE`;
   * the driver's default (10) when unset. A §8.1 load-run knob (lane 01M3Z455NE).
   */
  pgPoolSize?: number;
}

/** Every variable cloud mode reads, in the order a refusal names them. */
export const CLOUD_ENV = [
  'MUSTERD_MODE',
  'MUSTERD_DATABASE_APP_URL',
  'MUSTERD_DATABASE_OPERATOR_URL',
  'MUSTERD_TRACE_DATABASE_APP_URL',
  'MUSTERD_TRACE_DATABASE_OPERATOR_URL',
  'MUSTERD_CONSOLE_JWKS_URL',
  'MUSTERD_CONSOLE_AUDIENCE',
  'MUSTERD_CLOUD_HOST_SUFFIX',
] as const;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`cloud mode needs ${name} — it is unset or empty`);
  return v;
}

/** Parse without letting the value reach the message: `new URL`'s own error quotes its input. */
function urlOf(env: Env, name: string): URL {
  const raw = required(env, name);
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
}

/** A required `postgres://` URL from `env`; refusals name `name`, never the value. */
export function postgresUrl(env: Env, name: string): string {
  const u = urlOf(env, name);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:')
    throw new Error(`${name} must be a postgres:// URL`);
  return required(env, name);
}

/** An optional positive integer; refuses a malformed value by name. */
function optionalPositiveInt(env: Env, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function jwksUrl(env: Env, name: string): string {
  const u = urlOf(env, name);
  // https always; plain http only to this machine, which is where the test issuer serves.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname)))
    throw new Error(`${name} must be an https:// URL`);
  return required(env, name);
}

/**
 * The cloud block, or null when this is a self-hosted daemon. Refuses — naming the variable — on an
 * unknown mode or any missing/malformed cloud variable: a cloud server that silently fell back to a
 * local SQLite file would serve an empty team as if it were the real one.
 */
export function resolveCloudConfig(env: Env = process.env): CloudConfig | null {
  const mode = (env['MUSTERD_MODE'] ?? '').trim();
  if (mode === '' || mode === 'self-hosted') return null;
  if (mode !== 'cloud') throw new Error('MUSTERD_MODE must be "cloud" or "self-hosted" (or unset)');
  const suffix = required(env, 'MUSTERD_CLOUD_HOST_SUFFIX').toLowerCase().replace(/^\.+/, '');
  const poolSize = optionalPositiveInt(env, 'MUSTERD_PG_POOL_SIZE');
  return {
    databaseAppUrl: postgresUrl(env, 'MUSTERD_DATABASE_APP_URL'),
    databaseOperatorUrl: postgresUrl(env, 'MUSTERD_DATABASE_OPERATOR_URL'),
    traceDatabaseAppUrl: postgresUrl(env, 'MUSTERD_TRACE_DATABASE_APP_URL'),
    traceDatabaseOperatorUrl: postgresUrl(env, 'MUSTERD_TRACE_DATABASE_OPERATOR_URL'),
    consoleJwksUrl: jwksUrl(env, 'MUSTERD_CONSOLE_JWKS_URL'),
    consoleAudience: required(env, 'MUSTERD_CONSOLE_AUDIENCE'),
    hostSuffix: suffix,
    ...(poolSize !== undefined ? { pgPoolSize: poolSize } : {}),
  };
}
