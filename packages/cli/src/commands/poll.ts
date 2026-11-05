import {
  POLL_LIMITS,
  PollSpecSchema,
  type OpenPoll,
  type OpenPollReply,
  type PollSpec,
} from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { collectApproval } from './authority.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd poll start "<question>" "<option>" "<option>" [… up to 4] [--minutes 1-15]\n' +
  '       musterd poll end      (close it now, with the votes so far)\n' +
  '       musterd poll cancel   (close it with no winner)\n' +
  '       musterd poll status';

/**
 * ADR 807 — a Twitch poll from the terminal. A human admin starts one while the stream is live on
 * Twitch; musterdbot posts it in chat and counts `!vote N`. The daemon decides who may (human
 * admin, enrolled passkey) and when (Twitch says live); this command only says what it refused.
 *
 * Options are positional, one quoted argument each, because the parser keeps one value per flag.
 */
/**
 * The flags `musterd poll` takes. `pnpm cli-flags:check` proves this list covers every flag the
 * file reads.
 */
export const POLL_FLAGS = ['minutes'] as const;

/** The spec from `start`'s arguments, exactly as the daemon will parse (and the passkey sign) it. */
export function startSpec(positionals: readonly string[], minutes: string | undefined): PollSpec {
  const [question, ...options] = positionals.map((p) => p.trim());
  if (!question) throw new CliError(`which question?\n${USAGE}`, 2);
  const opts = options.filter((o) => o !== '');
  if (opts.length < POLL_LIMITS.minOptions || opts.length > POLL_LIMITS.maxOptions)
    throw new CliError(
      `a poll needs ${POLL_LIMITS.minOptions}–${POLL_LIMITS.maxOptions} options, each its own quoted argument\n${USAGE}`,
      2,
    );
  const n = minutes === undefined ? POLL_LIMITS.defaultMinutes : Number(minutes);
  if (!Number.isInteger(n) || n < POLL_LIMITS.minMinutes || n > POLL_LIMITS.maxMinutes)
    throw new CliError(
      `--minutes takes a whole number from ${POLL_LIMITS.minMinutes} to ${POLL_LIMITS.maxMinutes}`,
      2,
    );
  const parsed = PollSpecSchema.safeParse({ question, options: opts, minutes: n });
  if (!parsed.success)
    throw new CliError(
      `the question stays under ${POLL_LIMITS.questionMax} characters and each option under ${POLL_LIMITS.optionMax}`,
      2,
    );
  return parsed.data;
}

/**
 * Open the poll as a human admin. Unsigned first — the daemon answers `no_signature` for an
 * enrolled human — then the server-built `credential_mint` descriptor over `{action:'poll_open',
 * spec}` is approved with the passkey and the same spec is sent again with the proof.
 */
export async function openPollSigned(
  http: HttpClient,
  team: string,
  spec: PollSpec,
): Promise<{ poll: OpenPoll }> {
  try {
    return await http.openPoll(team, spec);
  } catch (err) {
    if (!(err instanceof CliError && /authority refused \(no_signature\)/.test(err.message)))
      throw refusal(err);
  }
  // To stderr, like every ceremony prompt: stdout may carry `--json` a script is parsing.
  process.stderr.write(
    'Opening a poll mints its counts-only credential — approve it with your passkey.\n',
  );
  const approval = await collectApproval(http, team, 'credential_mint', team, {
    action: 'poll_open',
    spec,
  });
  try {
    return await http.openPoll(team, spec, approval);
  } catch (err) {
    throw refusal(err);
  }
}

/** A daemon refusal, said as what to do about it. */
function refusal(err: unknown): unknown {
  if (!(err instanceof CliError)) return err;
  const say = (text: string) => new CliError(text, err.exitCode, err.code);
  if (/needs a passkey/i.test(err.message))
    return say(
      'a poll needs a passkey — enroll one with `musterd authority enroll`, then start it again',
    );
  if (/not live on Twitch/i.test(err.message))
    return say('polls open while you’re live on Twitch — start the stream, then try again');
  if (/already open/i.test(err.message))
    return say('a poll is already running — `musterd poll status` shows it');
  return err;
}

export async function pollCommand(parsed: Parsed): Promise<number> {
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...POLL_FLAGS],
    'the flags `musterd poll` takes are listed by `musterd help poll`',
  );
  const sub = parsed.positionals[0];
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (sub === 'start') {
    const spec = startSpec(parsed.positionals.slice(1), flagStr(parsed.flags, 'minutes'));
    const { poll } = await openPollSigned(http, team, spec);
    if (json) return printJson(poll);
    process.stdout.write(
      success(`poll open for ${poll.minutes} min — musterdbot is posting it in chat`, {
        next: 'musterd poll status',
      }) + '\n',
    );
    return 0;
  }

  if (sub === 'end' || sub === 'cancel') {
    const reply = await http.getOpenPoll(team);
    if (!reply.poll) throw new CliError('no poll is open', 1, 'not_found');
    const { poll } = await http.closePoll(team, reply.poll.id, sub);
    if (json) return printJson(poll);
    process.stdout.write(
      success(sub === 'end' ? `poll ended — ${outcome(poll)}` : 'poll cancelled — no winner') +
        '\n',
    );
    return 0;
  }

  if (sub === 'status' || sub === undefined) {
    const reply = await http.getOpenPoll(team);
    if (json) return printJson(reply);
    process.stdout.write(renderPollStatus(reply, Date.now()) + '\n');
    return 0;
  }

  throw new CliError(USAGE, 2);
}

type Closed = NonNullable<OpenPollReply['last']>;

function outcome(r: Closed): string {
  const votes = `${r.voters} ${r.voters === 1 ? 'vote' : 'votes'}`;
  const pick = (i: number) => `${i + 1} · ${r.options[i]}`;
  if (r.end === 'cancelled') return 'cancelled';
  if (r.end === 'interrupted') return `ended when the stream dropped (${votes})`;
  if (r.winners.length === 0) return 'no votes';
  if (r.winners.length > 1) return `a tie, ${r.winners.map(pick).join(' and ')} (${votes})`;
  return `winner ${pick(r.winners[0]!)} (${votes})`;
}

/** `m:ss`, never negative. */
function left(closesAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((closesAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What `musterd poll status` prints: Twitch's live state, then the open poll or the last one. */
export function renderPollStatus(reply: OpenPollReply, now: number): string {
  const live = reply.live ? theme.ok('● live on Twitch') : theme.meta('○ not live on Twitch');
  const p = reply.poll;
  if (!p) {
    const last = reply.last
      ? `\n${theme.meta(`last poll: ${reply.last.question} — ${outcome(reply.last)}`)}`
      : '';
    return `${live}\n${theme.meta('no poll open')}${last}`;
  }
  const rows = p.options.map((o, i) => {
    const c = p.counts[i] ?? 0;
    const pct = p.voters > 0 ? Math.round((c / p.voters) * 100) : 0;
    return `  ${theme.meta(`!vote ${i + 1}`)}  ${o}  ${theme.meta(`${c} · ${pct}%`)}`;
  });
  const votes = `${p.voters} ${p.voters === 1 ? 'vote' : 'votes'}`;
  const warn = p.post_failed
    ? `\n${theme.warn('musterdbot couldn’t post in chat — votes still count')}`
    : '';
  return (
    [
      live,
      `${p.question}`,
      ...rows,
      theme.meta(`${votes} · ${left(p.closes_at, now)} left · opened by ${p.opened_by}`),
    ].join('\n') + warn
  );
}

function printJson(v: unknown): number {
  process.stdout.write(JSON.stringify(v) + '\n');
  return 0;
}
