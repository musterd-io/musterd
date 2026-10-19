import {
  BUILD_ON_CHECK,
  builtOnLine,
  emptyPoolHint,
  LANE_REQUESTED_NUDGE,
  laneDetailLines,
  laneIdQuery,
  LaneStakesSchema,
  LaneStateSchema,
  reviewWaitMinutes,
  scopeIsHumanVisible,
  type Lane,
  type LaneStakes,
  type OpenLane,
  type LaneWarning,
} from '@musterd/protocol';
import { resolveProject } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { plainTerminalLines, plainTerminalText } from '../render/plainText.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';
import { claimSeams, renderClaims } from './laneClaims.js';

/**
 * `musterd lane <show|open|claim|release|park|unpark|handoff|update|resolve>` + `musterd lanes` — the CLI half of the lane
 * dual-surface (ADR 083, parity with the `lane_*` MCP tools). Every mutation prints the lane and any
 * contention warnings inline (warn-only; the verb never fails on contention).
 */

const USAGE =
  'usage:\n' +
  '  musterd lane show <id> [--json]                                    (one lane in full, ADR 582)\n' +
  '  musterd lane open "<title>" [--surface <glob>[,<glob>…]] [--area <area>[,<area>…]] [--depends <id>[,<id>…]] [--goal <id>] [--project p] [--role r] [--branch b] [--detail d] [--stakes low|normal|high] [--risk tag[,tag…]|none] [--source-ref <ref>] [--reads-on <YYYY-MM-DD>] [--self | --by <name> | --act <id> | --seed <id>] [--claim]\n' +
  '  musterd lane claim <id> [--goal <id>]\n' +
  '  musterd lane release <id> [--reason "<why>"]\n' +
  '  musterd lane park <id> --reason "<why not now>" [--until <date>]   (humans only, ADR 466)\n' +
  '  musterd lane unpark <id>                                           (humans only)\n' +
  '  musterd lane handoff <id> --to <seat> [--branch <ref>] [--note <why>]\n' +
  '  musterd lane update <id> [--state open|claimed|active|blocked|awaiting_acceptance|done|abandoned] [--title t] [--surface …] [--area <area>[,<area>…]|none] [--depends …] [--branch b] [--detail d] [--project p] [--stakes low|normal|high] [--goal <id>] [--source-ref <ref>] [--reads-on <YYYY-MM-DD>|none] [--read-verdict met|missed|inconclusive --read-note "<what was read>"] [--self | --by <name> | --act <id> | --seed <id>] [--clear-merged] [--abandon-reason "<why>"]\n' +
  '  musterd lane submit <id> [--to <seat>] [--pr <n>] [--sha <sha>] [--authorized-by <human>] [--follows-up <id,id|none>] [--read-verdict <outcome> --read-note "<what was read>"]\n' +
  '                          [--branch b]\n' +
  '  musterd lane resolve <id> [--pr <n>] [--sha <sha>] [--authorized-by <human>] [--follows-up <id,id|none>] [--read-verdict <outcome> --read-note "<what was read>"]\n' +
  '  musterd lanes [--project p] [--mine] [--open] [--history] [--json] [query…]';

/**
 * Parse `--stakes` (ADR 234). A typo must FAIL rather than silently fall back to the default: the
 * point of the label phase is to measure declarations, and a misspelling that quietly records
 * `normal` would put a lane the worker meant to mark `low` into the bucket it was being
 * distinguished from — corrupting the measurement in the direction that hides the effect.
 */
function parseStakes(raw: string): LaneStakes {
  const parsed = LaneStakesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `--stakes must be one of ${LaneStakesSchema.options.join(' | ')} (got "${raw}")`,
      2,
    );
  }
  return parsed.data;
}

/**
 * Parse `--risk`. Mirrors parseStakes: a typo must fail, and `none` is a declaration, not the
 * default. `--risk none` means "this lane's acceptance needs no human judgement", which for a
 * human-visible-scope lane is exactly the declaration the open path is asking for. `--risk none`
 * may not be padded with other tags — that reads as under-deciding, and the whole point is that
 * the author picked one posture.
 */
