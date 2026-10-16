import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enumerateMuseSessions, resetSessionScan } from './enumerate.js';

let home = '';
const dirs: string[] = [];

afterEach(() => {
  resetSessionScan();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-muse-ws-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.musterd'));
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    '{"version":2,"server":"http://127.0.0.1:4849","team":"dawn"}',
  );
  return dir;
}

function sessionLog(cwd: string, id: string, mtimeMs?: number): void {
  const dir = join(home, '.local', 'share', 'muse', 'sessions', '2026', '10', '15', id);
  mkdirSync(dir, { recursive: true });
  const frame =
    `{"retained_frame":"x","children":[{"child_index":0,` +
    `"record_json":"{\\"payload\\":{\\"workspace_root\\":\\"${cwd}\\"}}"}]}\n`;
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, frame);
  if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

describe('enumerateMuseSessions (ADR 619)', () => {
  it('attributes session.jsonl by its recorded workspace_root and ignores a foreign one', () => {
    home = mkdtempSync(join(tmpdir(), 'musterd-muse-home-'));
    dirs.push(home);
    const mine = workspace();
    const other = workspace();
    sessionLog(mine, 'sess-mine');
    sessionLog(other, 'sess-other');
    const rows = enumerateMuseSessions(mine, home);
    expect(rows?.map((r) => r.id)).toEqual(['sess-mine']);
    expect(rows?.[0]?.path).toContain('session.jsonl');
    expect(rows?.[0]?.bytes).toBeGreaterThan(0);
  });

  it('orders newest write first', () => {
    home = mkdtempSync(join(tmpdir(), 'musterd-muse-home-'));
    dirs.push(home);
    const mine = workspace();
    sessionLog(mine, 'sess-old', 1_000_000);
    sessionLog(mine, 'sess-new', 2_000_000);
    expect(enumerateMuseSessions(mine, home)?.map((r) => r.id)).toEqual(['sess-new', 'sess-old']);
  });

  it('a log with no workspace_root is unattributable — [] when the tree exists, never a guess', () => {
    home = mkdtempSync(join(tmpdir(), 'musterd-muse-home-'));
    dirs.push(home);
    const mine = workspace();
    const dir = join(home, '.local', 'share', 'muse', 'sessions', '2026', '10', '15', 'sess-bare');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), '{"retained_frame":"x"}\n');
    expect(enumerateMuseSessions(mine, home)).toEqual([]);
  });

  it('returns undefined when the sessions tree cannot be read', () => {
    expect(
      enumerateMuseSessions('/tmp/no-such-ws', join(tmpdir(), 'no-muse-home-xyz')),
    ).toBeUndefined();
  });
});
