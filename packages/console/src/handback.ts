import { methodsOf } from './accounts.js';
import type { Queryable } from './db.js';
import { PAGE_CSP } from './pages.js';
import type { Session } from './sessions.js';
import { audienceOk } from './tokens.js';

/**
 * The team hand-back (ADR 722 §1, ADR 818). A hosted team's `/live/signin/start` sends the browser
 * here with `aud`, `team` and `state`; the console signs an identity statement for that audience
 * and answers a form that POSTs it, with the state, to the team's own callback. The callback URL is
 * built from the team slug and the configured host suffix — never from the query — so there is no
 * open redirect, and the statement never lands in a URL.
 */

/** A team slug: the team server's own rule (`store/teams.ts`). */
export const TEAM_SLUG = /^[a-z0-9-]{1,32}$/;
/** The team's one-time state: base64url, 32 random bytes in practice; bounded either way. */
export const HANDBACK_STATE = /^[A-Za-z0-9_-]{16,128}$/;

export interface Handback {
  aud: string;
  team: string;
  state: string;
}

const PARAMS = ['aud', 'team', 'state'] as const;

/**
 * The shape alone — no configuration: exactly `/handback`, exactly the three params once each,
 * each well-formed. Whether `aud` is one this console serves is the route's check.
 */
export function parseHandbackShape(path: string): Handback | null {
  const q = path.indexOf('?');
  if (q < 0 || path.slice(0, q) !== '/handback') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(path.slice(q + 1));
  } catch {
    return null;
  }
  const keys = [...params.keys()];
  if (keys.length !== PARAMS.length || PARAMS.some((k) => params.getAll(k).length !== 1))
    return null;
  const aud = params.get('aud')!;
  const team = params.get('team')!;
  const state = params.get('state')!;
  if (!audienceOk(aud) || !TEAM_SLUG.test(team) || !HANDBACK_STATE.test(state)) return null;
  return { aud, team, state };
}

/** The one spelling of a hand-back path: what a sign-in may return to (`returnpath.ts`). */
export function handbackPath(h: Handback): string {
  return `/handback?${new URLSearchParams({ aud: h.aud, team: h.team, state: h.state }).toString()}`;
}

/** Where the statement goes: the team's own origin under the configured suffix. */
export function callbackUrl(team: string, suffix: string): string {
  return `https://${team}.${suffix}/live/signin/callback`;
}

/** The page CSP, plus our own submit script, with the team's callback origin as the only form target. */
export function handbackCsp(callbackOrigin: string): string {
  return PAGE_CSP.replace(/form-action [^;]*;/, `form-action ${callbackOrigin};`).replace(
    "default-src 'none';",
    "default-src 'none'; script-src 'self';",
  );
}

/**
 * The email a statement carries: the signed-in identity's, else the first the account holds, else
 * none — a GitHub identity has none, and that is fine (ADR 818). Display data only; the team server
 * never reads it.
 */
export async function statementEmail(db: Queryable, session: Session): Promise<string | null> {
  const methods = await methodsOf(db, session.accountId, {
    provider: session.identityProvider,
    subject: session.identitySubject,
  });
  return methods.find((m) => m.current)?.email ?? methods.find((m) => m.email)?.email ?? null;
}
