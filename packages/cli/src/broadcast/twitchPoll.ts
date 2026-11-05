import { POLL_LIMITS, type OpenPoll, type PollCounts, type PollMeta } from '@musterd/protocol/wire';

/**
 * Twitch polls on the stream machine (ADR 807). Posts a human admin's poll through musterdbot,
 * counts `!vote N` by Twitch user id in memory, and reports **integer counts** on the poll's own
 * token. This module is never handed the observer seat's token, the page, or any other credential:
 * its deps carry a poster (the bot's chat API) and a counts reporter, and nothing else.
 */

const VOTE = /^!vote\s+(\d{1,2})\s*$/i;
const CHAT_MAX = 500;

/** `!vote N` (case-insensitive, N from 1 to the option count) as a zero-based index; else null. */
export function parseVote(text: string, options: number): number | null {
  const m = VOTE.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= options ? n - 1 : null;
}

/** Each viewer's latest vote, once; a vote inside `voteGapMs` of their last is dropped. */
export function makeTally(options: number, now: () => number = Date.now) {
  const byViewer = new Map<string, { index: number; at: number }>();
  let base = new Array<number>(options).fill(0);
  let baseVoters = 0;
  return {
    vote(userId: string, index: number): boolean {
      const prev = byViewer.get(userId);
      const t = now();
      if (prev && t - prev.at < POLL_LIMITS.voteGapMs) return false;
      byViewer.set(userId, { index, at: t });
      return true;
    },
    counts(): number[] {
      const c = [...base];
      for (const v of byViewer.values()) c[v.index] = (c[v.index] ?? 0) + 1;
      return c;
    },
    voters(): number {
      return baseVoters + byViewer.size;
    },
    /** After a restart: start from the daemon's last counts, and add new votes on top (ADR 807 §8). */
    seed(counts: readonly number[], voters: number): void {
      base = Array.from({ length: options }, (_, i) => counts[i] ?? 0);
      baseVoters = voters;
    },
  };
}

/** Split text on spaces into chunks of at most `max` characters. */
function chunk(text: string, max = CHAT_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max) line = next;
    else {
      if (line) out.push(line);
      line = word.slice(0, max);
    }
  }
  if (line) out.push(line);
  return out;
}

/** The poll's opening lines: what the bot is, who asks, the options, how to vote. */
export function pollLines(poll: OpenPoll): string[] {
  const n = poll.options.length;
  const votes = poll.options.map((_, i) => `!vote ${i + 1}`);
  const how = `${votes.slice(0, -1).join(', ')} or ${votes[n - 1]}`;
  return [
    ...chunk(`👋 I'm musterd's Twitch bot. ${poll.opened_by} wants to ask you: ${poll.question}`),
    ...chunk(poll.options.map((o, i) => `${i + 1} · ${o}`).join(' | ')),
    `Vote by typing ${how} — ${poll.minutes} ${poll.minutes === 1 ? 'minute' : 'minutes'}.`,
  ];
}

/** One sentence for how the poll ended. Never names a voter. */
export function resultLine(r: Extract<PollMeta, { state: 'closed' }>): string {
  const votes = `${r.voters} ${r.voters === 1 ? 'vote' : 'votes'}`;
  const pick = (i: number) => `${i + 1} · ${r.options[i]}`;
  if (r.end === 'cancelled') return `🗳️ ${r.opened_by} cancelled the poll.`;
  if (r.end === 'interrupted')
    return `🗳️ The poll ended when the stream dropped — ${votes} counted.`;
  if (r.winners.length === 0) return '🗳️ Poll closed with no votes. Thanks for watching!';
  if (r.winners.length > 1)
    return `🗳️ Poll closed — ${votes}. It’s a tie: ${r.winners.map(pick).join(' and ')}. Thanks for voting!`;
  const w = r.winners[0]!;
  const pct = r.voters > 0 ? Math.round(((r.counts[w] ?? 0) / r.voters) * 100) : 0;
  return `🗳️ Poll closed — ${votes}. Winner: ${pick(w)} (${pct}%). Thanks for voting!`;
}

export type CountsReply = 'ok' | 'closed' | 'bad_token' | 'bad_counts' | 'error';

export interface PollHandlerDeps {
  poll: OpenPoll;
  /** Post one line as the bot (ChatApi.post). */
  post(line: string): Promise<boolean>;
  /** Send counts to the daemon on the poll token. */
  report(pollToken: string, counts: PollCounts): Promise<CountsReply>;
  log(line: string): void;
  now?: () => number;
}

/** One poll's chat side: announce, count, report, close. */
export function startPollHandler(deps: PollHandlerDeps) {
  const { poll } = deps;
  const tally = makeTally(poll.options.length, deps.now);
  tally.seed(poll.counts, poll.voters);
  let queue: Promise<void> = Promise.resolve();
  let postFailed = false;
  let refusalSaid = false;
  let closed = false;
  // Posts go out one at a time, in order: a close never overtakes the poll's own lines.
  const send = (lines: readonly string[]) => {
    queue = queue.then(async () => {
      for (const line of lines) {
        const ok = await deps.post(line);
        if (!ok) {
          postFailed = true;
          if (!refusalSaid) {
            refusalSaid = true;
            deps.log('poll: post refused by Twitch — counting goes on');
          }
        }
      }
    });
    return queue;
  };
  deps.log(`poll: opened ${poll.id}`);
  return {
    /** Post the poll's opening lines. */
    announce(): Promise<void> {
      return send(pollLines(poll)).then(() => deps.log('poll: posted'));
    },
    onChat(userId: string, text: string): void {
      if (closed) return;
      const index = parseVote(text, poll.options.length);
      if (index !== null) tally.vote(userId, index);
    },
    /** Report the counts on the poll's current token. */
    async flush(pollToken: string, live = true): Promise<CountsReply> {
      try {
        return await deps.report(pollToken, {
          poll_id: poll.id,
          counts: tally.counts(),
          voters: tally.voters(),
          live,
          post_failed: postFailed,
        });
      } catch {
        return 'error';
      }
    },
    /** Post the result once, after everything already queued. */
    close(record: Extract<PollMeta, { state: 'closed' }>): Promise<void> {
      if (closed) return queue;
      closed = true;
      deps.log(`poll: closed ${record.end}`);
      return send([resultLine(record)]);
    },
  };
}

export type PollHandler = ReturnType<typeof startPollHandler>;
