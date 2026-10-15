import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSeat,
  publishSeatFile,
  publishSeatFileReport,
  seatFileExists,
  seatFilePath,
  seatFileUnpublished,
  seatPublishLines,
  seatReachLines,
  unpublishedSeatLines,
  writeSeatFile,
} from './roster.js';

describe('roster seat-file writer (ADR 058 §5)', () => {
  it('buildSeat drops lifecycle/until when forever (minimal shape)', () => {
    expect(buildSeat({ kind: 'agent', role: 'reviewer' })).toEqual({
      kind: 'agent',
      role: 'reviewer',
    });
    expect(buildSeat({ kind: 'agent', role: 'x', lifecycle: 'forever' })).toEqual({
      kind: 'agent',
      role: 'x',
    });
  });

  it('buildSeat keeps a non-forever lifecycle and normalizes until to canonical ISO', () => {
    expect(
      buildSeat({ kind: 'agent', role: 'x', lifecycle: 'until', until: '2026-07-01T00:00:00Z' }),
    ).toEqual({ kind: 'agent', role: 'x', lifecycle: 'until', until: '2026-07-01T00:00:00.000Z' });
    expect(buildSeat({ kind: 'human', role: '', lifecycle: 'session' })).toEqual({
      kind: 'human',
      role: '',
      lifecycle: 'session',
    });
  });

  describe('writeSeatFile', () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'musterd-roster-'));
    });
    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('writes canonical TOML under <home>/.musterd/seats, token-free, coloured from birth (ADR 374)', () => {
      const p = writeSeatFile(home, 'olive', { kind: 'agent', role: 'reviewer' });
      expect(p).toBe(seatFilePath(home, 'olive'));
      expect(seatFileExists(home, 'olive')).toBe(true);
      const body = readFileSync(p, 'utf8');
      // The hue is assigned at write when the caller names none — the file is where a colour is born
      // on a file-backed team — and it lands as the last top-level key.
      expect(body).toMatch(/^kind = "agent"\nrole = "reviewer"\nhue = \d+\n$/);
      expect(body).not.toMatch(/token|mskd_/);
    });

    it('keeps an explicit hue, and a second seat is placed clear of the first', () => {
      writeSeatFile(home, 'olive', { kind: 'agent', role: 'reviewer', hue: 200 });
      expect(readFileSync(seatFilePath(home, 'olive'), 'utf8')).toBe(
        'kind = "agent"\nrole = "reviewer"\nhue = 200\n',
      );
      const p = writeSeatFile(home, 'olive-2', { kind: 'agent', role: 'reviewer' });
      const hue = Number(/hue = (\d+)/.exec(readFileSync(p, 'utf8'))![1]);
      expect(hue).not.toBe(200);
    });
  });
});

describe('seatFileUnpublished — a seat other machines cannot resolve yet (ADR 547)', () => {
  let root: string;
  let home: string;
  let remote: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-seatpub-'));
    remote = join(root, 'remote.git');
    home = join(root, 'home');
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['init', '--quiet', '-b', 'main', home]);
    git(home, 'config', 'user.email', 't@t');
    git(home, 'config', 'user.name', 't');
    git(home, 'remote', 'add', 'origin', remote);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('seatReachLines (ADR 591): no file → the team-add fix; unpublished → the git fix; published → null; no home → null', () => {
    expect(seatReachLines('resident', undefined)).toBeNull();
    const none = seatReachLines('resident', home, 'agent', 'worker');
    expect(none?.[0]).toContain('no seat file');
    expect(none?.[1]).toContain('musterd team add resident --kind agent --role worker');
    expect(none?.[1]).toContain('.musterd/seats/resident.toml');
    writeSeatFile(home, 'resident', { kind: 'agent' });
    const uncommitted = seatReachLines('resident', home);
    expect(uncommitted?.[0]).toContain('cannot resolve resident');
    expect(uncommitted?.[1]).toContain('git -C');
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'add resident');
    git(home, 'push', '-q', '-u', 'origin', 'main');
    expect(seatReachLines('resident', home)).toBeNull();
  });

  it('is null outside a git repo — nothing to publish through', () => {
    const plain = mkdtempSync(join(tmpdir(), 'musterd-nogit-'));
    try {
      writeSeatFile(plain, 'alfie', { kind: 'agent' });
      expect(seatFileUnpublished(plain, 'alfie')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('says uncommitted for a seat file git has never seen', () => {
    writeSeatFile(home, 'alfie', { kind: 'agent' });
    expect(seatFileUnpublished(home, 'alfie')).toBe('uncommitted');
  });

  it('says unpushed once committed but on no remote branch', () => {
    writeSeatFile(home, 'alfie', { kind: 'agent' });
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'add alfie');
    expect(seatFileUnpublished(home, 'alfie')).toBe('unpushed');
  });

  it('is null once the commit is on a remote branch, and when the file is edited later', () => {
    writeSeatFile(home, 'alfie', { kind: 'agent' });
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'add alfie');
    git(home, 'push', '-q', '-u', 'origin', 'main');
    expect(seatFileUnpublished(home, 'alfie')).toBeNull();
    // A local edit to an already-published seat is not "other machines cannot resolve it".
    writeSeatFile(home, 'alfie', { kind: 'agent', role: 'changed' });
    expect(seatFileUnpublished(home, 'alfie')).toBeNull();
  });

  it('treats a gitignored seat file as unpublished — it will never reach a peer', () => {
    writeSeatFile(home, 'alfie', { kind: 'agent' });
    writeFileSync(join(home, '.gitignore'), '.musterd/seats/\n');
    expect(seatFileUnpublished(home, 'alfie')).toBe('uncommitted');
  });
});

