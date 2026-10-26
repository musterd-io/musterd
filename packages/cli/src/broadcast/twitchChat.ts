/**
 * Twitch chat's `!who <member>` (ADR 740). Reads the channel's chat over EventSub and hands an
 * accepted name to the page — and to nothing else. This module holds no team credential and opens no
 * connection to the daemon: chat can change what the stream shows, never what the team does.
 */

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/** One accepted command per viewer per this long, and one plate across the channel per that. */
export const PER_VIEWER_MS = 30_000;
export const GLOBAL_MS = 6_000;

const WHO = /^!who\s+@?([A-Za-z0-9_-]{1,32})\s*$/i;

/** The allowlist, compiled in: today one command. Anything else is null and is ignored silently. */
export function parseWho(text: string): string | null {
  return WHO.exec(text.trim())?.[1] ?? null;
}

/** Both rate limits. Over either one the command is dropped, never queued. */
export function makeChatGate(now: () => number = Date.now) {
  const lastByViewer = new Map<string, number>();
  let lastGlobal = -Infinity;
  return (viewer: string): boolean => {
    const t = now();
    if (t - lastGlobal < GLOBAL_MS) return false;
    if (t - (lastByViewer.get(viewer) ?? -Infinity) < PER_VIEWER_MS) return false;
    lastGlobal = t;
    lastByViewer.set(viewer, t);
    if (lastByViewer.size > 5000) lastByViewer.clear(); // bounded; a reset only forgives early
    return true;
  };
}

export interface ChatCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The channel's login, e.g. `musterd`. */
  channel: string;
}

/** `MUSTERD_TWITCH_CHAT_*` — all four, or the reader stays off. */
export function chatCredsFromEnv(env: NodeJS.ProcessEnv = process.env): ChatCreds | null {
  const clientId = env['MUSTERD_TWITCH_CHAT_CLIENT_ID']?.trim();
  const clientSecret = env['MUSTERD_TWITCH_CHAT_CLIENT_SECRET']?.trim();
  const refreshToken = env['MUSTERD_TWITCH_CHAT_REFRESH_TOKEN']?.trim();
  const channel = env['MUSTERD_TWITCH_CHAT_CHANNEL']?.trim();
  if (!clientId || !clientSecret || !refreshToken || !channel) return null;
  return { clientId, clientSecret, refreshToken, channel };
}

