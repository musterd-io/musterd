/**
 * The Twitch channel title for one working session (ADR 711).
 *
 * The copy is `docs/design/twitch-channel-copy-spec.md` §3.1: a fixed half, then a tail that names
 * the work. The tail is derived here, mechanically, and a tail that breaks a rule becomes the
 * standing title rather than a bad one. Sloane owns the wording; this module does not invent a
 * shape.
 *
 * The write happens inside the capture machine, once, before ffmpeg. The operator CLI never sees
 * the token. A title we did not set is not patched — including its category — because replacing a
 * person's title is worse than leaving the standing one up.
 */
import { LANE_CONTENDING_STATES } from '@musterd/protocol';

/** Nick's half. It does not move. The space after the dash is part of it. */
export const TITLE_PREFIX = 'Coffee & musterd - ';
/** The specified exception to the 35-character tail cap. */
export const STANDING_TAIL = 'watch musterd agents build the platform live';
export const STANDING_TITLE = TITLE_PREFIX + STANDING_TAIL;
export const TAIL_MAX = 35;

/**
 * "Software and Game Development". Taken from the twitchtracker.com and twitchstats.net URL slugs
 * on 2026-10-22, not from a live Helix call.
 */
export const SOFTWARE_GAME_ID = '1469308723';

/** Optional. Absent, the title is off and the stream still starts. Not part of doctor’s fail list. */
export const TITLE_SECRET_NAMES = ['MUSTERD_TWITCH_CLIENT_ID', 'MUSTERD_TWITCH_TOKEN'] as const;

const HELIX = 'https://api.twitch.tv/helix';
const HELIX_TIMEOUT_MS = 8_000;

export interface TitleLane {
  state: string;
  goal_id: string | null;
  title: string;
  /** `undefined` is what an older daemon omits; only `'incident'` is excluded. */
  kind?: 'incident' | null | undefined;
}

export interface TitleGoal {
  id: string;
  title: string;
  /** `undefined` is what zod `.optional()` puts on a goal that never got a story. */
  story?: string | undefined;
  /** Present when the goal was withdrawn. The story of a retracted goal is not the session. */
  retracted?: unknown;
}

export type TitleDecision =
  | { kind: 'leave'; line: 'title left alone — channel title is not one we set' }
  | { kind: 'keep'; line: 'title unchanged' }
  | { kind: 'set'; line: 'title set'; title: string };

const WORKING: ReadonlySet<string> = LANE_CONTENDING_STATES;

/** A tail of one word is a category or a path, not the work: sloane's floor, 2026-10-27. */
function twoWords(text: string): boolean {
  return text.split(' ').filter((word) => word !== '').length >= 2;
}

/** A full session title: the standing one, or prefix plus a tail that already passed the rules. */
export function isSessionTitle(value: string): boolean {
  if (value === STANDING_TITLE) return true;
  if (!value.startsWith(TITLE_PREFIX)) return false;
  if (/[\r\n]/.test(value)) return false;
  const tail = value.slice(TITLE_PREFIX.length);
  if (tail.length === 0 || tail.length > TAIL_MAX) return false;
  if (!twoWords(tail)) return false;
  if (tail !== tail.toLowerCase()) return false;
  if (/\d/.test(tail)) return false;
  if (/[.!?]$/.test(tail)) return false;
  return true;
}

/**
 * The first clause, or null when what remains breaks a tail rule.
 *
 * A period is not a cut: `musterd.io` has to survive. `?`, `!`, an em dash, ` - `, `:`, and ` (`
 * are. "Name the work, not the process" is not mechanical — a clause that only fails that test
 * still returns, and the standing title is the caller's fallback when this returns null.
 */
