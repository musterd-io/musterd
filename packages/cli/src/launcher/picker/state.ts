import { rankSeats } from '../fuzzy.js';
import { chooseHarness, LAUNCHABLE_HARNESSES } from '../labels.js';
import type { Live } from '../live.js';
import { lastUsedAt, type LauncherFile, type Seat, type TeamEntry } from '../store.js';

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
  | { kind: 'team-only'; team: string; project: string; member: string }
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
  choose: { seat: Seat; mode: 'fresh' | 'resume'; options: string[]; index: number } | null;
  confirm: { seat: Seat; mode: 'fresh' | 'resume' } | null;
  help: boolean;
  /** Each team's agent members from its roster, for "on the team · not here". */
  agents: Record<string, string[]>;
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
      agents?: Record<string, string[]>;
      now: number;
    };

export type PickerOutcome =
  | { kind: 'launch'; seat: Seat; mode: 'fresh' | 'resume'; harness: string | null; force: boolean }
  | { kind: 'quit'; code: number }
  | { kind: 'create'; team: string; project: string; member: string; harnesses: string[] };

type Step = { state: PickerState; outcome: PickerOutcome | null };

export function initialState(file: LauncherFile, query: string, now: number): PickerState {
  return {
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
    agents: {},
    create: null,
    now,
  };
}

const seatRow = (seat: Seat, showAddress: boolean): Row => ({ kind: 'seat', seat, showAddress });
const byMember = (a: Seat, b: Seat) => a.member.localeCompare(b.member);

/** The rows of the current level (or of the search, when there is a query). */
export function rows(s: PickerState): Row[] {
  if (s.query.trim()) {
    const ranked = rankSeats(s.query, s.seats, (seat) => lastUsedAt(seat, s.file));
    return ranked.length
      ? [{ kind: 'heading', label: 'on this machine' }, ...ranked.map((x) => seatRow(x, true))]
      : [];
  }
  const lastTeam = s.seats.find((x) => x.address === s.file.last);
  switch (s.level.kind) {
    case 'recent': {
      const used = s.seats
        .filter((x) => lastUsedAt(x, s.file) !== null)
        .sort((a, b) => (lastUsedAt(b, s.file) ?? 0) - (lastUsedAt(a, s.file) ?? 0));
      const list = used.length ? used : [...s.seats];
      return list.length
        ? [
            { kind: 'heading', label: used.length ? 'recent' : 'seats' },
            ...list.map((x) => seatRow(x, true)),
          ]
        : [];
    }
    case 'teams':
      return [
        { kind: 'heading', label: 'teams' },
        ...s.teams.map(
          (t): Row => ({
            kind: 'team',
            team: t.team,
            here: t.here,
            count: s.seats.filter((x) => x.team === t.team).length,
            star: lastTeam?.team === t.team,
          }),
        ),
      ];
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
      const teamOnly = (s.agents[team] ?? []).filter(
        (name) => !here.some((x) => x.member === name),
      );
      const out: Row[] = [
        { kind: 'heading', label: 'on this machine' },
        ...here.map((x) => seatRow(x, false)),
      ];
      // A seat is set up acting as you, from your own Workspace here (ADR 491 §4.7).
      if (!mine)
        return [
          ...out,
          { kind: 'hint', text: 'set up your own seat here first: musterd human <you>' },
        ];
      return [
        ...out,
        { kind: 'heading', label: 'on the team · not here' },
        ...teamOnly.map((member): Row => ({ kind: 'team-only', team, project, member })),
        { kind: 'new-seat', team, project },
      ];
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
          : row.kind === 'team-only'
            ? `o:${row.member}`
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
  if (mode === 'fresh' && row?.kind === 'team-only') {
    const draft = { team: row.team, project: row.project, member: row.member };
    return {
      state: { ...s, create: { ...draft, naming: false, harness: 0, error: null } },
      outcome: null,
    };
  }
  if (mode === 'fresh' && row?.kind === 'new-seat') {
    const draft = { team: row.team, project: row.project, member: '' };
    return {
      state: { ...s, create: { ...draft, naming: true, harness: 0, error: null } },
      outcome: null,
    };
  }
  if (row?.kind === 'seat') {
    // An agent seat always goes through the harness step; a human seat gets a login shell.
    if (row.seat.kind !== 'human') {
      const configured = row.seat.harnesses.filter((h) => h !== 'musterd');
      const current = shownHarness(s, row.seat)!;
      const options = configured.length ? configured : [current];
      const index = Math.max(0, options.indexOf(current));
      return { state: { ...s, choose: { seat: row.seat, mode, options, index } }, outcome: null };
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
  if (s.live[seat.address]) return { state: { ...s, confirm: { seat, mode } }, outcome: null };
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
  const n = c.options.length;
  if (key.name === 'escape' || key.name === 'left') return set(null);
  if (key.name === 'up' || (key.ctrl && key.name === 'p'))
    return set({ ...c, index: (c.index - 1 + n) % n });
  if (key.name === 'down' || key.name === 'tab' || (key.ctrl && key.name === 'n'))
    return set({ ...c, index: (c.index + 1) % n });
  if (key.name === 'return') {
    const picked = {
      ...s,
      choose: null,
      harness: { ...s.harness, [c.seat.address]: c.options[c.index]! },
    };
    return launchOrConfirm(picked, c.seat, c.mode);
  }
  return set(c);
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

function onKey(s: PickerState, key: Key): Step {
  const none = (state: PickerState): Step => ({ state, outcome: null });
  if (key.ctrl && key.name === 'c') return { state: s, outcome: { kind: 'quit', code: 130 } };
  if (s.create) return onCreateKey(s, s.create, key);
  if (s.choose) return onChooseKey(s, s.choose, key);
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
      // → browses; it never launches.
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
    const next: PickerState = {
      ...s,
      seats: e.seats,
      teams: e.teams,
      stale: e.stale,
      scanning: false,
      now: e.now,
    };
    const at = selectableRows(next).findIndex((r) => identity(r) === keep);
    return { state: clamp(next, at === -1 ? s.cursor : at), outcome: null };
  }
  if (e.type === 'live')
    return {
      state: {
        ...s,
        live: e.live,
        liveStatus: e.status,
        unknownLive: e.unknown ?? [],
        agents: e.agents ?? s.agents,
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
