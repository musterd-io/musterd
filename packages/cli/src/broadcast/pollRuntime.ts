import { OpenPollReplySchema, POLL_LIMITS, type PollCounts } from '@musterd/protocol';
import type { ChatApi } from './twitchChat.js';
import { startPollHandler, type CountsReply, type PollHandler } from './twitchPoll.js';

/**
 * The stream machine's poll loop (ADR 807). Every `tickMs` it reads `GET /polls/open` on the run's
 * observer seat, and every `liveMs` it asks Twitch (through the bot) whether the channel is live and
 * reports `POST /stream/live`. A new poll starts a handler; each read's fresh `mspoll_` token goes
 * straight to that handler's counts report; a closed poll's record (`last`) posts the result.
 *
 * The seat token stays here. The handler (twitchPoll.ts) is given a reporter bound to the poll token
 * and the bot's poster — never the seat token or the page.
 */

/** A poll opened longer ago than this is not announced again: a restarted machine joins it quietly. */
export const ANNOUNCE_WINDOW_MS = 60_000;

export interface PollRuntimeDeps {
  server: string;
  team: string;
  seatToken: string;
  /** The bot's chat API, once the reader is subscribed; null until then. */
  chat: () => ChatApi | null;
  log: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  tickMs?: number;
  liveMs?: number;
}

export function startPollRuntime(deps: PollRuntimeDeps) {
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const base = `${deps.server}/teams/${encodeURIComponent(deps.team)}`;
  let current: { id: string; handler: PollHandler } | null = null;
  let lastLiveAt = -Infinity;
  let live = false;
  let running = false;
  let stopped = false;

  const seat = (path: string, init: RequestInit = {}) =>
    http(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.seatToken}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  const report = async (pollId: string, pollToken: string, c: PollCounts): Promise<CountsReply> => {
    const r = await http(`${base}/polls/${encodeURIComponent(pollId)}/counts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pollToken}` },
      body: JSON.stringify(c),
    });
    if (r.status === 202) return 'ok';
    if (r.status === 409) return 'closed';
    if (r.status === 401) return 'bad_token';
    if (r.status === 400) return 'bad_counts';
    return 'error';
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      // Until the reader is subscribed there is no bot to post through and no liveness to report:
      // touch nothing, so a restart neither drops the announcement nor reports a guessed live=false.
      const chat = deps.chat();
      if (!chat) return;
      if (now() - lastLiveAt >= (deps.liveMs ?? 30_000)) {
        const seen = await chat.live();
        // A check Twitch did not answer is not "offline": report nothing, and ask again next tick.
        if (seen !== null) {
          lastLiveAt = now();
          live = seen;
          await seat('/stream/live', { method: 'POST', body: JSON.stringify({ live }) }).catch(
            () => undefined,
          );
        }
      }
      // No poll is read or counted before the first answered liveness check.
      if (lastLiveAt === -Infinity) return;
      const res = await seat('/polls/open');
      if (!res.ok) return;
      const parsed = OpenPollReplySchema.safeParse(await res.json());
      if (!parsed.success) return;
      const { poll, last } = parsed.data;
      if (poll) {
        if (!current || current.id !== poll.id) {
          const handler = startPollHandler({
            poll,
            post: (line) => deps.chat()?.post(line) ?? Promise.resolve(false),
            report: (token, c) => report(poll.id, token, c),
            log: deps.log,
            now,
          });
          current = { id: poll.id, handler };
          if (now() - poll.opened_at < ANNOUNCE_WINDOW_MS) void handler.announce();
        }
        // A count report refreshes the hub's liveness, so it rides only an answered check inside the
        // offline grace. Past it, votes keep counting here but nothing is sent: the hub sees the
        // silence ADR 807 §4 closes on, and the next answered check resumes the reports.
        const fresh = now() - lastLiveAt < POLL_LIMITS.offlineGraceMs;
        if (poll.poll_token && fresh) await current.handler.flush(poll.poll_token, live);
      } else if (current) {
        const done = current;
        current = null;
        if (last && last.id === done.id) await done.handler.close(last);
      }
    } catch {
      // The daemon or Twitch was unreachable this tick; the next one tries again.
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), deps.tickMs ?? 5_000);
  if (typeof handle.unref === 'function') handle.unref();
  return {
    /** Every chat message, from the reader. */
    onChat(userId: string, text: string): void {
      current?.handler.onChat(userId, text);
    },
    tick,
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
  };
}
