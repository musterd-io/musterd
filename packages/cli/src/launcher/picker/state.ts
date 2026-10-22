import { rankSeats } from '../fuzzy.js';
import { chooseHarness, LAUNCHABLE_HARNESSES } from '../labels.js';
import type { Live } from '../live.js';
import {
  elsewhereLine,
  lastUsedAt,
  sameFolder,
  seatInFolder,
  type FolderScope,
  type LauncherFile,
  type MemberEntry,
  type Seat,
  type TeamEntry,
} from '../store.js';

/*
 * The picker as a pure state machine (ADR 491): keys and asynchronous answers in, a new state or an
 * outcome out. No I/O — tty.ts owns the terminal, index.ts owns the scans.
 */

export type Level =
  | { kind: 'recent' }
  | { kind: 'teams' }
  | { kind: 'projects'; team: string }
  | { kind: 'members'; team: string; project: string };

export type Row =
  | { kind: 'heading'; label: string }
  | { kind: 'seat'; seat: Seat; showAddress: boolean }
  | { kind: 'team'; team: string; here: boolean; count: number; star: boolean }
  | {
      kind: 'project';
      team: string;
      project: string;
      count: number;
      remote: string | null;
      star: boolean;
    }
  /** A roster member with no Workspace here (ADR 503): its where label and what ⏎ can do. */
  | { kind: 'member'; team: string; project: string; entry: MemberEntry }
  | { kind: 'new-seat'; team: string; project: string }
  | { kind: 'hint'; text: string };

/** Setting up a seat from the picker (ADR 491 Decision 10). */
export interface CreateDraft {
  team: string;
  project: string;
  member: string;
  /** Typing a name (`+ new seat`) vs. confirming a harness. */
  naming: boolean;
  /** Index into LAUNCHABLE_HARNESSES. */
  harness: number;
  error: string | null;
}

