/**
 * The talk-only route boundary (ADR 621 §2). A talk-only seat — a guest, `can_coordinate: false` —
 * reaches only the routes a person needs to join, keep presence, read its inbox and the roster, read
 * the team timeline at its own grade, and send. Every other team route is coordination (lanes, goals,
 * seeds, memory, reports, policy, agents, invites, residency, sync, …) and is refused with
 * `forbidden` "talk-only seat". The send path narrows further by act (`protocol/route.ts`).
 *
 * The list is an allowlist on purpose: a route added later is refused to a guest until someone
 * decides it is talk, which is the Cloud spec's "nobody gets lane tools without a human deciding".
 */

/** `METHOD rest` pairs a talk-only seat may call. `rest` is the path after `/teams/:slug`. */
const TALK_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'GET ', // the roster (ADR 601 scrubs it for a broadcast reader)
  'GET /members',
  'GET /inbox',
  'GET /inbox/interrupt-check',
  'POST /inbox/cursor',
  'POST /inbox/idle-wake',
  'GET /messages', // the timeline at the reader's grade (`broadcast` for a guest, ADR 616)
  'POST /messages', // sends; `route.ts` allows only the talk acts
  'POST /claim',
  'POST /presence',
  'POST /availability',
  'POST /unbind',
  'GET /style-block',
  'GET /local-identity',
  'POST /signin-handoff',
  'GET /holds',
  'POST /holds/check',
  'POST /gate', // a harness's PreToolUse check must still answer for a guest's own session
  'GET /enforcement',
  'POST /doorbell/rings',
]);

/** Prefix routes a talk-only seat may call (`METHOD prefix`), for parameterised paths. */
const TALK_ONLY_PREFIXES: readonly string[] = ['POST /doorbell/rings/', 'GET /signin-handoff/'];

/** True when a talk-only seat may call `method rest` (ADR 621 §2). */
export function talkOnlyAllows(method: string, rest: string): boolean {
  const key = `${method} ${rest}`;
  return TALK_ONLY_ROUTES.has(key) || TALK_ONLY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Credentials that can belong to a talk-only seat: a human seat credential and an OAuth access token
 * (a phone, ADR 446). Agent keys, grants and observer tokens are never a guest's, so the guard does
 * not spend a lookup on them.
 */
export function mayBeTalkOnlyBearer(authorization: string | undefined): boolean {
  if (!authorization || !authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length).trim();
  return token.startsWith('mscr_') || token.startsWith('msat_');
}
