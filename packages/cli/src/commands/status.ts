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
  type DailyWarning,
  renderDailyView,
  renderMachineLine,
  renderPendingSummary,
  renderRoster,
  renderStatusHeader,
  sameCommit,
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

/**
 * The daily view's width: the terminal's columns, or `COLUMNS` when output is piped (so a seat can
 * check the 40-column layout from a shell), clamped to the frames' 40–80.
 */
function dailyWidth(): number {
  const cols = process.stdout.columns ?? Number(process.env['COLUMNS'] ?? 80);
  return Math.max(40, Math.min(80, Number.isFinite(cols) && cols > 0 ? cols : 80));
}

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
  // The hub cannot be read: up next would be a stale list, and the team line is only as fresh as
  // the last good sync — the view says so instead (frame 27-8).
  const hubLink = res.sync?.hub_link ?? undefined;
  const hubDown = !!hubLink && hubLink.failing_since !== null;
  const blockedLanes =
    explicit && identity && !hubDown
      ? await http
          .laneBoard(team, { q: 'state:blocked' })
          .then((b) => b.lanes.filter((l) => l.owner_seat && l.owner_seat !== identity.name))
          .catch(() => [])
      : [];
  const kindOf = (name: string) =>
    res.members.find((m) => m.name === name)?.kind ?? ('agent' as const);
  const warnings: DailyWarning[] = [];
  if (hubDown)
    warnings.push({ line: describeHubLink(hubLink, Date.now()).line, fix: 'musterd node list' });
  // ADR 135 self-check: build skew is a diagnostic, so it surfaces even in the daily view.
  const cli = cliBuild();
  if (cli && health?.build && !sameCommit(cli, health.build)) {
    warnings.push({
      line: `⚠ your CLI build (${cli.slice(0, 7)}) differs from the daemon (${health.build.slice(0, 7)})`,
      fix: 'rebuild your checkout (pnpm build)',
    });
  }
  const notReported: string[] = [];
  if (!brief && explicit && identity) notReported.push('lanes');
  if (!health) notReported.push('health');
  const newestModel = [...(mine?.presences ?? [])]
    .sort((a, b) => b.last_seen_at - a.last_seen_at)
    .find((p) => p.model)?.model;
  const daily = renderDailyView(
    {
      team,
      me: identity
        ? {
            name: identity.name,
            kind: mine?.kind ?? 'agent',
            role: mine?.role || mine?.roles[0],
            model: newestModel ?? undefined,
          }
        : undefined,
      memory:
        identity && memory ? renderMemoryLine(memory, Date.now(), { compact: true }) : undefined,
      waiting: pending
        ? {
            count: pending.count,
            acts: pending.waiting.map((a) => ({
              from: a.from ?? '?',
              fromKind: kindOf(a.from ?? ''),
              act: a.act ?? 'message',
              body: a.body ?? '',
              ts: a.ts,
            })),
          }
        : undefined,
      lanes: (brief?.in_flight ?? []).map((l) => ({
        state: l.state ?? 'active',
        title: l.title,
        merged: !!l.merged?.sha,
      })),
      upNext: hubDown
        ? { unreadable: 'the hub cannot be read' }
        : { lanes: brief?.up_next ?? [], total: brief?.up_next_total ?? 0 },
      crew: {
        here: res.members.filter((m) => m.presence !== 'offline').length,
        working: res.members.filter(
          (m) => m.presence !== 'offline' && m.activity === 'working' && m.state,
        ).length,
        // Teammates who are here and hold a blocked lane — one each, named by their first.
        blocked: [...new Map(blockedLanes.map((l) => [l.owner_seat!, l])).values()]
          .filter((l) =>
            res.members.some((m) => m.name === l.owner_seat && m.presence !== 'offline'),
          )
          .map((l) => ({ name: l.owner_seat!, kind: kindOf(l.owner_seat!), why: l.title })),
        asOf: hubDown ? (hubLink.last_ok_at ?? undefined) : undefined,
      },
      warnings,
      notReported,
    },
    Date.now(),
    dailyWidth(),
  );
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
  // A failing link is already a ⚠ line in the daily view; a healthy one is detail for --all.
  if (hubLink && !hubDown && (parsed.flags['all'] || parsed.flags['verbose'])) {
    process.stdout.write('\n' + theme.meta(describeHubLink(hubLink, Date.now()).line) + '\n');
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