/** What `readline`'s keypress event carries. */
export interface Key {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

export interface PickerState {
  seats: Seat[];
  teams: TeamEntry[];
  stale: number;
  file: LauncherFile;
  live: Record<string, Live>;
  liveStatus: 'pending' | 'ok' | 'offline';
  /** Seats whose team's roster did not answer: their live state is unknown, never "idle". */
  unknownLive: string[];
  scanning: boolean;
  level: Level;
  stack: Level[];
  query: string;
  cursor: number;
  harness: Record<string, string>;
  /**
   * The harness step: an agent seat's configured harnesses, shown even when there is one, and
   * launched only on an explicit pick (nick, 2026-10-01).
   */
  choose: {
    seat: Seat;
    mode: 'fresh' | 'resume';
    options: string[];
    index: number;
    /** ADR 717: the extra row that rewrites this workspace's harness set. Unscoped steps omit it. */
    change: boolean;
  } | null;
  /** The member workspace this picker was opened from (ADR 717). Null keeps ADR 491. */
  scope: FolderScope | null;
  /**
   * The answering daemon's node label (ADR 720). Null until a loopback roster names it.
   * Painted only; `where` stays `here` for what ⏎ can do. Never a guessed hostname.
   */
  machine: string | null;
  /** One line after a refused start. The next key clears it. */
  notice: string | null;
  /** True until the first key, so a late catalog can still open this folder's harness step. */
  held: boolean;
  /** After a harness-set change, the id to land on once the catalog lists it. */
  prefer: string | null;
  /** `wake`: the live Presence is a wake on this machine, so the question is take over / watch
   *  (ADR 546) instead of "open a second session?". */
  confirm: { seat: Seat; mode: 'fresh' | 'resume'; wake: boolean } | null;
  help: boolean;
  /** Each team's roster-first rows (ADR 503): every member with where it lives and what this
   *  machine can do about it. From the snapshot first, then the roster reads. */
  members: Record<string, MemberEntry[]>;
  create: CreateDraft | null;
  now: number;
}

export type PickerEvent =
  | { type: 'key'; key: Key }
  | { type: 'catalog'; seats: Seat[]; teams: TeamEntry[]; stale: number; now: number }
  | {
      type: 'live';
      live: Record<string, Live>;
      status: 'ok' | 'offline';
      unknown?: string[];
      members?: Record<string, MemberEntry[]>;
      /** Absent keeps the label already on screen. Null means this read had none. */
      machine?: string | null;
      now: number;
    };

export type PickerOutcome =
  | { kind: 'launch'; seat: Seat; mode: 'fresh' | 'resume'; harness: string | null; force: boolean }
  /** ⏎ / `w` on the wake menu (ADR 546): `launchSeat` verifies the wake and does the rest. */
  | { kind: 'take-over'; seat: Seat; mode: 'fresh' | 'resume'; harness: string | null }
  | { kind: 'watch'; seat: Seat; mode: 'fresh' | 'resume'; harness: string | null }
  | { kind: 'quit'; code: number }
  | { kind: 'create'; team: string; project: string; member: string; harnesses: string[] }
  /** ⏎ on a `wake` row: ring the seat's doorbell — an ordinary steer (ADR 503 Decision 2). */
  | { kind: 'wake'; entry: MemberEntry }
  /** ⏎ on "configure harnesses": run this workspace's configure, then return to the step (ADR 720). */
  | { kind: 'configure'; seat: Seat };

type Step = { state: PickerState; outcome: PickerOutcome | null };

export function initialState(
  file: LauncherFile,
  query: string,
  now: number,
  scope: FolderScope | null = null,
): PickerState {
  const base: PickerState = {
    seats: file.snapshot?.seats ?? [],
    teams: file.snapshot?.teams ?? [],
    stale: 0,
    file,
    live: {},
    liveStatus: 'pending',
    unknownLive: [],
    scanning: true,
    level: { kind: 'recent' },
    stack: [],
    query,
    cursor: 0,
    harness: {},
    choose: null,
    confirm: null,
    help: false,
    members: groupByTeam(file.snapshot?.members ?? []),
    create: null,
    now,
    scope,
    machine: null,
    notice: null,
    held: scope !== null,
    prefer: null,
  };
  if (!scope) return base;
  const seat = seatInFolder(base.seats, scope);
  if (!seat) return base;
  if (seat.kind === 'human') {
    const at = cursorFor(base, seat);
    return at < 0 ? base : clamp(base, at);
  }
  return { ...base, choose: harnessChoice(base, seat, 'fresh', true) };
}

const seatRow = (seat: Seat, showAddress: boolean): Row => ({ kind: 'seat', seat, showAddress });

function groupByTeam(members: readonly MemberEntry[]): Record<string, MemberEntry[]> {
  const out: Record<string, MemberEntry[]> = {};
  for (const m of members) (out[m.team] ??= []).push(m);
  return out;
}

/** The roster-first row behind a seat here, when its team's roster has answered. */
export function entryFor(s: PickerState, seat: Seat): MemberEntry | null {
  return s.members[seat.team]?.find((m) => m.member === seat.member) ?? null;
}
const byMember = (a: Seat, b: Seat) => a.member.localeCompare(b.member);

/** How many recents the first screen shows before the teams section (ADR 540). */
export const RECENT_LIMIT = 5;

const lastTeamOf = (s: PickerState): Seat | undefined =>
  s.seats.find((x) => x.address === s.file.last);

/** One row per team the snapshot knows: here or not, how many seats, ★ on the one used last. */
function teamRows(s: PickerState): Row[] {
  const lastTeam = lastTeamOf(s);
  return s.teams.map(
    (t): Row => ({
      kind: 'team',
      team: t.team,
      here: t.here,
      count: s.seats.filter((x) => x.team === t.team).length,
      star: lastTeam?.team === t.team,
    }),
  );
}

/** The rows of the current level (or of the search, when there is a query). */
export function rows(s: PickerState): Row[] {
  const lastTeam = lastTeamOf(s);
  if (s.query.trim()) {
    const ranked = rankSeats(s.query, s.seats, (seat) => lastUsedAt(seat, s.file));
    return ranked.length
      ? [{ kind: 'heading', label: 'on this machine' }, ...ranked.map((x) => seatRow(x, true))]
      : [];
  }
  switch (s.level.kind) {
    case 'recent': {
      // ADR 540: the first screen is the recents, capped, then every team — so the shape of the
      // machine is on screen and a team is one ⏎ away without knowing a key.
      const used = s.seats
        .filter((x) => lastUsedAt(x, s.file) !== null)
        .sort((a, b) => (lastUsedAt(b, s.file) ?? 0) - (lastUsedAt(a, s.file) ?? 0));
      let list = (used.length ? used : [...s.seats]).slice(0, RECENT_LIMIT);
      // ADR 720: this folder's member stays on the recent screen even with no launch yet.
      if (s.scope) {
        const scope = s.scope;
        const mine = s.seats.find((x) => x.team === scope.team && x.member === scope.member);
        if (mine && !list.some((x) => x.address === mine.address))
          list = [mine, ...list].slice(0, RECENT_LIMIT);
      }
      const teams = s.teams.length
        ? [{ kind: 'heading', label: 'teams' } as Row, ...teamRows(s)]
        : [];
      return list.length
        ? [
            { kind: 'heading', label: used.length ? 'recent' : 'seats' },
            ...list.map((x) => seatRow(x, true)),
            ...teams,
          ]
        : teams;
    }
    case 'teams':
      return [{ kind: 'heading', label: 'teams' }, ...teamRows(s)];
    case 'projects': {
      const team = s.level.team;
      const projects = [
        ...new Set(s.seats.filter((x) => x.team === team).map((x) => x.project)),
      ].sort();
      return [
        { kind: 'heading', label: `${team} · projects` },
        ...projects.map((project): Row => {
          const inProject = s.seats.filter((x) => x.team === team && x.project === project);
          return {
            kind: 'project',
            team,
            project,
            count: inProject.length,
            remote: inProject.find((x) => x.remote)?.remote ?? null,
            star: lastTeam?.team === team && lastTeam.project === project,
          };
        }),
      ];
    }
    case 'members': {
      const { team, project } = s.level;
      const here = s.seats.filter((x) => x.team === team && x.project === project).sort(byMember);
      const mine = here.some((x) => x.kind === 'human' && x.problem === null);
      // ADR 503 Decision 3: every member once — under `on this machine` when a Workspace here
      // holds it, else under `on the team` with where it lives and what ⏎ can do from here.
      const away = (s.members[team] ?? []).filter(
        (m) => m.address === null && !s.seats.some((x) => x.team === team && x.member === m.member),
      );
      const out: Row[] = [
        { kind: 'heading', label: 'on this machine' },
        ...here.map((x) => seatRow(x, false)),
      ];
      if (away.length) {
        out.push({ kind: 'heading', label: 'on the team' });
        out.push(...away.map((entry): Row => ({ kind: 'member', team, project, entry })));
      }
      // A seat is set up acting as you, from your own Workspace here (ADR 491 §4.7).
      if (!mine)
        return [
          ...out,
          { kind: 'hint', text: 'set up your own seat here first: musterd human <you>' },
        ];
      return [...out, { kind: 'new-seat', team, project }];
    }
  }
}

export function selectable(row: Row): boolean {
  return row.kind !== 'heading' && row.kind !== 'hint' && !(row.kind === 'team' && !row.here);
}

export function selectableRows(s: PickerState): Row[] {
  return rows(s).filter(selectable);
}

const identity = (row: Row | undefined): string =>
  !row
    ? ''
    : row.kind === 'seat'
      ? row.seat.address
      : row.kind === 'team'
        ? `t:${row.team}`
        : row.kind === 'project'
          ? `p:${row.team}/${row.project}`
          : row.kind === 'member'
            ? `o:${row.entry.member}`
            : row.kind === 'new-seat'
              ? 'new'
              : '';

function clamp(s: PickerState, cursor: number): PickerState {
  const n = selectableRows(s).length;
  return { ...s, cursor: Math.min(Math.max(0, cursor), Math.max(0, n - 1)) };
}

function push(s: PickerState, level: Level): Step {
  return {
    state: { ...s, stack: [...s.stack, s.level], level, cursor: 0, query: '' },
    outcome: null,
  };
}

function pop(s: PickerState): PickerState {
  const prev = s.stack[s.stack.length - 1];
  return prev ? { ...s, level: prev, stack: s.stack.slice(0, -1), cursor: 0 } : s;
}

function activate(s: PickerState, mode: 'fresh' | 'resume'): Step {
  const row = selectableRows(s)[s.cursor];
  const refused = scopeRefusal(s, row);
  if (refused) return { state: { ...s, notice: refused }, outcome: null };
  if (mode === 'fresh' && row?.kind === 'member') {
    // The `can` table (ADR 503 Decision 2): set up only a seat that lives nowhere; wake one that
    // lives elsewhere when it is yours to wake; otherwise the row only says where it is.
    if (row.entry.can === 'setup') {
      const draft = { team: row.team, project: row.project, member: row.entry.member };
      return {
        state: { ...s, create: { ...draft, naming: false, harness: 0, error: null } },
        outcome: null,
      };
    }
    if (row.entry.can === 'wake') return { state: s, outcome: { kind: 'wake', entry: row.entry } };
    return { state: s, outcome: null };
  }
  if (mode === 'fresh' && row?.kind === 'new-seat') {
    const draft = { team: row.team, project: row.project, member: '' };
    return {
      state: { ...s, create: { ...draft, naming: true, harness: 0, error: null } },
      outcome: null,
    };
  }
  if (row?.kind === 'seat') {
    // ADR 503 Decision 2: a folder here whose seat is RESIDENT on another node is not launchable
    // from here — launch needs `where` here or nowhere. The footer already names the move ceremony.
    // A roster that never answered leaves no entry and changes nothing (absence is not a verdict).
    const entry = entryFor(s, row.seat);
    if (entry && entry.can === 'none' && (entry.where === 'node' || entry.where === 'cloud'))
      return { state: s, outcome: null };
    // An agent seat always goes through the harness step; a human seat gets a login shell.
    if (row.seat.kind !== 'human') {
      const change = s.scope !== null && sameFolder(s.scope, row.seat);
      return {
        state: { ...s, choose: harnessChoice(s, row.seat, mode, change) },
        outcome: null,
      };
    }
    return launchOrConfirm(s, row.seat, mode);
  }
  if (mode === 'fresh' && row?.kind === 'team' && row.here)
    return push(s, { kind: 'projects', team: row.team });
  if (mode === 'fresh' && row?.kind === 'project')
    return push(s, { kind: 'members', team: row.team, project: row.project });
  return { state: s, outcome: null };
}

/** Launch a picked seat, or ask first when it is already live. */
function launchOrConfirm(s: PickerState, seat: Seat, mode: 'fresh' | 'resume'): Step {
  const live = s.live[seat.address];
  if (live) {
    const wake = live.where === 'here' && live.wake !== undefined;
    return { state: { ...s, confirm: { seat, mode, wake } }, outcome: null };
  }
  return {
    state: s,
    outcome: {
      kind: 'launch',
      seat,
      mode,
      harness: shownHarness(s, seat),
      force: s.liveStatus === 'ok' && !s.unknownLive.includes(seat.address),
    },
  };
}

/** Keys in the harness step: ↑↓ choose, ⏎ launches the chosen one, esc goes back to the list. */
function onChooseKey(s: PickerState, c: NonNullable<PickerState['choose']>, key: Key): Step {
  const set = (choose: PickerState['choose']): Step => ({ state: { ...s, choose }, outcome: null });
  const span = c.options.length + (c.change ? 1 : 0);
  if (key.name === 'escape' || key.name === 'left') return set(null);
  if (span === 0) return set(c);
  if (key.name === 'up' || (key.ctrl && key.name === 'p'))
    return set({ ...c, index: (c.index - 1 + span) % span });
  if (key.name === 'down' || key.name === 'tab' || (key.ctrl && key.name === 'n'))
    return set({ ...c, index: (c.index + 1) % span });
  if (key.name === 'return') {
    if (c.change && c.index === c.options.length) {
      return { state: { ...s, choose: null }, outcome: { kind: 'configure', seat: c.seat } };
    }
    const picked = {
      ...s,
      choose: null,
      harness: { ...s.harness, [c.seat.address]: c.options[c.index]! },
    };
    return launchOrConfirm(picked, c.seat, c.mode);
  }
  return set(c);
}

/** One line when this folder may not start that row. Null means the row proceeds. */
function scopeRefusal(s: PickerState, row: Row | undefined): string | null {
  const scope = s.scope;
  if (!scope || !row) return null;
  if (row.kind === 'seat' && !sameFolder(scope, row.seat))
    return elsewhereLine(scope.member, row.seat.member, row.seat.path);
  if (row.kind === 'member' && (row.entry.team !== scope.team || row.entry.member !== scope.member))
    return elsewhereLine(scope.member, row.entry.member, null);
  if (row.kind === 'new-seat')
    return `this folder is ${scope.member} — a new seat starts from a folder that is not a member workspace`;
  return null;
}

function harnessChoice(
  s: PickerState,
  seat: Seat,
  mode: 'fresh' | 'resume',
  change: boolean,
): NonNullable<PickerState['choose']> {
  const configured = seat.harnesses.filter((h) => h !== 'musterd');
  const current = shownHarness(s, seat) ?? configured[0] ?? 'claude-code';
  const options = configured.length ? configured : [current];
  let index = Math.max(0, options.indexOf(current));
  if (s.prefer) {
    const at = options.indexOf(s.prefer);
    if (at >= 0) index = at;
  }
  return { seat, mode, options, index, change };
}

function cursorFor(s: PickerState, seat: Seat): number {
  return selectableRows(s).findIndex((r) => r.kind === 'seat' && r.seat.address === seat.address);
}

/** Keep the highlighted harness across a catalog refresh, or land on `prefer` while it is set. */
function refreshedChoose(
  s: PickerState,
  seats: readonly Seat[],
): NonNullable<PickerState['choose']> {
  const prev = s.choose!;
  const fresh = seats.find((x) => x.address === prev.seat.address) ?? prev.seat;
  const configured = fresh.harnesses.filter((h) => h !== 'musterd');
  const options = configured.length
    ? configured
    : prev.options.length
      ? prev.options
      : ['claude-code'];
  const preferred = s.prefer ? options.indexOf(s.prefer) : -1;
  let index = preferred >= 0 ? preferred : keptIndex(prev, options);
  if (!prev.change && index >= options.length) index = Math.max(0, options.length - 1);
  if (prev.change && index > options.length) index = options.length;
  return { ...prev, seat: fresh, options, index };
}

function keptIndex(prev: NonNullable<PickerState['choose']>, options: string[]): number {
  if (prev.change && prev.index >= prev.options.length) return options.length;
  const id = prev.options[prev.index];
  if (id) {
    const at = options.indexOf(id);
    if (at >= 0) return at;
  }
  return Math.min(prev.index, Math.max(0, options.length - 1));
}

/**
 * The harness a row shows and ⏎ launches: the one picked with ⇥, else what `chooseHarness` would
 * pick (the one used last). Null for a human seat, which gets a login shell.
 */
export function shownHarness(s: PickerState, seat: Seat): string | null {
  if (seat.kind === 'human') return null;
  return (
    s.harness[seat.address] ??
    chooseHarness(seat, null, s.file.seats[seat.address]?.harness ?? null)
  );
}

function cycleHarness(s: PickerState): PickerState {
  const row = selectableRows(s)[s.cursor];
  if (row?.kind !== 'seat') return s;
  const choices = row.seat.harnesses.filter((h) => h !== 'musterd');
  if (choices.length < 2) return s;
  const current = shownHarness(s, row.seat) ?? choices[0]!;
  const next = choices[(choices.indexOf(current) + 1) % choices.length]!;
  return { ...s, harness: { ...s.harness, [row.seat.address]: next } };
}

function onKey(s0: PickerState, key: Key): Step {
  const none = (state: PickerState): Step => ({ state, outcome: null });
  if (key.ctrl && key.name === 'c') return { state: s0, outcome: { kind: 'quit', code: 130 } };
  // The key that sets a notice keeps it; this clear is what the next key does. `held` drops so a
  // catalog that arrives after the person has started moving does not reopen the harness step.
  const s: PickerState = { ...s0, held: false, notice: null, prefer: null };
  if (s.create) return onCreateKey(s, s.create, key);
  if (s.choose) return onChooseKey(s, s.choose, key);
  if (s.confirm?.wake) {
    const { seat, mode } = s.confirm;
    const harness = shownHarness(s, seat);
    if (key.name === 'return')
      return {
        state: { ...s, confirm: null },
        outcome: { kind: 'take-over', seat, mode, harness },
      };
    if (key.name === 'w' || key.sequence === 'W')
      return { state: { ...s, confirm: null }, outcome: { kind: 'watch', seat, mode, harness } };
    if (key.name === 'escape') return none({ ...s, confirm: null });
    return none(s); // anything else is not an answer to this question
  }
  if (s.confirm) {
    if (key.name === 'y' || key.sequence === 'Y') {
      const { seat, mode } = s.confirm;
      return {
        state: { ...s, confirm: null },
        outcome: {
          kind: 'launch',
          seat,
          mode,
          harness: shownHarness(s, seat),
          force: true,
        },
      };
    }
    return none({ ...s, confirm: null });
  }
  if (s.help) return none({ ...s, help: false });
  switch (key.name) {
    case 'escape':
      if (s.query) return none(clamp({ ...s, query: '' }, 0));
      if (s.stack.length) return none(pop(s));
      return { state: s, outcome: { kind: 'quit', code: 0 } };
    case 'up':
      return none(clamp(s, s.cursor - 1));
    case 'down':
      return none(clamp(s, s.cursor + 1));
    case 'return':
      return activate(s, 'fresh');
    case 'tab':
      return none(cycleHarness(s));
    case 'right': {
      // → browses; it never launches. From the first screen it opens the teams level (ADR 540).
      if (!s.query && s.level.kind === 'recent') return push(s, { kind: 'teams' });
      const row = selectableRows(s)[s.cursor];
      return row?.kind === 'seat' ? none(s) : activate(s, 'fresh');
    }
    case 'left':
      return none(pop(s));
    case 'backspace':
      return none(clamp({ ...s, query: s.query.slice(0, -1) }, 0));
  }
  if (key.ctrl && key.name === 'p') return none(clamp(s, s.cursor - 1));
  if (key.ctrl && key.name === 'n') return none(clamp(s, s.cursor + 1));
  if (key.ctrl && key.name === 'r') return activate(s, 'resume');
  const ch = key.sequence;
  if (ch === '?' && !s.query) return none({ ...s, help: true });
  if (ch && ch.length === 1 && ch >= ' ' && !key.ctrl && !key.meta)
    return none(clamp({ ...s, query: s.query + ch }, 0));
  return none(s);
}

export function reduce(s: PickerState, e: PickerEvent): Step {
  if (e.type === 'catalog') {
    const keep = identity(selectableRows(s)[s.cursor]);
    let next: PickerState = {
      ...s,
      seats: e.seats,
      teams: e.teams,
      stale: e.stale,
      scanning: false,
      now: e.now,
    };
    let pinHuman: Seat | null = null;
    if (next.choose) next = { ...next, choose: refreshedChoose(next, e.seats) };
    else if (next.held && next.scope) {
      const seat = seatInFolder(e.seats, next.scope);
      if (seat?.kind === 'human') pinHuman = seat;
      else if (seat) next = { ...next, choose: harnessChoice(next, seat, 'fresh', true) };
    }
    const at = selectableRows(next).findIndex((r) => identity(r) === keep);
    next = clamp(next, at === -1 ? s.cursor : at);
    if (pinHuman) {
      const hit = cursorFor(next, pinHuman);
      if (hit >= 0) next = clamp(next, hit);
    }
    return { state: next, outcome: null };
  }
  if (e.type === 'live')
    return {
      state: {
        ...s,
        live: e.live,
        liveStatus: e.status,
        unknownLive: e.unknown ?? [],
        members: e.members ?? s.members,
        machine: e.machine !== undefined ? e.machine : s.machine,
        now: e.now,
      },
      outcome: null,
    };
  return onKey(s, e.key);
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Keys while a set-up draft is open: name it (for `+ new seat`), pick a harness, confirm, or cancel. */
function onCreateKey(s: PickerState, d: CreateDraft, key: Key): Step {
  const set = (create: CreateDraft | null): Step => ({ state: { ...s, create }, outcome: null });
  if (key.name === 'escape') return set(null);
  if (d.naming) {
    if (key.name === 'return') {
      if (!NAME.test(d.member))
        return set({
          ...d,
          error: 'a seat name is lowercase letters, digits and dashes, starting with a letter',
        });
      if (s.seats.some((x) => x.team === d.team && x.member === d.member))
        return set({ ...d, error: `${d.member} already has a Workspace here` });
      return set({ ...d, naming: false, error: null });
    }
    if (key.name === 'backspace') return set({ ...d, member: d.member.slice(0, -1), error: null });
    const ch = key.sequence;
    if (ch && ch.length === 1 && ch >= ' ' && !key.ctrl && !key.meta)
      return set({ ...d, member: d.member + ch.toLowerCase(), error: null });
    return set(d);
  }
  if (key.name === 'tab')
    return set({ ...d, harness: (d.harness + 1) % LAUNCHABLE_HARNESSES.length });
  if (key.name === 'return') {
    return {
      state: { ...s, create: null },
      outcome: {
        kind: 'create',
        team: d.team,
        project: d.project,
        member: d.member,
        harnesses: [LAUNCHABLE_HARNESSES[d.harness]!],
      },
    };
  }
  return set(d);
}
