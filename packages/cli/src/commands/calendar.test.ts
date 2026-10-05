import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CalendarEntry } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import {
  artifactDocToInput,
  calendarCommand,
  filterEntries,
  readArtifactExport,
  renderLine,
} from './calendar.js';
import { teamCommand } from './team.js';

/** Two documents as the claude.ai artifact stores them: `''` for none, the id outside the body. */
const ARTIFACT = {
  'd-oct1': {
    date: '2026-10-01',
    end: '',
    kind: 'demo',
    note: '~75 people, 9 min.',
    pick: true,
    place: '425 Bush St',
    source: '',
    start: '17:00',
    status: 'done',
    title: 'Demo: Multiplayer AI & How We Get There',
    url: 'https://luma.com/fj1r2uu7',
  },
  'dl-yc': {
    date: '2099-11-10',
    end: '',
    kind: 'deadline',
    note: '',
    pick: false,
    place: '',
    source: 'Luma',
    start: '',
    status: '',
    title: 'YC application due',
    url: '',
  },
};

describe('calendar import mapping (ADR 519 §5)', () => {
  it("maps '' to null and the document id to source_ref", () => {
    const r = artifactDocToInput('dl-yc', ARTIFACT['dl-yc']);
    expect(r).toEqual({
      ok: true,
      input: {
        title: 'YC application due',
        date: '2099-11-10',
        start: null,
        end: null,
        tz: 'America/Los_Angeles',
        kind: 'deadline',
        status: null,
        place: '',
        url: null,
        note: '',
        pick: false,
        source: 'Luma',
        source_ref: 'dl-yc',
      },
    });
  });

  it('refuses a document the schema refuses, naming the field', () => {
    const r = artifactDocToInput('bad', { ...ARTIFACT['dl-yc'], kind: 'party' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('kind');
  });

  it('reads a directory of <id>.json, an array with ids, and an id → doc object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-cal-export-'));
    try {
      mkdirSync(join(dir, 'events'));
      for (const [id, doc] of Object.entries(ARTIFACT)) {
        writeFileSync(join(dir, 'events', `${id}.json`), JSON.stringify(doc));
      }
      writeFileSync(join(dir, 'map.json'), JSON.stringify(ARTIFACT));
      writeFileSync(
        join(dir, 'array.json'),
        JSON.stringify(Object.entries(ARTIFACT).map(([id, d]) => ({ id, ...d }))),
      );
      for (const p of ['events', 'map.json', 'array.json']) {
        const { inputs, refused } = readArtifactExport(join(dir, p));
        expect(refused).toEqual([]);
        expect(inputs.map((i) => i.source_ref).sort()).toEqual(['d-oct1', 'dl-yc']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('calendar views', () => {
  const e = (over: Partial<CalendarEntry>): CalendarEntry => ({
    id: over.id ?? 'x',
    title: 'T',
    date: '2026-10-08',
    start: null,
    end: null,
    tz: 'America/Los_Angeles',
    kind: 'event',
    status: null,
    place: '',
    url: null,
    note: '',
    pick: false,
    source: '',
    source_ref: null,
    created_by: 'nick',
    created_at: 1,
    updated_at: 1,
    ...over,
  });

  it('upcoming from today, past newest first, picks and kind filters', () => {
    const all = [
      e({ id: 'a', date: '2026-10-01', pick: true }),
      e({ id: 'b', date: '2026-10-04' }),
      e({ id: 'c', date: '2026-10-05', kind: 'demo', pick: true }),
      e({ id: 'd', date: '2026-10-09' }),
    ];
    const ids = (xs: CalendarEntry[]) => xs.map((x) => x.id);
    const today = '2026-10-05';
    expect(ids(filterEntries(all, { range: 'upcoming', picks: false, today }))).toEqual(['c', 'd']);
    expect(ids(filterEntries(all, { range: 'past', picks: false, today }))).toEqual(['b', 'a']);
    expect(ids(filterEntries(all, { range: 'all', picks: true, today }))).toEqual(['a', 'c']);
    expect(ids(filterEntries(all, { range: 'all', picks: false, kind: 'demo', today }))).toEqual([
      'c',
    ]);
  });

  it('one line: day, time, pick star, kind, title, place, status', () => {
    expect(
      renderLine(
        e({
          date: '2026-10-08',
          start: '14:00',
          end: '14:30',
          pick: true,
          kind: 'demo',
          title: 'SF Tech Week demo',
          place: 'Mission Bay',
          status: 'going',
        }),
      ),
    ).toBe('Thu Oct 08  14:00–14:30  ★ demo      SF Tech Week demo · Mission Bay [going]');
    // An entry any Member wrote cannot drive the reader's terminal: control bytes print as U+FFFD.
    expect(renderLine(e({ title: 'Deck\u001b]0;pwned\u0007 due', place: 'a\u001b[2Jb' }))).toBe(
      'Thu Oct 08  all day        event     Deck\ufffd]0;pwned\ufffd due · a\ufffd[2Jb',
    );
    expect(renderLine(e({ title: 'Deck due', kind: 'deadline' }))).toBe(
      'Thu Oct 08  all day        deadline  Deck due',
    );
  });
});

describe('calendar command against a daemon', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-calendar-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }
  const run = (...argv: string[]) => capture(() => calendarCommand(parseArgs(argv)));

  it('import twice: created, then all unchanged', async () => {
    const file = join(dir, 'events.json');
    writeFileSync(file, JSON.stringify(ARTIFACT));
    const first = await run('import', file);
    expect(first.code).toBe(0);
    expect(first.out).toContain('imported 2: 2 created, 0 updated, 0 unchanged');
    const again = await run('import', file);
    expect(again.out).toContain('imported 2: 0 created, 0 updated, 2 unchanged');

    const listed = JSON.parse((await run('--all', '--json')).out) as CalendarEntry[];
    expect(listed.map((x) => x.source_ref)).toEqual(['d-oct1', 'dl-yc']);
  });

  it('add, edit (a flag given as "" clears it), rm', async () => {
    const added = await run(
      'add',
      'Pitch practice',
      '--date',
      '2099-10-09',
      '--kind',
      'pitch',
      '--start',
      '10:00',
      '--pick',
      '--json',
    );
    expect(added.code).toBe(0);
    const entry = JSON.parse(added.out) as CalendarEntry;
    expect(entry).toMatchObject({ title: 'Pitch practice', start: '10:00', pick: true });

    const edited = JSON.parse(
      (await run('edit', entry.id, '--start', '', '--status', 'going', '--unpick', '--json')).out,
    );
    expect(edited.outcome).toBe('updated');
    expect(edited.entry).toMatchObject({
      start: null,
      status: 'going',
      pick: false,
      kind: 'pitch',
    });

    expect((await run('rm', entry.id)).code).toBe(0);
    expect(JSON.parse((await run('--all', '--json')).out)).toEqual([]);
  });

  it('refuses a bad flag before any request, naming the field', async () => {
    await expect(run('add', 'x', '--date', '2026-02-30', '--kind', 'event')).rejects.toThrow(
      /date/,
    );
    await expect(run('edit', 'nope', '--title', 'y')).rejects.toThrow(/no calendar entry "nope"/);
  });
});
