import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage, importsDir, listStages, newStageId, readStage, writeStage } from './stage.js';

describe('import stages', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-import-'));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const init = {
    team: 'dawn',
    project: 'demo',
    created_at: 0,
    source: { path: '/tmp/x.csv', sha256: 'ab', format: 'csv' as const },
    goals: [],
    lanes: [],
    linked_goals: [],
    diagnostics: [],
  };

  it('creates a stage and a .gitignore that ignores everything in the folder', () => {
    const s = createStage(
      ws,
      { ...init, created_at: Date.UTC(2026, 9, 10, 13, 5, 9) },
      Date.UTC(2026, 9, 10, 13, 5, 9),
    );
    expect(s.id).toMatch(/^20261010-130509-[0-9a-f]{4}$/);
    expect(readFileSync(join(importsDir(ws), '.gitignore'), 'utf8')).toBe('*\n');
    expect(readStage(ws, s.id)).toEqual({ ...s });
    expect(s.created).toEqual({});
    expect(s.saved_at).toBeNull();
  });

  it('round-trips an update atomically', () => {
    const s = createStage(ws, init, 1);
    writeStage(ws, { ...s, created: { 'goal:g': 'g' } });
    expect(readStage(ws, s.id).created).toEqual({ 'goal:g': 'g' });
    expect(existsSync(join(importsDir(ws), `${s.id}.json.tmp-${String(process.pid)}`))).toBe(false);
  });

  it('a stage written before trackers (no sync, csv) still reads', () => {
    const s = createStage(ws, init, 1);
    const raw = JSON.parse(readFileSync(join(importsDir(ws), `${s.id}.json`), 'utf8'));
    expect(raw).not.toHaveProperty('sync');
    expect(readStage(ws, s.id).source.format).toBe('csv');
  });

  it('a tracker stage with its sync round-trips', () => {
    const sync = {
      actions: [
        { kind: 'abandon' as const, lane_id: 'L1', ref: 'acme/app#9', from: 'Old', reason: 'closed in GitHub (acme/app#9)' },
      ],
      unchanged: 3,
    };
    const s = createStage(
      ws,
      { ...init, source: { path: 'github acme/app', sha256: 'cd', format: 'github' }, sync },
      1,
    );
    const back = readStage(ws, s.id);
    expect(back.source.format).toBe('github');
    expect(back.sync).toEqual(sync);
  });

  it('refuses a missing or malformed stage with a usage error', () => {
    expect(() => readStage(ws, 'nope')).toThrow(/no staged import "nope"/);
    createStage(ws, init, 1);
    writeFileSync(join(importsDir(ws), 'bad.json'), '{"version":9}');
    expect(() => readStage(ws, 'bad')).toThrow(/not a readable staged import/);
  });

  it('lists stages newest first and skips unreadable ones', () => {
    const a = createStage(ws, { ...init, created_at: 1 }, Date.UTC(2026, 0, 1));
    const b = createStage(ws, { ...init, created_at: 2 }, Date.UTC(2026, 0, 2));
    writeFileSync(join(importsDir(ws), 'junk.json'), 'not json');
    expect(listStages(ws).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('makes ids that sort by time', () => {
    expect(
      newStageId(Date.UTC(2026, 9, 10, 1, 2, 3)) < newStageId(Date.UTC(2026, 9, 10, 1, 2, 4)),
    ).toBe(true);
  });
});
