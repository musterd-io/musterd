import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LAUNCHER_FILE,
  lastUsedAt,
  launcherFilePath,
  readLauncherFile,
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
