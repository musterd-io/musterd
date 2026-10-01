/**
 * Host-name isolation (spec §5.3): on Cloud a team lives at `<slug>.<suffix>`, and a request to
 * that host reaches only that team's routes. The credential is the second line (every credential
 * is minted for exactly one team) and RLS the last; this is the first, and it is pure.
 *
 * A mismatch is answered 404 by the caller — not 403 — so a host cannot be used to learn which
 * other teams exist.
 */

/** The team a Host header names under `suffix`, or null (the apex, an IP, a nested or foreign name). */
export function hostTeam(host: string | undefined, suffix: string): string | null {
  if (!host) return null;
  // Strip a port; a bracketed IPv6 literal never names a team.
  if (host.startsWith('[')) return null;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  const tail = `.${suffix.toLowerCase()}`;
  if (!name.endsWith(tail)) return null;
  const label = name.slice(0, -tail.length);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) ? label : null;
}

// Every route shape that names a team in its path (http.ts, oauth.ts, mcpHttp.ts). A route added
// with a new shape belongs here; hostIsolation.test.ts lists them.
const TEAM_PATHS: RegExp[] = [
  /^\/teams\/([^/]+)(?:\/|$)/,
  /^\/mcp\/([^/]+)$/,
  /^\/oauth\/([^/]+)(?:\/|$)/,
  /^\/\.well-known\/oauth-protected-resource\/mcp\/([^/]+)$/,
  /^\/\.well-known\/(?:oauth-authorization-server|openid-configuration)\/oauth\/([^/]+)$/,
  /^\/\.well-known\/oauth-authorization-server\/([^/]+)$/,
];

/** The team slug a request path addresses, or null for a global route. */
export function pathTeam(path: string): string | null {
  for (const re of TEAM_PATHS) {
    const m = re.exec(path);
    if (!m) continue;
    try {
      return decodeURIComponent(m[1]!).toLowerCase();
    } catch {
      return m[1]!.toLowerCase();
    }
  }
  return null;
}

/** May a request with this Host reach this path? Global routes answer on any host. */
export function hostAllows(host: string | undefined, path: string, suffix: string): boolean {
  const team = pathTeam(path);
  return team === null || hostTeam(host, suffix) === team;
}
