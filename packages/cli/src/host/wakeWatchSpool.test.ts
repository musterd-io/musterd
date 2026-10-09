import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openWakeWatchSpool,
  SPOOL_MAX_BYTES,
  spoolLinesFor,
  WAKE_WATCH_FILE,
} from './wakeWatchSpool.js';

let ws: string;
const file = (): string => join(ws, BINDING_DIR, WAKE_WATCH_FILE);
const lines = (): unknown[] =>
  readFileSync(file(), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'musterd-spool-'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('spoolLinesFor — words and tool calls, nothing else', () => {
  it('keeps text and tool_use blocks and drops thinking and tool results', () => {
    const out = spoolLinesFor(
      [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'checking the inbox' },
        { type: 'tool_use', name: 'team_send', input: { to: 'nick', body: 'hi', extra: 1 } },
        { type: 'tool_result', content: 'FILE CONTENTS' },
      ],
      7,
    );
    expect(out).toEqual([
      { t: 7, k: 'text', s: 'checking the inbox' },
      { t: 7, k: 'tool', n: 'team_send', a: 'nick' },
    ]);
  });

  it('scrubs credentials and clips long fields at write time', () => {
    const [text] = spoolLinesFor(
      [{ type: 'text', text: `key mskey_${'a'.repeat(40)} ${'x'.repeat(900)}` }],
      1,
    );
    expect(JSON.stringify(text)).not.toContain('mskey_aaaa');
    expect((text as { s: string }).s.length).toBeLessThanOrEqual(520);
  });

  it('is empty for anything that is not an array of blocks', () => {
    expect(spoolLinesFor(null, 1)).toEqual([]);
    expect(spoolLinesFor('text', 1)).toEqual([]);
    expect(spoolLinesFor([null, 3, { type: 'text', text: '  ' }], 1)).toEqual([]);
  });
});

describe('openWakeWatchSpool', () => {
  it('writes the lease header, the turns, then the end line — mode 0600', () => {
    const s = openWakeWatchSpool(ws, 'L1');
    s.turn([{ type: 'text', text: 'hello' }], 5);
    s.end(true);
    expect(lines()).toEqual([
      { lease_id: 'L1' },
      { t: 5, k: 'text', s: 'hello' },
      { end: 'clean' },
    ]);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('marks a cut-short run as early', () => {
    const s = openWakeWatchSpool(ws, 'L1');
    s.end(false);
    expect(lines().at(-1)).toEqual({ end: 'early' });
  });

  it('stops appending past the cap but still writes the end line', () => {
    const s = openWakeWatchSpool(ws, 'L1');
    for (let i = 0; i < 2000; i++) s.turn([{ type: 'text', text: 'y'.repeat(400) + i }], i);
    s.end(true);
    expect(statSync(file()).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES + 64);
    expect(lines().at(-1)).toEqual({ end: 'clean' });
  });

  it('replaces a symlink planted at the path instead of writing through it', () => {
    const target = join(ws, 'victim.txt');
    openWakeWatchSpool(ws, 'L0'); // creates the dir
    rmSync(file());
    symlinkSync(target, file());
    openWakeWatchSpool(ws, 'L1').turn([{ type: 'text', text: 'x' }], 1);
    expect(existsSync(target)).toBe(false);
  });

  it('keeps writing to the file it created when the path is swapped for a symlink later', () => {
    const target = join(ws, 'victim.txt');
    const s = openWakeWatchSpool(ws, 'L1');
    rmSync(file());
    symlinkSync(target, file());
    s.turn([{ type: 'text', text: 'x' }], 1);
    s.end(true);
    expect(existsSync(target)).toBe(false);
  });

  it('writes nothing when the binding folder is itself a symlink', () => {
    const elsewhere = join(ws, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(ws, BINDING_DIR));
    const s = openWakeWatchSpool(ws, 'L1');
    s.turn([{ type: 'text', text: 'x' }], 1);
    s.end(true);
    expect(existsSync(join(elsewhere, WAKE_WATCH_FILE))).toBe(false);
  });

  it('never throws when the folder cannot be written', () => {
    const s = openWakeWatchSpool(join(ws, 'missing', '\0bad'), 'L1');
    expect(() => {
      s.turn([{ type: 'text', text: 'x' }], 1);
      s.end(true);
    }).not.toThrow();
  });
});