export function clauseTail(raw: string): string | null {
  let text = raw.replace(/`/g, ' ').replace(/\s+/g, ' ').trim();
  let cutAt = text.length;
  for (const mark of [/\?/, /!/, /—/, /\s-\s/, /:/, /\s\(/]) {
    const at = text.search(mark);
    if (at >= 0 && at < cutAt) cutAt = at;
  }
  text = text.slice(0, cutAt);
  text = text.replace(/\bADR\s*-?\s*\d+\b/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim().toLowerCase();
  text = text.replace(/[.,;:!?…—\-'"”’)\]]+$/u, '').trim();
  if (!text) return null;
  if (!twoWords(text)) return null;
  if (text.length > TAIL_MAX) return null;
  if (/\d/.test(text)) return null;
  if (/[.!?]$/.test(text)) return null;
  return text;
}

function titled(tail: string | null): string | null {
  return tail ? TITLE_PREFIX + tail : null;
}

/**
 * One title for the whole session. More than one goal, or no clause that passes, is the standing
 * title — a successful standing title, not a failed read. The caller distinguishes those.
 */
export function sessionTitle(input: { lanes: TitleLane[]; goals: TitleGoal[] }): string {
  const working = input.lanes.filter((lane) => WORKING.has(lane.state) && lane.kind !== 'incident');
  const goalIds = [
    ...new Set(working.map((lane) => lane.goal_id).filter((id): id is string => Boolean(id))),
  ];
  const only = working.length === 1 ? working[0] : undefined;
  if (goalIds.length > 1) return STANDING_TITLE;
  if (goalIds.length === 1) {
    const goal = input.goals.find(
      (candidate) => candidate.id === goalIds[0] && !candidate.retracted,
    );
    if (goal) {
      return (
        titled(goal.story ? clauseTail(goal.story) : null) ??
        titled(clauseTail(goal.title)) ??
        titled(only ? clauseTail(only.title) : null) ??
        STANDING_TITLE
      );
    }
  }
  return titled(only ? clauseTail(only.title) : null) ?? STANDING_TITLE;
}

/**
 * Whether the channel still shows a title we are allowed to replace.
 *
 * Ours: empty, the standing title, the title we are about to ask for, or the title we asked for
 * last time. Anything else was typed by a person (or is an old title of ours that they put back
 * after we moved on). Those are left alone, category included. A person who types our exact next
 * string before we have ever set it cannot be told apart from us.
 */
export function decideTitle(args: {
  currentTitle: string;
  currentGameId: string;
  desired: string;
  prev: string;
}): TitleDecision {
  const owned =
    args.currentTitle === '' ||
    args.currentTitle === STANDING_TITLE ||
    args.currentTitle === args.desired ||
    (args.prev !== '' && args.currentTitle === args.prev);
  if (!owned) {
    return { kind: 'leave', line: 'title left alone — channel title is not one we set' };
  }
  if (args.currentTitle === args.desired && args.currentGameId === SOFTWARE_GAME_ID) {
    return { kind: 'keep', line: 'title unchanged' };
  }
  return { kind: 'set', line: 'title set', title: args.desired };
}

/** The two non-secret env slots. A value that is not a session title is not passed through. */
export function streamTitleEnv(desired: string, prev: string): string[] {
  const safeDesired = isSessionTitle(desired) ? desired : STANDING_TITLE;
  const safePrev = prev !== '' && isSessionTitle(prev) ? prev : '';
  return [
    '--env',
    `MUSTERD_STREAM_TITLE=${safeDesired}`,
    '--env',
    `MUSTERD_STREAM_TITLE_PREV=${safePrev}`,
  ];
}

type TitleFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

type HelixResult = { kind: 'ok'; body: unknown } | { kind: 'auth' } | { kind: 'fail' };

async function helix(
  fetchImpl: TitleFetch,
  url: string,
  init: RequestInit | undefined,
  parse: boolean,
): Promise<HelixResult> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HELIX_TIMEOUT_MS) });
  if (res.status === 401 || res.status === 403) return { kind: 'auth' };
  if (!res.ok) return { kind: 'fail' };
  if (!parse) return { kind: 'ok', body: null };
  try {
    return { kind: 'ok', body: await res.json() };
  } catch {
    return { kind: 'fail' };
  }
}

function userId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const row = data[0];
  if (!row || typeof row !== 'object') return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === 'string' && /^\d+$/.test(id) ? id : null;
}

function channelFields(body: unknown): { title: string; game_id: string } | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const row = data[0];
  if (!row || typeof row !== 'object') return null;
  const title = (row as { title?: unknown }).title;
  const gameId = (row as { game_id?: unknown }).game_id;
  if (typeof title !== 'string' || typeof gameId !== 'string') return null;
  return { title, game_id: gameId };
}

const OFF_UNSET = 'title off — twitch token unset';
const OFF_REJECTED = 'title off — twitch token rejected';
const OFF_UNREAD = 'title off — could not read the channel';

/**
 * Read the channel, then patch only when `decideTitle` says we own it and something differs.
 * Always resolves to one line. The line never includes the token, the client id, or the error
 * text — a thrown message can contain either secret.
 *
 * An empty env is safe: desired becomes the standing title, previous is empty, and a human title
 * is not one of the titles we own.
 */
export async function applyChannelTitle(
  env: NodeJS.ProcessEnv,
  fetchImpl: TitleFetch = fetch,
): Promise<string> {
  const token = env['MUSTERD_TWITCH_TOKEN']?.trim() ?? '';
  const clientId = env['MUSTERD_TWITCH_CLIENT_ID']?.trim() ?? '';
  if (!token || !clientId) return OFF_UNSET;

  const desiredRaw = env['MUSTERD_STREAM_TITLE'] ?? '';
  const prevRaw = env['MUSTERD_STREAM_TITLE_PREV'] ?? '';
  const desired = isSessionTitle(desiredRaw) ? desiredRaw : STANDING_TITLE;
  const prev = prevRaw !== '' && isSessionTitle(prevRaw) ? prevRaw : '';
  const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId };

  try {
    const users = await helix(fetchImpl, `${HELIX}/users`, { headers }, true);
    if (users.kind === 'auth') return OFF_REJECTED;
    if (users.kind !== 'ok') return OFF_UNREAD;
    const id = userId(users.body);
    if (!id) return OFF_UNREAD;

    const channel = await helix(
      fetchImpl,
      `${HELIX}/channels?broadcaster_id=${encodeURIComponent(id)}`,
      { headers },
      true,
    );
    if (channel.kind === 'auth') return OFF_REJECTED;
    if (channel.kind !== 'ok') return OFF_UNREAD;
    const current = channelFields(channel.body);
    if (!current) return OFF_UNREAD;

    const decision = decideTitle({
      currentTitle: current.title,
      currentGameId: current.game_id,
      desired,
      prev,
    });
    if (decision.kind !== 'set') return decision.line;

    const patched = await helix(
      fetchImpl,
      `${HELIX}/channels?broadcaster_id=${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: decision.title, game_id: SOFTWARE_GAME_ID }),
      },
      false,
    );
    if (patched.kind === 'auth') return OFF_REJECTED;
    if (patched.kind !== 'ok') return OFF_UNREAD;
    return decision.line;
  } catch {
    return OFF_UNREAD;
  }
}
