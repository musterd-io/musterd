import {
  deriveHuddles,
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
export const STATUS_FLAGS = ['resumable', 'session', 'wakeable'] as const;

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
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.members) + '\n');
    return 0;
  }
  // What's waiting for me (comeback path, ADR 024): the unanswered request_help / @me acts, read off
  // the durable inbox cursor — best-effort. Skipped for an ambient/absent identity: an inbox is
  // member-specific (and auth-gated). It rides *inside* the header now, where it outranks everything.
  const pending =
    explicit && identity
      ? await pendingActionSummary(http, team, identity.name).catch(() => undefined)
      : undefined;
  // The continuity one-liner (ADR 093 §3): the envelope read — headline + age, never the body. Seat-
  // authed and best-effort: an ambient identity, a seat with nothing saved (not_found), or any read
  // failure all stay silent. Compact here — the header has five other things to say.
  const memory =
    explicit && identity ? await http.getMemoryEnvelope(team).catch(() => undefined) : undefined;
  // Two reads that do not need each other, so they do not queue: `health` surfaces which daemon +
  // db we are on (a wrong-db "everyone offline" is otherwise a mystery), and the timeline carries
  // who is in a room (ADR 378) — a huddle is derived, never stored, so the mark
  // costs the one thing the roster read does not already carry: the recent envelope window. Paid
  // deliberately, and only when it can be spent — that route is seat-authed and recipient-scoped, so
  // an ambient identity gets no huddles rather than a failed command, exactly like `pending` and
  // `memory` above.
  const [health, timeline] = await Promise.all([
    http.health().catch(() => undefined),
    explicit && identity
      ? http.messages(team, { limit: TIMELINE_WINDOW }).catch(() => undefined)
      : undefined,
  ]);
  const marks = timeline
    ? huddleMarks(deriveHuddles(timeline.messages, identity?.name ?? ''))
    : undefined;

  // `Identity` carries no kind — the roster is the authority on it, so read it back from there.
  const mine = identity ? res.members.find((m) => m.name === identity.name) : undefined;
  const me = identity ? { name: identity.name, kind: mine?.kind ?? 'agent' } : undefined;
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
  process.stdout.write(
    '\n' + renderRoster(res.members, undefined, undefined, health?.build, marks) + '\n',
  );
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
  // ADR 516: the Team's active holds — what is paused, by whom, until when. Seat-authed and
  // best-effort like `pending` above: an ambient identity or an older daemon prints nothing.
  const holds =
    explicit && identity ? await http.listHolds(team).catch(() => [] as Hold[]) : ([] as Hold[]);
  if (holds.length > 0) process.stdout.write('\n' + renderHolds(holds, Date.now()) + '\n');
  // The machine cost line (ADR 242): the footprint sampler's latest tick, best-effort — an older
  // daemon, an unbound folder, or a non-darwin host all read as null and render as absence.
  const machineLine = renderMachineLine(await http.footprint(team).catch(() => null));
  if (machineLine) process.stdout.write('\n' + machineLine + '\n');
  // ADR 445 §4: a seat can see that it is being traced, and how deep. Printed only when the tap would
  // actually record — absence is the honest rendering of "not traced", never a `traced: off` line.
  const depth =
    explicit && identity
      ? traceDepth(findBinding(), health, process.env, findWorkspaceDir() ?? undefined)
      : null;
  if (depth) process.stdout.write('\n' + theme.meta(tracedLine(depth, health)) + '\n');
  return 0;
}
