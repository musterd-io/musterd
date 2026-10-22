import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  elsewhereLine,
  EMPTY_LAUNCHER_FILE,
  folderSeat,
  lastUsedAt,
  launcherFilePath,
  readLauncherFile,
  sameFolder,
  seatInFolder,
  type Seat,
  withExit,
  withLaunch,
  withSnapshot,
  writeLauncherFile,
} from './store.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-launcher-store-'));
  path = join(dir, 'launcher.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (over: Partial<Seat> = {}): Seat => ({
  address: 'revive/agents/stanley',
  team: 'revive',
  project: 'agents',
  member: 'stanley',
  server: 'http://127.0.0.1:4849',
  path: '/tmp/stanley',
  kind: 'agent',
  harnesses: ['claude-code'],
  remote: null,
  last_session: null,
  problem: null,
  ...over,
});

describe('launcher.json (ADR 491)', () => {
  it('lives beside config.json', () => {
    expect(launcherFilePath({ MUSTERD_CONFIG: '/x/y/config.json' })).toBe('/x/y/launcher.json');
  });

  it('a missing file reads as empty', () => {
    expect(readLauncherFile(path)).toEqual(EMPTY_LAUNCHER_FILE);
  });

  it('round-trips launches, exits and the snapshot, 0600', () => {
    let f = withLaunch(EMPTY_LAUNCHER_FILE, seat(), 'claude-code', 'fresh', 1_000);
    f = withExit(f, 'revive/agents/stanley', 61_000, 0);
    f = withSnapshot(f, {
      taken_at: 500,
      seats: [seat()],
      teams: [{ team: 'revive', here: true }],
    });
    writeLauncherFile(path, f);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = readLauncherFile(path);
    expect(back.last).toBe('revive/agents/stanley');
    expect(back.seats['revive/agents/stanley']).toEqual({
      path: '/tmp/stanley',
      harness: 'claude-code',
      mode: 'fresh',
      launched_at: 1_000,
      ended_at: 61_000,
      exit: 0,
    });
    expect(back.snapshot?.seats[0]?.member).toBe('stanley');
  });

  it('sets a corrupt file aside and reads empty — never throws', () => {
    writeFileSync(path, '{not json');
    expect(readLauncherFile(path, 42)).toEqual(EMPTY_LAUNCHER_FILE);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toContain('launcher.json.corrupt-42');
  });

  it('treats an off-schema file as corrupt too', () => {
    writeFileSync(path, JSON.stringify({ version: 9 }));
    expect(readLauncherFile(path, 7)).toEqual(EMPTY_LAUNCHER_FILE);
    expect(readFileSync(join(dir, 'launcher.json.corrupt-7'), 'utf8')).toContain('"version":9');
  });

  it('refuses to write an invalid object', () => {
    expect(() =>
      writeLauncherFile(path, { ...EMPTY_LAUNCHER_FILE, last: 3 as unknown as string }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('last used is the newer of the launcher record and the captured session start', () => {
    const s = seat({ last_session: { harness: 'claude-code', started_at: 5_000, ended_at: null } });
    expect(lastUsedAt(s, EMPTY_LAUNCHER_FILE)).toBe(5_000);
    const f = withLaunch(EMPTY_LAUNCHER_FILE, s, 'claude-code', 'fresh', 9_000);
    expect(lastUsedAt(s, f)).toBe(9_000);
    expect(lastUsedAt(seat(), EMPTY_LAUNCHER_FILE)).toBeNull();
  });
});

describe('the snapshot caches the roster-first rows (ADR 503 Decision 4)', () => {
  it('round-trips members as plain strings and reads an older snapshot without them', () => {
    const members = [
      {
        team: 'revive',
        member: 'bo',
        kind: 'agent' as const,
        address: null,
        where: 'node' as const,
        node: 'n-air',
        where_label: 'air-2',
        can: 'wake' as const,
      },
    ];
    writeLauncherFile(
      path,
      withSnapshot(structuredClone(EMPTY_LAUNCHER_FILE), {
        taken_at: 1,
        seats: [],
        teams: [],
        members,
      }),
    );
    expect(readLauncherFile(path).snapshot?.members).toEqual(members);
    writeLauncherFile(
      path,
      withSnapshot(structuredClone(EMPTY_LAUNCHER_FILE), { taken_at: 1, seats: [], teams: [] }),
    );
    expect(readLauncherFile(path).snapshot?.members).toBeUndefined();
  });
});

describe('folderSeat (ADR 717)', () => {
  const claim = (name: string, mode = 'seat') =>
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      claim: { mode, name },
      note: 'LEAKED-BINDING-BODY',
    });

  function workspace(root: string, body: string): void {
    mkdirSync(join(root, '.musterd'), { recursive: true });
    writeFileSync(join(root, '.musterd', 'workspace.json'), body);
  }

  it('reads a seat claim, including from a subfolder, and drops the rest of the file', () => {
    const root = join(dir, 'ghost');
    workspace(root, claim('ghost'));
    const sub = join(root, 'src');
    mkdirSync(sub);
    expect(folderSeat(sub, {})).toEqual({
      team: 'revive',
      member: 'ghost',
      root: realpathSync(root),
    });
    expect(JSON.stringify(folderSeat(root, {}))).not.toContain('LEAKED-BINDING-BODY');
  });

  it('stops at a chat or role claim and does not use a parent seat', () => {
    const parent = join(dir, 'ghost');
    workspace(parent, claim('ghost'));
    const chat = join(parent, 'room');
    workspace(chat, claim('ghost', 'chat'));
    const role = join(parent, 'desk');
    workspace(role, claim('designer', 'role'));
    expect(folderSeat(join(chat, 'src'), {})).toBeNull();
    expect(folderSeat(role, {})).toBeNull();
  });

  it('stops at an unreadable claim and does not use a parent seat', () => {
    const parent = join(dir, 'ghost');
    workspace(parent, claim('ghost'));
    const child = join(parent, 'nested');
    workspace(child, 'not json');
    expect(folderSeat(child, {})).toBeNull();
  });

  it('keeps walking when the directory has no workspace file', () => {
    const root = join(dir, 'ghost');
    workspace(root, claim('ghost'));
    expect(folderSeat(join(root, 'src', 'launcher'), {})).toEqual({
      team: 'revive',
      member: 'ghost',
      root: realpathSync(root),
    });
  });

  it('honors MUSTERD_BINDING only when its workspace is inside the walked directory', () => {
    const root = join(dir, 'ghost');
    const binding = join(root, '.musterd', 'binding.json');
    mkdirSync(join(root, '.musterd'), { recursive: true });
    writeFileSync(binding, claim('ghost'));
    const outside = join(dir, 'other', '.musterd', 'binding.json');
    mkdirSync(join(dir, 'other', '.musterd'), { recursive: true });
    writeFileSync(outside, claim('stanley'));
    expect(folderSeat(join(root, 'src'), { MUSTERD_BINDING: binding })).toEqual({
      team: 'revive',
      member: 'ghost',
      root: realpathSync(root),
    });
    expect(folderSeat(root, { MUSTERD_BINDING: outside })).toBeNull();
  });

  it('a workspace file wins over a binding that points somewhere else', () => {
    const root = join(dir, 'ghost');
    workspace(root, claim('ghost'));
    const outside = join(dir, 'other', '.musterd', 'binding.json');
    mkdirSync(join(dir, 'other', '.musterd'), { recursive: true });
    writeFileSync(outside, claim('stanley'));
    expect(folderSeat(root, { MUSTERD_BINDING: outside })?.member).toBe('ghost');
  });

  it('matches an existing path by realpath, and a missing path only when the strings match', () => {
    const root = join(dir, 'ghost');
    const other = join(dir, 'stanley');
    mkdirSync(root);
    mkdirSync(other);
    const scope = { team: 'revive', member: 'ghost', root };
    const here = seat({
      address: 'revive/agents/ghost',
      member: 'ghost',
      path: root,
    });
    const away = seat({
      address: 'revive/site/ghost',
      project: 'site',
      member: 'ghost',
      path: other,
    });
    expect(sameFolder(scope, here)).toBe(true);
    expect(sameFolder(scope, away)).toBe(false);
    expect(seatInFolder([away, here], scope)?.address).toBe('revive/agents/ghost');

    const missing = join(dir, 'not-here');
    const only = seat({ member: 'ghost', path: missing, address: 'revive/agents/ghost' });
    expect(seatInFolder([only], scope)).toBe(only);
    expect(sameFolder(scope, only)).toBe(false);

    const neither = { team: 'revive', member: 'ghost', root: missing };
    expect(sameFolder(neither, only)).toBe(true);
  });

  it('names where the other member starts', () => {
    expect(elsewhereLine('ghost', 'stanley', '/w/stanley')).toBe(
      'this folder is ghost — stanley starts from /w/stanley',
    );
    expect(elsewhereLine('ghost', 'bo', null)).toBe(
      "this folder is ghost — bo starts from bo's own workspace",
    );
    expect(elsewhereLine('ghost', 'bo', '')).toBe(
      "this folder is ghost — bo starts from bo's own workspace",
    );
  });
});
