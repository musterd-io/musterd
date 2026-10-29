import {
  deriveHuddles,
  describeHubLink,
  describeSyncPullStop,
  describeSyncWedge,
  type Hold,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { findBinding } from '../config.js';
import { huddleMarks, TIMELINE_WINDOW } from '../render/huddles.js';
import {
  renderMachineLine,
  renderPendingSummary,
  renderRoster,
  renderStatusHeader,
} from '../render/rows.js';
import { theme } from '../render/theme.js';
import { traceDepth, tracedLine } from '../trace/hook.js';
import { cliBuild } from '../version.js';
import { findWorkspaceDir, pendingActionSummary, resolveRead } from './helpers.js';
import { renderHolds } from './hold.js';
import { renderMemoryLine } from './memory.js';

/**
 * The flags `musterd status` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd status` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const STATUS_FLAGS = ['resumable', 'session', 'wakeable', 'all', 'verbose'] as const;

export async function statusCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...STATUS_FLAGS],
    'the flags `musterd status` takes are listed by `musterd help status`',
  );
  // `status` is a read: it shows the (auth-free) roster anywhere, even from an unbound folder with
  // no active identity (ADR 036). The per-member comeback summary needs a genuine actor, so it only
  // runs when someone is explicitly active here.
  const { config, team, identity, explicit, http } = resolveRead(parsed.flags, {
    claimSeatPerRequest: true,
  });
  const res = await http.roster(team);
  const [health, timeline] = await Promise.all([
    http.health().catch(() => undefined),
    explicit && identity
      ? http.messages(team, { limit: TIMELINE_WINDOW }).catch(() => undefined)
      : undefined,
  ]);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  // Daily orientation (sloane/slippy design, lane 01M61VTTB6B): identity -> waiting -> your work -> up
  // next -> team one-liner, ahead of the roster. Carried work and open lanes come from the brief.
  const pending =
    explicit && identity
      ? await pendingActionSummary(http, team, identity.name).catch(() => undefined)
      : undefined;
  const mine = identity ? res.members.find((m) => m.name === identity.name) : undefined;
  const brief = explicit && identity ? await http.next(team).catch(() => undefined) : undefined;
  const memory =
    explicit && identity ? await http.getMemoryEnvelope(team).catch(() => undefined) : undefined;
  const daily: string[] = [];
  if (identity) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    daily.push(theme.meta(`musterd · ${team} · ${hh}:${mm}`));
    daily.push(`you are ${theme.accent(identity.name)} · ${mine?.kind ?? 'agent'}`);
    if (memory) daily.push(theme.dim(renderMemoryLine(memory, Date.now(), { compact: true })));
  }
  const ACT_WORD: Record<string, string> = {
    ask: 'asks',
    request_help: 'needs help',
    handoff: 'hands you',
    steer: 'redirects you',
    challenge: 'questions',
    message: 'wrote',
  };
  if (pending) {
    daily.push('');
    daily.push(theme.warn(`\u2691 ${pending.count} waiting on you`));
    for (const a of (pending.waiting ?? []).slice(0, 3)) {
      const who = a.from ?? '?';
      const verb = ACT_WORD[a.act ?? 'message'] ?? a.act ?? 'wrote';
      const gist = (a.body ?? '').slice(0, 40).replace(/\n/g, ' ');
      daily.push(`  ${theme.accent(who)} · ${verb}: ${gist}`);
    }
    if ((pending.waiting?.length ?? 0) > 3)
      daily.push(theme.dim(`  +${(pending.waiting?.length ?? 0) - 3} more · musterd inbox`));
    daily.push(theme.dim('  → musterd inbox'));
  } else {
    daily.push('');
    daily.push(theme.dim('\u2691 nothing waiting on you'));
  }
  const inFlight = brief?.in_flight ?? [];
  daily.push('');
  if (inFlight.length === 0) {
    daily.push(theme.dim('You hold no lanes.'));
    if (brief?.up_next?.length)
      daily.push(theme.dim(`pick one up  musterd lane claim ${brief.up_next[0]!.id}`));
  } else {
    daily.push(`◆ your work  ${inFlight.length}`);
    for (const lane of inFlight.slice(0, 3)) {
      daily.push(`  ${lane.state ?? 'active'} · ${lane.title}`);
    }
    if (inFlight.length > 3)
      daily.push(theme.dim(`  +${inFlight.length - 3} more · musterd lanes --mine`));
  }
  const upNext = brief?.up_next ?? [];
  const upLimit = (process.stdout.columns ?? 80) < 60 ? 1 : 2;
  if (upNext.length > 0) {
    daily.push('');
    daily.push('○ up next');
    for (const lane of upNext.slice(0, upLimit)) {
      daily.push(`  ${lane.title} — ${lane.id}`);
    }
    if (upNext.length > upLimit)
      daily.push(theme.dim(`  +${upNext.length - upLimit} more · musterd next`));
    daily.push(theme.dim('  → musterd next'));
  }
  // Partial: an older daemon that lacks a section says so (ADR 490 pattern).
  if (!brief && explicit && identity) daily.push(theme.dim('lanes: not reported by this daemon'));
  if (!health) daily.push(theme.dim('health: not reported by this daemon'));
  const hereCount = res.members.filter((m) => m.presence !== 'offline').length;
  const onlineCount = res.members.filter((m) => m.presence === 'online').length;
  daily.push('');
  daily.push(`team ${hereCount} here · ${onlineCount} online`);
  // All-quiet check.
  if (inFlight.length === 0 && (pending?.count ?? 0) === 0 && upNext.length === 0) {
    daily.push(theme.dim('All quiet. musterd next shows open work.'));
  }
  // ADR 135 self-check: build skew is a diagnostic, so it surfaces even in the daily view
  // (sloane: ⚠ lines only when something is wrong, ending with the fix command).
  if (cliBuild() && health?.build && cliBuild() !== health.build) {
    // sameCommit logic from rows.ts: ignore -dirty suffix
    const cli = cliBuild()!;
    const daemon = health.build;
    const same = cli.replace(/-dirty$/, '') === daemon.replace(/-dirty$/, '');
    if (!same) {
      daily.push('');
      daily.push(
        theme.warn(
          `⚠ your CLI build (${cli.slice(0, 7)}) differs from the daemon (${daemon.slice(0, 7)}) — rebuild your checkout (pnpm build)`,
        ),
      );
    }
  }
  process.stdout.write(daily.join('\n') + '\n\n');
  // `Identity` carries no kind — the roster is the authority on it, so read it back from there.
  const me = identity ? { name: identity.name, kind: mine?.kind ?? 'agent' } : undefined;
  if (parsed.flags['all'] || parsed.flags['verbose']) {
    process.stdout.write(
      renderStatusHeader({
        team,
        server: config.server,
        health,
        members: res.members,
        me,
        pending: pending ? renderPendingSummary(pending.count, pending.since) : undefined,
        memory: memory ? renderMemoryLine(memory, Date.now(), { compact: true }) : undefined,
        cliBuild: cliBuild(),
      }) + '\n',
    );
  }
  const marks = timeline
    ? huddleMarks(deriveHuddles(timeline.messages, identity?.name ?? ''))
    : undefined;
  if (parsed.flags['all']) {
    process.stdout.write(
      '\n' + renderRoster(res.members, undefined, undefined, health?.build, marks) + '\n',
    );
  } else {
    process.stdout.write(theme.dim('roster: musterd status --all\n'));
  }
  // ADR 360 follow-on: a wedged push says so here, on the surface a human on this machine reads.
  if (res.sync?.wedged)
    process.stdout.write('\n' + theme.warn(describeSyncWedge(res.sync.wedged)) + '\n');
  // ADR 547: and a pull whose fold has sat stopped for minutes — the other half of "my sync is stuck".
  if (res.sync?.pull_stopped)
    process.stdout.write('\n' + theme.warn(describeSyncPullStop(res.sync.pull_stopped)) + '\n');
  // ADR 591: and the hub's own stop as this joiner heard it — what holds every lane claim from here.
  if (res.sync?.hub_stopped)
    process.stdout.write(
      '\n' + theme.warn(describeSyncPullStop(res.sync.hub_stopped, Date.now(), 'hub')) + '\n',
    );
  // ADR 738: this joiner's link to its hub — last good sync, or since when it fails and why. Absent
  // on the hub, on a machine without one, and from an older daemon.
  if (res.sync?.hub_link) {
    const link = describeHubLink(res.sync.hub_link, Date.now());
    process.stdout.write('\n' + (link.warn ? theme.warn(link.line) : theme.meta(link.line)) + '\n');
  }
  // ADR 516: the Team's active holds — what is paused, by whom, until when. Seat-authed and
  // best-effort like `pending` above: an ambient identity or an older daemon prints nothing.
  const holds =
    explicit && identity ? await http.listHolds(team).catch(() => [] as Hold[]) : ([] as Hold[]);
  if (holds.length > 0) process.stdout.write('\n' + renderHolds(holds, Date.now()) + '\n');
  // The machine cost line: only when --all/--verbose (silent when healthy per the daily view).
  const machineLine = renderMachineLine(await http.footprint(team).catch(() => null));
  if (machineLine && (parsed.flags['all'] || parsed.flags['verbose']))
    process.stdout.write('\n' + machineLine + '\n');
  // ADR 445 §4: a seat can see that it is being traced, and how deep. Printed only when the tap would
  // actually record — absence is the honest rendering of "not traced", never a `traced: off` line.
  const depth =
    explicit && identity && (parsed.flags['all'] || parsed.flags['verbose'])
      ? traceDepth(findBinding(), health, process.env, findWorkspaceDir() ?? undefined)
      : null;
  if (depth) process.stdout.write('\n' + theme.meta(tracedLine(depth, health)) + '\n');
  return 0;
}