function parseRisks(raw: string): string[] {
  const tags = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tags.length === 1 && tags[0] === 'none') return [];
  if (tags.includes('none')) {
    throw new CliError(
      `--risk none stands alone — it records "no human-judgement risk", not "none plus other tags"`,
      2,
    );
  }
  if (tags.length === 0) throw new CliError(`--risk needs at least one tag, or none`, 2);
  return tags;
}

/** Split a comma-separated repeatable flag; undefined when the flag is absent. */
function list(flags: Record<string, string | boolean>, name: string): string[] | undefined {
  const raw = flagStr(flags, name);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function renderLane(l: Lane): string {
  const owner = l.owner_seat ? theme.memberName(l.owner_seat, 'agent') : theme.meta('unowned');
  const state =
    l.state === 'done' ? theme.ok(l.state) : l.state === 'blocked' ? theme.warn(l.state) : l.state;
  const surface = l.scope.length ? theme.meta(` [${l.scope.join(', ')}]`) : '';
  const deps = l.depends_on.length ? theme.meta(` deps:${l.depends_on.length}`) : '';
  const branch = l.branch ? theme.meta(` ⎇ ${l.branch}`) : '';
  const goal = l.goal_id ? theme.meta(` ◆ ${l.goal_id}`) : '';
  const areas = l.areas?.length ? theme.meta(` · ${l.areas.join(', ')}`) : '';
  // ADR 561: the issue the lane came from.
  // Stripped: a fold stores what another daemon sent, and a ref names text from outside the team.
  const src = l.source_ref ? theme.meta(` ⌁ ${plainTerminalText(l.source_ref)}`) : '';
  // ADR 629: who asked, and how strongly. Absent stays off the board line; `lane show` prints it.
  const asked = l.requested
    ? theme.meta(` asked:${plainTerminalText(l.requested.by)} (${l.requested.basis})`)
    : '';
  // ADR 644: the read's day and where it stands, derived by the daemon.
  const reads = l.reads_on
    ? theme.meta(` reads:${l.reads_on} (${l.read_status ?? 'undated'})`)
    : '';
  // ADR 466: a parked lane shows who shelved it and why where an owner would be.
  const parked = l.parked
    ? theme.meta(
        ` ⏸ ${l.parked.by}: "${l.parked.reason}"` +
          (l.parked.until
            ? ` (revisit ${new Date(l.parked.until).toISOString().slice(0, 10)})`
            : ''),
      )
    : '';
  return `${theme.meta(l.id)} ${state} "${l.title}" — ${owner} · ${l.project}${goal}${areas}${src}${asked}${reads}${surface}${deps}${branch}${parked}`;
}

/** ADR 629: one of --self, --by, --act, --seed. None means the lane opens with the asker missing. */
function requestedFromFlags(
  flags: Parsed['flags'],
  selfName: string,
): OpenLane['requested'] | undefined {
  const self = flags['self'] === true;
  const by = flagStr(flags, 'by');
  const act = flagStr(flags, 'act');
  const seed = flagStr(flags, 'seed');
  const chosen = [self, by !== undefined, act !== undefined, seed !== undefined].filter(Boolean);
  if (chosen.length === 0) return undefined;
  if (chosen.length > 1)
    throw new CliError('say who asked with one of --self, --by, --act, or --seed', 2);
  if (self) return { basis: 'self' };
  if (act !== undefined) return { basis: 'act', ref: act };
  if (seed !== undefined) return { basis: 'seed', ref: seed };
  return { by: by!, basis: by === selfName ? 'self' : 'stated' };
}

function renderWarnings(warnings: LaneWarning[]): void {
  for (const w of warnings) {
    // For stale_plan the `with` is the moved Goal; for the others it's the other lane.
    const ref = w.kind === 'stale_plan' ? `goal ${w.with}` : `lane ${w.with}`;
    process.stdout.write(`${theme.warn('⚠')} ${w.kind}: ${w.detail} ${theme.meta(`(${ref})`)}\n`);
  }
  if (warnings.length > 0) {
    process.stdout.write(theme.meta('advisory only — coordinate or adjust; never blocked') + '\n');
  }
}

/**
 * On lane closure, remind the agent to clear the lane's *local* branch (ADR 106). GitHub auto-deletes
 * the remote branch on merge; the local one lingers in the worktree, and the naive cleanup fails —
 * you can't `git checkout main` (a sibling worktree owns it) and `git branch -d` refuses a
 * squash-merged branch. The worktree-safe move detaches to fresh `origin/main` (the next lane's start
 * state) and force-deletes. No-op when the lane carries no branch.
 */
function renderBranchCleanup(branch: string | null): void {
  if (!branch) return;
  process.stdout.write(
    theme.meta('landed? clear the local branch (the remote auto-deleted on merge):') + '\n',
  );
  process.stdout.write(
    theme.meta(
      `  git fetch origin main --prune && git switch --detach origin/main && git branch -D ${branch}`,
    ) + '\n',
  );
}

export async function laneCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const { team, identity, http } = resolve(parsed.flags);

  // ADR 582 §4: one lane in full — what reviewing a lane meant reading the DB for. The lines under
  // the board line are the protocol's, shared with the MCP `lane_board {q}` render.
  if (sub === 'show') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const d = await http.laneShow(team, id);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(d) + '\n');
      return 0;
    }
    process.stdout.write(renderLane(d.lane) + '\n');
    // Stripped: the brief and the history name text other seats wrote (a fold stores what another
    // daemon sent), so no escape sequence reaches the terminal.
    for (const line of laneDetailLines(d)) {
      const text = plainTerminalLines(line);
      process.stdout.write(
        (line.startsWith('  ') || line === 'history:' ? theme.meta(text) : text) + '\n',
      );
    }
    renderWarnings(d.warnings);
    return 0;
  }

  if (sub === 'open') {
    const title = parsed.positionals[1];
    if (!title) throw new CliError(USAGE, 2);
    const scope = list(parsed.flags, 'surface');
    const riskRaw = flagStr(parsed.flags, 'risk');
    // A lane whose scope reaches a human-visible surface owes the author a risk declaration, not a
    // silent default (`risk: []` skips the ADR 188 human gate). Ask explicitly; `none` is an
    // explicit answer and is accepted. A scope that touches no rendered surface needs no answer.
    if (scopeIsHumanVisible(scope) && riskRaw === undefined) {
      throw new CliError(
        `open "${title}": scope reaches a human-visible surface (${scope?.join(', ')}). ` +
          `Declare its acceptance risk with --risk <tags> (e.g. --risk user-facing), ` +
          `or --risk none to record that there is none. user-facing alone is a peer review; ` +
          `add another tag, or --stakes high, when the change is big (ADR 631). ` +
          `The lane cannot open with the default.`,
        2,
      );
    }
    const res = await http.openLane(team, {
      title,
      ...(flagStr(parsed.flags, 'detail') !== undefined
        ? { detail: flagStr(parsed.flags, 'detail')! }
        : {}),
      // Derived here, not in the store: the daemon's cwd is the daemon's, so only the caller knows
      // which repo this lane belongs to (--project > MUSTERD_PROJECT > repo identity > 'default').
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      ...(flagStr(parsed.flags, 'role') !== undefined
        ? { role: flagStr(parsed.flags, 'role')! }
        : {}),
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
      ...(flagStr(parsed.flags, 'goal') !== undefined
        ? { goal_id: flagStr(parsed.flags, 'goal')! }
        : {}),
      ...(flagStr(parsed.flags, 'source-ref') !== undefined
        ? { source_ref: flagStr(parsed.flags, 'source-ref')! }
        : {}),
      ...(requestedFromFlags(parsed.flags, identity.name) !== undefined
        ? { requested: requestedFromFlags(parsed.flags, identity.name)! }
        : {}),
      // ADR 644: the day this lane's read is due.
      ...(flagStr(parsed.flags, 'reads-on') !== undefined
        ? { reads_on: flagStr(parsed.flags, 'reads-on')! }
        : {}),
      ...(list(parsed.flags, 'surface') !== undefined
        ? { scope: list(parsed.flags, 'surface')! }
        : {}),
      ...(list(parsed.flags, 'area') !== undefined ? { areas: list(parsed.flags, 'area')! } : {}),
      ...(riskRaw !== undefined ? { risk: parseRisks(riskRaw) } : {}),
      ...(list(parsed.flags, 'depends') !== undefined
        ? { depends_on: list(parsed.flags, 'depends')! }
        : {}),
      ...(flagStr(parsed.flags, 'stakes') !== undefined
        ? { stakes: parseStakes(flagStr(parsed.flags, 'stakes')!) }
        : {}),
      ...(parsed.flags['claim'] === true ? { claim: true } : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane opened\n${renderLane(res.lane)}\n`);
    if (!res.lane.requested) process.stdout.write(theme.meta(LANE_REQUESTED_NUDGE) + '\n');
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'claim' || sub === 'resolve' || sub === 'submit') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    // resolve/submit may attest the landed merge (ADR 109): {pr, sha, authorized_by}. On submit
    // (ADR 192) it is the worker's stage-one claim. On a *self*-resolve it rides the terminal
    // move into `git.pr_merged`. On a counterpart resolve the server ignores them when the worker's
    // submit stamp stands (ADR 305), so that stamp — ADR 300 verification included — is never
    // replaced by a partial patch; on a lane with NO stamp they are recorded (ADR 305 amendment 1).
    const prRaw = flagStr(parsed.flags, 'pr');
    const pr = prRaw !== undefined ? Number(prRaw) : undefined;
    if (pr !== undefined && !Number.isInteger(pr)) throw new CliError(USAGE, 2);
    const merged = {
      ...(pr !== undefined ? { pr } : {}),
      ...(flagStr(parsed.flags, 'sha') !== undefined ? { sha: flagStr(parsed.flags, 'sha')! } : {}),
      ...(flagStr(parsed.flags, 'authorized-by') !== undefined
        ? { authorized_by: flagStr(parsed.flags, 'authorized-by')! }
        : {}),
    };
    const submit = sub === 'submit';
    // ADR 585: the verification rail. What this seat attests (SHA, PR, branch) is checked in this
    // clone before it is sent, and the claims ride the patch; the daemon stamps the checker from
    // the authenticated sender. The CLI's submit carried no verification at all before this.
    const branchFlag = flagStr(parsed.flags, 'branch');
    const claimRefs = {
      ...(merged.sha !== undefined ? { sha: merged.sha } : {}),
      ...(merged.pr !== undefined ? { pr: merged.pr } : {}),
      ...(branchFlag !== undefined ? { branch: branchFlag } : {}),
    };
    const claims =
      sub !== 'claim' && Object.keys(claimRefs).length > 0
        ? await claimSeams.check(claimRefs, process.cwd(), identity.name)
        : [];
    // ADR 612: a submit whose SHA this clone confirmed on origin/main carries the landed diff's
    // change class, so the acceptance ask opens with what kind of landing it is. Label only.
    const landed = claims.some((c) => c.kind === 'commit_landed' && c.verdict === 'confirmed');
    const changeLabel =
      submit && landed && merged.sha !== undefined
        ? await claimSeams.label(merged.sha, process.cwd())
        : null;
    if (changeLabel) Object.assign(merged, changeLabel);
    const res = await http.updateLane(
      team,
      id,
      sub === 'claim'
        ? {
            owner_seat: identity.name,
            // value-layer design: link the lane to a goal as you take it — one call.
            ...(flagStr(parsed.flags, 'goal') !== undefined
              ? { goal_id: flagStr(parsed.flags, 'goal')! }
              : {}),
          }
        : {
            state: submit ? 'awaiting_acceptance' : 'done',
            ...(Object.keys(merged).length ? { merged } : {}),
            ...(claims.length > 0 ? { claims } : {}),
            // The acceptor needs to know where the work IS (ADR 083). Submit was the one lane edge
            // that could not say so, while `branch` is valid on open/handoff/update — so seats
            // reached for it here and were bounced.
            ...(flagStr(parsed.flags, 'branch') !== undefined
              ? { branch: flagStr(parsed.flags, 'branch')! }
              : {}),
            // Route the acceptance ask to a seat you name, instead of the daemon's pick. The
            // acceptance a human routes by hand was previously invisible: the named seat's `accept`
            // had no server-composed ask to bind to, so the owner ended up self-closing work that
            // HAD been reviewed. Recorded as `route: 'named'` — never as a pick.
            ...(submit && flagStr(parsed.flags, 'to') !== undefined
              ? { acceptor: flagStr(parsed.flags, 'to')! }
              : {}),
            // ADR 487 §5.1: what is left after this lane. Refused as missing only when the lane
            // declares itself one part of several; the daemon's refusal names this flag.
            ...followsUpFlag(flagStr(parsed.flags, 'follows-up')),
            // ADR 644: the read's verdict, which a lane with `reads_on` needs before it closes done.
            ...readVerdictFlags(parsed.flags),
          },
    );
    const label = sub === 'claim' ? 'claimed' : submit ? 'submitted for acceptance' : 'done';
    process.stdout.write(`${theme.ok('✓')} lane ${label}\n${renderLane(res.lane)}\n`);
    const claimsText = renderClaims(res.lane.claims);
    if (claimsText) process.stdout.write(`${claimsText}\n`);
    renderWarnings(res.warnings);
    // ADR 505 §6: on a claim, what this lane builds on — same lines as the MCP reply. `?? []` for
    // an older daemon.
    const built = res.built_on ?? [];
    if (built.length > 0) {
      process.stdout.write(`${theme.accent('built on')}:\n`);
      // Titles and accept notes are teammate-authored text going to a terminal: strip control
      // characters and escape sequences so a note cannot repaint the screen or forge a line
      // (security review, 2026-10-05).
      for (const b of built) process.stdout.write(`  ${plainTerminalText(builtOnLine(b))}\n`);
      process.stdout.write(theme.meta(BUILD_ON_CHECK) + '\n');
    }
    // value-layer design: the daemon's advisory notices (e.g. the ship nudge) reach the closer.
    for (const n of res.notices ?? []) process.stdout.write(`${theme.warn('▸')} ${n}\n`);
    if (submit) renderSubmitReport(res);
    if (sub === 'resolve') {
      // ADR 169 advisory nudge: closing your own lane records an unverified close.
      if (res.lane.owner_seat === identity.name) {
        process.stdout.write(
          theme.meta(
            'unconfirmed close recorded — prefer `musterd lane submit` when an acceptor is live (ADR 192)',
          ) + '\n',
        );
      }
      renderBranchCleanup(res.lane.branch);
    }
    return 0;
  }

  if (sub === 'release') {
    // The complement of `claim`: hand the lane back to the board rather than to a seat. `open` means
    // unowned, so the state move IS the release — the store clears the owner and the claim stamp.
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    // ADR 624: the reason becomes the lane's decline note, shown by the lane picker.
    const reason = flagStr(parsed.flags, 'reason');
    const res = await http.updateLane(team, id, {
      state: 'open',
      ...(reason ? { release_reason: reason } : {}),
    });
    process.stdout.write(
      `${theme.ok('✓')} lane released — open for anyone\n${renderLane(res.lane)}\n`,
    );
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'park') {
    // ADR 466: kept, deliberately not now. The daemon refuses a park from an agent and one without
    // a reason; this side only shapes the patch.
    const id = parsed.positionals[1];
    const reason = flagStr(parsed.flags, 'reason');
    if (!id || !reason) throw new CliError(USAGE, 2);
    const untilRaw = flagStr(parsed.flags, 'until');
    const until = untilRaw !== undefined ? Date.parse(untilRaw) : undefined;
    if (until !== undefined && Number.isNaN(until))
      throw new CliError(`--until must be a date, e.g. 2026-10-15 (got "${untilRaw}")`, 2);
    const res = await http.updateLane(team, id, {
      state: 'parked',
      park_reason: reason,
      ...(until !== undefined ? { park_until: until } : {}),
    });
    process.stdout.write(
      `${theme.ok('✓')} lane parked — kept, not offered; agents cannot claim it\n${renderLane(res.lane)}\n`,
    );
    return 0;
  }

  if (sub === 'unpark') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const res = await http.updateLane(team, id, { state: 'open' });
    process.stdout.write(
      `${theme.ok('✓')} lane unparked — open for anyone\n${renderLane(res.lane)}\n`,
    );
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'handoff') {
    const id = parsed.positionals[1];
    const to = flagStr(parsed.flags, 'to');
    if (!id || !to) throw new CliError(USAGE, 2);
    const res = await http.updateLane(team, id, {
      owner_seat: to,
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
      // ADR 243: the why rides the transfer's own act, so explaining a handoff never needs a
      // second, lane-less one.
      ...(flagStr(parsed.flags, 'note') !== undefined
        ? { handoff_note: flagStr(parsed.flags, 'note')! }
        : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane handed to ${to}\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    return 0;
  }

  if (sub === 'update') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const stateRaw = flagStr(parsed.flags, 'state');
    const state = stateRaw !== undefined ? LaneStateSchema.parse(stateRaw) : undefined;
    const res = await http.updateLane(team, id, {
      ...(state !== undefined ? { state } : {}),
      // ADR 240: correct a title that misstates the work — forward-only.
      ...(flagStr(parsed.flags, 'title') !== undefined
        ? { title: flagStr(parsed.flags, 'title')! }
        : {}),
      ...(flagStr(parsed.flags, 'detail') !== undefined
        ? { detail: flagStr(parsed.flags, 'detail')! }
        : {}),
      ...(flagStr(parsed.flags, 'branch') !== undefined
        ? { branch: flagStr(parsed.flags, 'branch')! }
        : {}),
      ...(flagStr(parsed.flags, 'project') !== undefined
        ? { project: flagStr(parsed.flags, 'project')! }
        : {}),
      ...(list(parsed.flags, 'surface') !== undefined
        ? { scope: list(parsed.flags, 'surface')! }
        : {}),
      ...(list(parsed.flags, 'area') !== undefined
        ? {
            areas:
              list(parsed.flags, 'area')!.length === 1 && list(parsed.flags, 'area')![0] === 'none'
                ? null
                : list(parsed.flags, 'area')!,
          }
        : {}),
      ...(list(parsed.flags, 'depends') !== undefined
        ? { depends_on: list(parsed.flags, 'depends')! }
        : {}),
      ...(flagStr(parsed.flags, 'stakes') !== undefined
        ? { stakes: parseStakes(flagStr(parsed.flags, 'stakes')!) }
        : {}),
      // Same flag as open: the ADR 256 no_goal warning names this repair, and open already
      // took --goal. A goal-less lane had no CLI way to attach after the fact.
      ...(flagStr(parsed.flags, 'goal') !== undefined
        ? { goal_id: flagStr(parsed.flags, 'goal')! }
        : {}),
      // ADR 561: the issue this lane came from; refused while another live lane holds it.
      ...(flagStr(parsed.flags, 'source-ref') !== undefined
        ? { source_ref: flagStr(parsed.flags, 'source-ref')! }
        : {}),
      ...(requestedFromFlags(parsed.flags, identity.name) !== undefined
        ? { requested: requestedFromFlags(parsed.flags, identity.name)! }
        : {}),
      // ADR 644: move the read's day (`none` clears it) and give its verdict.
      ...(flagStr(parsed.flags, 'reads-on') !== undefined
        ? {
            reads_on:
              flagStr(parsed.flags, 'reads-on')!.toLowerCase() === 'none'
                ? null
                : flagStr(parsed.flags, 'reads-on')!,
          }
        : {}),
      ...readVerdictFlags(parsed.flags),
      // ADR 305 amendment 2 (lane 01M2GR0434): the one verb for NONE — a lane stamped with the
      // wrong merge had no way back. Owner or admin only; the daemon refuses a counterpart.
      ...(parsed.flags['clear-merged'] === true ? { merged: null } : {}),
      // ADR 487: why a lane is dropped — with --state abandoned, or later on an abandoned lane.
      ...(flagStr(parsed.flags, 'abandon-reason') !== undefined
        ? { abandon_reason: flagStr(parsed.flags, 'abandon-reason')! }
        : {}),
    });
    process.stdout.write(`${theme.ok('✓')} lane updated\n${renderLane(res.lane)}\n`);
    renderWarnings(res.warnings);
    return 0;
  }

  throw new CliError(USAGE, 2);
}

/** `musterd lanes` — the board: who owns what, in what state, with live contention warnings. */
export async function lanesCommand(parsed: Parsed): Promise<number> {
  const { team, identity, http } = resolve(parsed.flags);
  // ADR 582 §1: the query is positional text — `musterd lanes area:ui goal:launch`, or bare words.
  // A lone lane id answers with that lane in full, the same as `musterd lane show <id>`.
  const query = parsed.positionals.join(' ').trim();
  const loneId = query === '' ? null : laneIdQuery(query);
  if (loneId) {
    const d = await http.laneShow(team, loneId);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(d) + '\n');
      return 0;
    }
    process.stdout.write(renderLane(d.lane) + '\n');
    for (const line of laneDetailLines(d)) {
      const text = plainTerminalLines(line);
      process.stdout.write(
        (line.startsWith('  ') || line === 'history:' ? theme.meta(text) : text) + '\n',
      );
    }
    renderWarnings(d.warnings);
    return 0;
  }
  const board = await http.laneBoard(team, {
    ...(flagStr(parsed.flags, 'project') !== undefined
      ? { project: flagStr(parsed.flags, 'project')! }
      : {}),
    ...(parsed.flags['mine'] === true ? { mine: true } : {}),
    ...(parsed.flags['open'] === true ? { open: true } : {}),
    ...(parsed.flags['history'] === true ? { history: true } : {}),
    ...(query !== '' ? { q: query } : {}),
  });
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(board) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent('lanes')} — ${team} (${board.lanes.length} lane${board.lanes.length === 1 ? '' : 's'}, viewing as ${identity.name})\n`,
  );
  if (board.lanes.length === 0) {
    process.stdout.write(
      (query !== ''
        ? theme.meta(`no lanes match ${JSON.stringify(query)} — every term must match`)
        : theme.meta('no lanes — `musterd lane open "<title>" --claim` to declare your work')) +
        '\n',
    );
    return 0;
  }
  // ADR 466: parked lanes are kept, not offered — listed last, under their own heading.
  const parked = board.lanes.filter((l) => l.state === 'parked');
  for (const l of board.lanes) if (l.state !== 'parked') process.stdout.write(renderLane(l) + '\n');
  if (parked.length > 0) {
    process.stdout.write(theme.meta(`parked (${parked.length}) — kept, not offered:`) + '\n');
    for (const l of parked) process.stdout.write(renderLane(l) + '\n');
  }
  renderWarnings(board.warnings);
  return 0;
}

/**
 * The routing report after a submit (ADR 192/235): who was asked, or that self-close is sanctioned,
 * or that the lane already had a standing acceptance. Shared by `lane submit` and `done --pr/--sha`
 * so the two closers cannot describe the same close differently.
 */
export function renderSubmitReport(res: Awaited<ReturnType<HttpClient['updateLane']>>): void {
  // ADR 192: report the acceptor routing — who was asked, or that self-close is sanctioned.
  if (res.review?.rerouted && res.review.reviewer) {
    // Lane 01M1QYHJFY: `--to` on a lane already awaiting acceptance moved the ask. Say so, and
    // that the previous holder was told — this branch used to fall through to "no acceptor was
    // ever routed", which was false and counselled an unconfirmed close.
    process.stdout.write(
      theme.meta(
        `acceptance re-routed to ${theme.memberName(res.review.reviewer, 'agent')} ` +
          `(${res.review.route ?? 'named'})` +
          `${res.review.superseded ? ` — ${res.review.superseded}'s ask is closed and they were told` : ''}. ` +
          `You are done; leave it with them.`,
      ) + '\n',
    );
  } else if (res.review?.standing) {
    // A repeat submit (e.g. recording the merge SHA after the PR landed) re-routes nothing;
    // the daemon reports the STANDING state. Before it did, the else-branch below read the
    // silence as "no eligible acceptor is live" and sanctioned self-close against lanes whose
    // acceptor had a pending ask — the premature unverified close ADR 235 exists to stop.
    process.stdout.write(
      theme.meta(
        res.review.reviewer
          ? `already awaiting acceptance from ${res.review.reviewer}` +
              `${res.review.route ? ` (${res.review.route})` : ''} — attestation recorded, ` +
              `nothing re-routed. Leave it with them.`
          : res.review.acceptance_exempt
            ? 'already awaiting close — this submit was acceptance-exempt (declared low ' +
              'stakes, ADR 234): `musterd lane resolve` when ready'
            : `no acceptor was ever routed (${emptyPoolHint(res.review.empty_pool)}) — self-close sanctioned: ` +
              '`musterd lane resolve` when ready (recorded unconfirmed)',
      ) + '\n',
    );
  } else if (!res.review) {
    // No routing decision and no standing report (an older daemon, or a patch that never
    // touched acceptance). Absence of a decision is not absence of an acceptor (ADR 173) —
    // abstain rather than assert, and never sanction self-close on silence.
  } else if (res.review.acceptance_exempt) {
    // ADR 234 increment 2: no ask by design, on the lane's own declared stakes — never worded
    // as the "nobody was eligible" degradation.
    process.stdout.write(
      theme.meta(
        'acceptance-exempt (declared low stakes, ADR 234) — no ask was routed and none is ' +
          'owed: `musterd lane resolve` when ready',
      ) + '\n',
    );
  } else if (res.review.reviewer) {
    // ADR 235: the advice follows the backstop. "Self-close on silence" was right while an
    // unaccepted lane hung forever; with a sweep armed it is what turns a recoverable wait into
    // a permanent unverified close — measured, the acceptor came back 20 of 20 times, an
    // average 106.8 minutes after the owner had already shut the lane.
    const backstop = res.review.backstop;
    process.stdout.write(
      `acceptance asked of ${theme.memberName(res.review.reviewer, 'agent')} ` +
        theme.meta(
          backstop?.armed
            ? `(${res.review.route}) — you are done; leave it with them. Do NOT self-close on ` +
                `silence: the daemon sweeps an unanswered lane after ` +
                `${Math.round(backstop.grace_ms / 3_600_000)}h. \`musterd lane resolve\` still ` +
                `works if you need it shut now, and records unconfirmed. ` +
                `Acceptor judges intent/principles/usable/feel — not a code review.`
            : `(${res.review.route}) — wait ≤${reviewWaitMinutes(res.review.wait_ms)}m; accept closes the lane, reject resumes it; ` +
                `on silence, \`musterd lane resolve\` yourself (recorded unconfirmed). ` +
                `Acceptor judges intent/principles/usable/feel — not a code review.`,
        ) +
        '\n',
    );
  } else {
    process.stdout.write(
      theme.meta(
        `${emptyPoolHint(res.review.empty_pool)} — self-close sanctioned: ` +
          '`musterd lane resolve` when ready (recorded unconfirmed)',
      ) + '\n',
    );
  }
}

/**
 * `--read-verdict met|missed|inconclusive --read-note "<what was read>"` → the ADR 644 patch field.
 * Both flags or neither: a verdict without a note, or a note without an outcome, fails here with the
 * repair rather than reaching the daemon half-formed. A typo in the outcome fails too.
 */
export function readVerdictFlags(flags: Parsed['flags']): {
  read_verdict?: { outcome: 'met' | 'missed' | 'inconclusive'; note: string };
} {
  const outcome = flagStr(flags, 'read-verdict');
  const note = flagStr(flags, 'read-note');
  if (outcome === undefined && note === undefined) return {};
  if (outcome === undefined || note === undefined)
    throw new CliError(
      'a read verdict needs both --read-verdict <outcome> and --read-note "<what was read>"',
      2,
    );
  if (outcome !== 'met' && outcome !== 'missed' && outcome !== 'inconclusive')
    throw new CliError(`--read-verdict is met, missed or inconclusive — got "${outcome}"`, 2);
  return { read_verdict: { outcome, note } };
}

/** `--follows-up a,b` / `--follows-up none` → the ADR 487 patch field; absent sends nothing. */
export function followsUpFlag(raw: string | undefined): { follows_up?: 'none' | string[] } {
  if (raw === undefined) return {};
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 1 && ids[0]!.toLowerCase() === 'none') return { follows_up: 'none' };
  return ids.length > 0 ? { follows_up: ids } : {};
}
