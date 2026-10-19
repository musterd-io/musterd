import { z } from 'zod';
import type { Parsed } from '../args.js';
import { osNotify, type NotifyItem } from '../notify/os.js';
import { pollOnce, type NotifyDeps } from '../notify/select.js';
import { theme } from '../render/theme.js';
import { resolve, viewerFlags } from './helpers.js';

/**
 * `--interval` is seconds (human-facing); clamped to a sane floor so a typo can't hammer the daemon,
 * and a ceiling so it stays a notifier, not a forgotten cron. Parsed through zod (hard rule #4).
 */
const NotifyOptionsSchema = z.object({
  intervalMs: z.number().int().min(2_000).max(3_600_000).default(10_000),
  once: z.boolean().default(false),
});

function parseOptions(
  flags: Record<string, string | boolean>,
): z.infer<typeof NotifyOptionsSchema> {
  const raw = flags['interval'];
  const seconds = typeof raw === 'string' ? Number(raw) : undefined;
  return NotifyOptionsSchema.parse({
    intervalMs:
      seconds != null && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
    once: flags['once'] === true,
  });
}

/**
 * `musterd notify` — the localhost notification down-payment (ADR 035). A headless, client-side
 * notifier the human leaves running: it polls the durable inbox cursor and fires an OS notification
 * for a directed act (`request_help` / `handoff`/`accept`/`decline`/@mention to them) that lands
 * while they aren't watching. Closes the (B′) "away with nothing open" hole ADR 024 named. The
 * notify sink is injectable so the loop is testable without spawning the OS notifier.
 */
const CHANNELS_USAGE =
  'usage: musterd notify channels [--json]\\n' +
  '       musterd notify channels set <channel> [--deliver on|off] [--answer on|off] ' +
  '[--presence-gating on|off] [--tier-floor advisory|standard|blocking|none]';

/** The answer switch as it actually takes effect: delivery off removes answer authority
 * (channelSettings.answerAllowed), so a stored "answer on" under "deliver off" reads as off. */
function answerState(s: { deliver: boolean; answer: boolean }): string {
  if (!s.answer) return 'off';
  return s.deliver ? 'on' : 'off (delivery off)';
}

/**
 * `musterd notify channels` — away-channel settings (spec: Channel settings; nothing is on by
 * default): per-channel deliver/answer switches, presence gating, and an optional tier floor
 * for this human. The switches live in the daemon with the bindings.
 */
async function notifyChannelsCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;
  const sub = parsed.positionals[1];
  if (sub === undefined) {
    const { settings } = await http.getChannelSettings(team);
    if (json) {
      process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
      return 0;
    }
    if (settings.length === 0) process.stdout.write('no channels\n');
    for (const s of settings) {
      process.stdout.write(
        `${s.channel}  deliver ${s.deliver ? 'on' : 'off'}  answer ${answerState(s)}  ` +
          `presence-gating ${s.presenceGating ? 'on' : 'off'}  tier-floor ${s.tierFloor ?? 'none'}\n`,
      );
    }
    return 0;
  }
  if (sub === 'set') {
    const channel = parsed.positionals[2];
    if (!channel) throw new Error(CHANNELS_USAGE);
    const current = (await http.getChannelSettings(team)).settings.find(
      (s) => s.channel === channel,
    ) ?? { deliver: false, answer: false, presenceGating: true, tierFloor: null };
    const onOff = (name: string, fallback: boolean): boolean => {
      const v = parsed.flags[name];
      if (v === undefined) return fallback;
      if (v === 'on') return true;
      if (v === 'off') return false;
      throw new Error(CHANNELS_USAGE);
    };
    const floorRaw = parsed.flags['tier-floor'];
    const tierFloor =
      floorRaw === undefined
        ? current.tierFloor
        : floorRaw === 'none'
          ? null
          : floorRaw === 'advisory' || floorRaw === 'standard' || floorRaw === 'blocking'
            ? floorRaw
            : (() => {
                throw new Error(CHANNELS_USAGE);
              })();
    const { settings } = await http.setChannelSettings(team, channel, {
      deliver: onOff('deliver', current.deliver),
      answer: onOff('answer', current.answer),
      presence_gating: onOff('presence-gating', current.presenceGating),
      tier_floor: tierFloor,
    });
    process.stdout.write(
      `${settings.channel}  deliver ${settings.deliver ? 'on' : 'off'}  answer ${answerState(settings)}  ` +
        `presence-gating ${settings.presenceGating ? 'on' : 'off'}  tier-floor ${settings.tierFloor ?? 'none'}\n`,
    );
    return 0;
  }
  throw new Error(CHANNELS_USAGE);
}

export async function notifyCommand(
  parsed: Parsed,
  deps: { notify?: (n: NotifyItem) => void } = {},
): Promise<number> {
  if (parsed.positionals[0] === 'channels') return notifyChannelsCommand(parsed);
  const { team, identity, http } = resolve(parsed.flags);
  // The notifier polls on the away human's behalf — its reads must NOT mark them present (ADR 057),
  // or isReachable would see them online and the notification would silence itself.
  const poll = http.presenceNeutral();
  const opts = parseOptions(parsed.flags);
  const seen = new Set<string>();

  const notifyDeps: NotifyDeps = {
    me: identity.name,
    inbox: () => poll.inbox(team, { unread: true }),
    viewer: () => viewerFlags(poll, team, identity.name),
    // Reachable in-stream = a live watch/app presence (roster `presence !== 'offline'`). When the
    // human is watching, the bell/banner already reached them (ADR 024); `notify` owns only the
    // not-watching case (ADR 035 §3). No availability state is invented.
    isReachable: async () => {
      const roster = await poll.roster(team).catch(() => ({ members: [] }));
      const me = roster.members.find((m) => m.name === identity.name);
      return me != null && me.presence !== 'offline';
    },
    // The recipient's own availability tiers delivery (ADR 044): away holds all but `urgent`; dnd
    // passes directed + `urgent`. Read off the roster, same as reachability — no new wire field.
    availability: async () => {
      const roster = await poll.roster(team).catch(() => ({ members: [] }));
      const me = roster.members.find((m) => m.name === identity.name);
      return me?.availability ?? null;
    },
    notify: deps.notify ?? osNotify,
  };

  if (opts.once) {
    await pollOnce(notifyDeps, seen).catch(() => undefined);
    return 0;
  }

  process.stdout.write(`${theme.accent('notify')} — ${team}  ${theme.ok('◉ notifying')}\n`);
  process.stdout.write(
    theme.meta(`watching for directed acts while you're away — Ctrl-C to stop`) + '\n',
  );
  return new Promise<number>((resolveP) => {
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      // Best-effort: a transient inbox/roster read failure must not kill the resident loop.
      await pollOnce(notifyDeps, seen).catch(() => undefined);
      // NB: do NOT unref the timer — unlike `inbox --watch` there is no socket holding the event
      // loop open, so an unref'd timer lets the process exit right after the first poll.
      timer = setTimeout(tick, opts.intervalMs);
    };
    void tick();
    process.on('SIGINT', () => {
      if (timer) clearTimeout(timer);
      process.stdout.write('\n');
      resolveP(0);
    });
  });
}