/** The slice of a WebSocket the reader uses, so a test can stand in for Twitch. */
export interface ChatSocket {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export interface ChatReaderDeps {
  creds: ChatCreds;
  onWho: (name: string) => void;
  log: (line: string) => void;
  fetch?: typeof fetch;
  connect?: (url: string) => ChatSocket;
  now?: () => number;
  /** Delay before reconnecting after a drop. */
  backoffMs?: number;
}

type Frame = {
  metadata?: { message_type?: string };
  payload?: {
    session?: { id?: string; reconnect_url?: string; keepalive_timeout_seconds?: number };
    subscription?: { type?: string; status?: string };
    event?: { chatter_user_login?: string; message?: { text?: string } };
  };
};

/**
 * The reader. Logs a state change and each accepted command — never a token, a rejected message,
 * or a viewer's name. Returns its stop.
 */
export function startChatReader(deps: ChatReaderDeps): () => void {
  const http = deps.fetch ?? fetch;
  const connect = deps.connect ?? ((url: string) => new WebSocket(url) as unknown as ChatSocket);
  const gate = makeChatGate(deps.now);
  const backoff = deps.backoffMs ?? 10_000;
  let stopped = false;
  let sock: ChatSocket | null = null;
  let token = '';
  // Twitch may hand back a new refresh token on any refresh; the old one can stop working. Keep the
  // newest for this run, and say once that the stored secret is behind (the machine is --rm).
  let refreshToken = deps.creds.refreshToken;
  let rotationSaid = false;
  let ids: { broadcaster: string; bot: string } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const refresh = async (): Promise<void> => {
    const r = await http(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: deps.creds.clientId,
        client_secret: deps.creds.clientSecret,
      }).toString(),
    });
    if (!r.ok) throw new Error(`token refresh refused (${r.status})`);
    const body = (await r.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token) throw new Error('token refresh returned no access token');
    token = body.access_token;
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      refreshToken = body.refresh_token;
      if (!rotationSaid) {
        rotationSaid = true;
        deps.log(
          'chat: Twitch rotated the refresh token — this run uses the new one, but the stored ' +
            'MUSTERD_TWITCH_CHAT_REFRESH_TOKEN may stop working; re-authorize the bot and set it ' +
            'again before the next start (ADR 740)',
        );
      }
    }
  };

  const helix = async (path: string, init: RequestInit = {}, again = true): Promise<Response> => {
    const r = await http(`${HELIX}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
        'client-id': deps.creds.clientId,
      },
    });
    if (r.status === 401 && again) {
      await refresh();
      return helix(path, init, false);
    }
    return r;
  };

  const resolveIds = async (): Promise<{ broadcaster: string; bot: string }> => {
    const user = async (q: string): Promise<string> => {
      const r = await helix(`/users${q}`);
      if (!r.ok) throw new Error(`user lookup refused (${r.status})`);
      const id = ((await r.json()) as { data?: { id?: string }[] }).data?.[0]?.id;
      if (!id) throw new Error('user lookup found no one');
      return id;
    };
    return {
      broadcaster: await user(`?login=${encodeURIComponent(deps.creds.channel)}`),
      bot: await user(''), // the token's own user
    };
  };

  const subscribe = async (sessionId: string): Promise<void> => {
    ids ??= await resolveIds();
    const r = await helix('/eventsub/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: ids.broadcaster, user_id: ids.bot },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    if (!r.ok) throw new Error(`subscription refused (${r.status})`);
    deps.log('chat: subscribed');
  };

  const fail = (why: string): void => {
    deps.log(`chat: ${why} — reconnecting`);
    sock?.close();
    sock = null;
    schedule(EVENTSUB_URL);
  };

  const schedule = (url: string): void => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      open(url);
    }, backoff);
  };

  const open = (url: string): void => {
    if (stopped) return;
    const s = connect(url);
    sock = s;
    let welcomed = false;
    s.onmessage = (ev) => {
      if (sock !== s) return;
      let f: Frame;
      try {
        f = JSON.parse(String(ev.data)) as Frame;
      } catch {
        return;
      }
      switch (f.metadata?.message_type) {
        case 'session_welcome': {
          const id = f.payload?.session?.id;
          if (!id) return fail('welcome had no session');
          // A welcome after a reconnect keeps its subscriptions; only the first one subscribes.
          if (url !== EVENTSUB_URL) {
            deps.log('chat: reconnected');
            return;
          }
          welcomed = true;
          deps.log('chat: connected');
          void (token ? Promise.resolve() : refresh())
            .then(() => subscribe(id))
            .catch((e: unknown) => {
              // A bad credential will not heal by retrying; say so once and stay off.
              deps.log(`chat: off — ${(e as Error).message}`);
              stop();
            });
          return;
        }
        case 'session_reconnect': {
          const next = f.payload?.session?.reconnect_url;
          if (!next) return fail('reconnect had no url');
          open(next); // Twitch keeps the old socket open until the new one is welcomed
          s.close();
          return;
        }
        case 'revocation':
          deps.log(`chat: off — subscription revoked (${f.payload?.subscription?.status ?? '?'})`);
          stop();
          return;
        case 'notification': {
          const ev2 = f.payload?.event;
          const name = parseWho(ev2?.message?.text ?? '');
          if (!name || !ev2?.chatter_user_login) return;
          if (!gate(ev2.chatter_user_login.toLowerCase())) return;
          deps.log(`chat: !who ${name}`);
          deps.onWho(name);
          return;
        }
        default:
          return; // session_keepalive and anything new
      }
    };
    s.onclose = () => {
      if (sock !== s || stopped) return;
      fail(welcomed ? 'connection closed' : 'connection failed');
    };
  };

  const stop = (): void => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    const s = sock;
    sock = null;
    s?.close();
  };

  open(EVENTSUB_URL);
  return stop;
}

/** The one expression the reader may run in the page. The name is already allowlist-shaped. */
export function spotlightExpression(name: string): string {
  return `void window.__office?.spotlight?.(${JSON.stringify(name)})`;
}
