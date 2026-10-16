/**
 * The console's configuration (ADR 615). Every trust input is pinned here, from the environment,
 * once at boot — never derived from a request's Host header, a token's `jku`/`x5u`, or any URL a
 * caller supplies (big-body's security read, 2026-10-15).
 *
 * Hard rule 5: these variables carry a database password. An error names the variable, never its
 * value, and nothing here logs.
 */

export interface ConsoleConfig {
  /** The runtime login (DML on accounts/identities, INSERT-only on audit). Never the owner. */
  databaseUrl: string;
  /** The issuer this console signs as, e.g. `https://app.musterd.io`. Team servers pin the same
   *  string as `MUSTERD_CONSOLE_AUDIENCE`'s issuer; the JWKS is served under it. */
  issuer: string;
  /** Hosts this console answers on. The issuer's host always; extra names only by explicit list. */
  allowedHosts: string[];
  host: string;
  port: number;
  /** Build commit stamped by `pnpm build` (ADR 130); `/health` carries it, nothing else. */
  build: string | null;
  /**
   * OAuth clients (ADR 620). A provider is enabled only when both its id and secret are set; an
   * unconfigured provider's routes answer 404, as if they did not exist.
   */
  providers: Partial<Record<'github' | 'google', { clientId: string; clientSecret: string }>>;
  /** Magic-link email (ADR 620 decision 2): on only when the account id, token and sender are all set. */
  email: { accountId: string; apiToken: string; fromAddress: string; fromName: string } | null;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`the console needs ${name} — it is unset or empty`);
  return v;
}

function url(env: Env, name: string, protocols: string[]): URL {
  const raw = required(env, name);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // `new URL`'s own error quotes its input; a database URL carries a password.
    throw new Error(`${name} is not a valid URL`);
  }
  if (!protocols.includes(u.protocol)) throw new Error(`${name} must be a ${protocols[0]}// URL`);
  return u;
}

export function resolveConsoleConfig(env: Env, build: string | null = null): ConsoleConfig {
  url(env, 'MUSTERD_CONSOLE_DATABASE_URL', ['postgres:', 'postgresql:']);
  const issuerUrl = url(env, 'MUSTERD_CONSOLE_ISSUER', ['https:', 'http:']);
  if (issuerUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(issuerUrl.hostname))
    throw new Error('MUSTERD_CONSOLE_ISSUER must be https:// except on localhost');
  if (issuerUrl.pathname !== '/' || issuerUrl.search || issuerUrl.hash || issuerUrl.username)
    throw new Error('MUSTERD_CONSOLE_ISSUER must be an origin, with no path, query or credentials');
  const extra = (env['MUSTERD_CONSOLE_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const portRaw = env['MUSTERD_CONSOLE_PORT']?.trim() || '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('MUSTERD_CONSOLE_PORT must be a port number');
  const providers: ConsoleConfig['providers'] = {};
  for (const [p, prefix] of [
    ['github', 'MUSTERD_CONSOLE_GITHUB'],
    ['google', 'MUSTERD_CONSOLE_GOOGLE'],
  ] as const) {
    const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
    const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) providers[p] = { clientId, clientSecret };
    else if (clientId || clientSecret)
      throw new Error(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together`);
  }
  const emailVars = [
    'MUSTERD_CONSOLE_EMAIL_ACCOUNT_ID',
    'MUSTERD_CONSOLE_EMAIL_API_TOKEN',
    'MUSTERD_CONSOLE_EMAIL_FROM',
  ];
  const emailSet = emailVars.filter((v) => env[v]?.trim());
  if (emailSet.length > 0 && emailSet.length < emailVars.length)
    throw new Error(`${emailVars.join(', ')} must be set together`);
  const email =
    emailSet.length === emailVars.length
      ? {
          accountId: env['MUSTERD_CONSOLE_EMAIL_ACCOUNT_ID']!.trim(),
          apiToken: env['MUSTERD_CONSOLE_EMAIL_API_TOKEN']!.trim(),
          fromAddress: env['MUSTERD_CONSOLE_EMAIL_FROM']!.trim(),
          fromName: 'musterd',
        }
      : null;
  return {
    email,
    providers,
    databaseUrl: required(env, 'MUSTERD_CONSOLE_DATABASE_URL'),
    issuer: issuerUrl.origin,
    allowedHosts: [...new Set([issuerUrl.host.toLowerCase(), ...extra])],
    host: env['MUSTERD_CONSOLE_HOST']?.trim() || '0.0.0.0',
    port,
    build,
  };
}