describe('unpublishedSeatLines — the one sentence for a seat file that has not reached a remote', () => {
  it('names the seat, the file and the exact git commands for an uncommitted file', () => {
    const [warn, how] = unpublishedSeatLines('alfie', '/r', 'uncommitted');
    expect(warn).toBe(
      'other machines cannot resolve alfie until .musterd/seats/alfie.toml is committed and pushed',
    );
    expect(how).toContain('their sync stops at the first event naming alfie');
    expect(how).toContain('git -C /r add .musterd/seats/alfie.toml');
    expect(how).toContain('commit -m "add alfie"');
    expect(how).toContain('push');
  });

  it('asks only for a push when the file is already committed', () => {
    const [warn, how] = unpublishedSeatLines('alfie', '/r', 'unpushed');
    expect(warn).toContain('until .musterd/seats/alfie.toml is pushed');
    expect(how).not.toContain(' add ');
    expect(how).toContain('git -C /r push');
  });
});

describe('publishSeatFile — a seat-making command pushes the seat file itself (ADR 592)', () => {
  let root: string;
  let home: string;
  let other: string;
  let remote: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const identify = (cwd: string) => {
    git(cwd, 'config', 'user.email', 't@t');
    git(cwd, 'config', 'user.name', 't');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-seatpublish-'));
    remote = join(root, 'remote.git');
    home = join(root, 'home');
    other = join(root, 'other');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '--quiet', remote, home]);
    identify(home);
    writeFileSync(join(home, 'team.toml'), 'slug = "bravo"\n');
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'team');
    git(home, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '--quiet', remote, other]);
    identify(other);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds, commits and pushes an uncommitted seat file — and only that file', () => {
    writeSeatFile(home, 'resident', { kind: 'agent' });
    writeFileSync(join(home, 'scratch.txt'), 'not a seat\n');
    expect(publishSeatFile(home, 'resident')).toEqual({ state: 'published' });
    expect(seatFileUnpublished(home, 'resident')).toBeNull();
    expect(git(home, 'log', '-1', '--format=%s')).toBe('roster: add resident');
    expect(git(home, 'show', '--stat', '--format=', 'HEAD')).toContain('resident.toml');
    expect(git(home, 'show', '--stat', '--format=', 'HEAD')).not.toContain('scratch.txt');
    expect(git(home, 'status', '--porcelain')).toContain('scratch.txt');
    // The other clone sees it on a plain pull.
    git(other, 'pull', '-q');
    expect(seatFileExists(other, 'resident')).toBe(true);
  });

  it('pushes a committed-but-unpushed file, and is a no-op on a published one', () => {
    writeSeatFile(home, 'resident', { kind: 'agent' });
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'add resident by hand');
    expect(publishSeatFile(home, 'resident')).toEqual({ state: 'published' });
    expect(git(home, 'log', '-1', '--format=%s')).toBe('add resident by hand');
    expect(publishSeatFile(home, 'resident')).toEqual({ state: 'already' });
  });

  it('catches up once when the remote moved first — two machines adding seats the same evening', () => {
    writeSeatFile(other, 'alfie', { kind: 'agent' });
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'roster: add alfie');
    git(other, 'push', '-q');
    writeSeatFile(home, 'resident', { kind: 'agent' });
    expect(publishSeatFile(home, 'resident')).toEqual({ state: 'published' });
    expect(seatFileExists(home, 'alfie')).toBe(true);
    git(other, 'pull', '-q');
    expect(seatFileExists(other, 'resident')).toBe(true);
  });

  it('publishSeatFileReport: publishes and says so, honours --no-publish, and is null with nothing to do', () => {
    expect(publishSeatFileReport('resident', undefined)).toBeNull();
    writeSeatFile(home, 'resident', { kind: 'agent' });
    const held = publishSeatFileReport('resident', home, { publish: false });
    expect(held?.outcome).toBeNull();
    expect(held?.warn?.[0]).toContain('resident');
    expect(seatFileUnpublished(home, 'resident')).toBe('uncommitted');
    const r = publishSeatFileReport('resident', home);
    expect(r?.outcome).toEqual({ state: 'published' });
    expect(r?.ok).toContain('published .musterd/seats/resident.toml');
    expect(r?.warn).toBeUndefined();
    git(other, 'pull', '-q');
    expect(seatFileExists(other, 'resident')).toBe(true);
    expect(publishSeatFileReport('resident', home)).toBeNull();
  });

  it('skipped outside git or without an upstream; failed carries what git said', () => {
    const plain = mkdtempSync(join(tmpdir(), 'musterd-nogit-'));
    try {
      writeSeatFile(plain, 'resident', { kind: 'agent' });
      expect(publishSeatFile(plain, 'resident')).toMatchObject({ state: 'skipped' });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const lone = join(root, 'lone');
    execFileSync('git', ['init', '--quiet', '-b', 'main', lone]);
    writeSeatFile(lone, 'resident', { kind: 'agent' });
    expect(publishSeatFile(lone, 'resident')).toMatchObject({
      state: 'skipped',
      detail: 'no upstream branch to push to',
    });
    // The same seat committed on both machines with different content: the rebase conflicts, and
    // the daemon's rule holds here too — report, never resolve.
    writeSeatFile(other, 'resident', { kind: 'agent', role: 'a' });
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'add resident on other');
    git(other, 'push', '-q');
    writeSeatFile(home, 'resident', { kind: 'agent', role: 'b' });
    const r = publishSeatFile(home, 'resident');
    expect(r.state).toBe('failed');
    expect(r.detail).toBeTruthy();
    git(home, 'rebase', '--abort');
    const lines = seatPublishLines('resident', home, r, seatFileUnpublished(home, 'resident'));
    expect(lines?.warn?.[0]).toContain('could not publish');
    expect(lines?.warn?.[1]).toContain('git -C');
  });
});
