import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotDirFromOutput } from './backup.ts';
import { checkFreshness, snapshotStampMs } from './check.ts';
import { PART_BYTES, parseEnvText, partsFor, plannedObjects } from './upload.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

describe('corpus backup staleness (ADR 798)', () => {
  it('passes when both the snapshot and the upload are fresh', () => {
    expect(
      checkFreshness({
        snapshotDirs: ['2026-11-04T05-35-48-518Z'],
        lastUploadAt: '2026-11-04T06:00:00Z',
        now: NOW,
        maxAgeDays: 14,
      }),
    ).toEqual([]);
  });

  it('fails on the 2026-09-05 state that lapsed unnoticed for two months', () => {
    const problems = checkFreshness({
      snapshotDirs: ['2026-09-05T15-41-03-562Z'],
      lastUploadAt: '2026-09-05T16:00:00Z',
      now: NOW,
      maxAgeDays: 14,
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('d old');
  });

  it('fails when there is no upload record at all', () => {
    const problems = checkFreshness({
      snapshotDirs: ['2026-11-04T05-35-48-518Z'],
      lastUploadAt: null,
      now: NOW,
      maxAgeDays: 14,
    });
    expect(problems).toEqual(['no verified off-machine upload on record (LAST.json missing)']);
  });

  it('parses a snapshot stamp and rejects other names', () => {
    expect(snapshotStampMs('2026-11-04T05-35-48-518Z')).toBe(Date.UTC(2026, 10, 4, 5, 35, 48));
    expect(snapshotStampMs('README')).toBeNull();
  });
});

describe('upload planning', () => {
  it('puts MANIFEST.json last so its presence means the upload completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-plan-'));
    writeFileSync(join(dir, 'MANIFEST.json'), '{}');
    writeFileSync(join(dir, 'a.db.gz'), 'x');
    const plan = plannedObjects(dir);
    expect(plan[plan.length - 1]?.name).toBe('MANIFEST.json');
    expect(plan[0]?.key).toContain('research-corpus/');
  });

  it('splits an artifact over the bucket object cap into ordered parts', () => {
    const parts = partsFor('trace.db.db.gz', PART_BYTES * 2 + 10);
    expect(parts.map((p) => p.remoteName)).toEqual([
      'trace.db.db.gz.part-000',
      'trace.db.db.gz.part-001',
      'trace.db.db.gz.part-002',
    ]);
    expect(parts.map((p) => p.bytes)).toEqual([PART_BYTES, PART_BYTES, 10]);
    expect(partsFor('small.gz', 5)).toEqual([{ remoteName: 'small.gz', offset: 0, bytes: 5 }]);
  });

  it('parses the env file without keeping quotes', () => {
    expect(parseEnvText('CORPUS_BACKUP_URL="https://x.example"\nOTHER=1\n')).toEqual({
      CORPUS_BACKUP_URL: 'https://x.example',
      OTHER: '1',
    });
  });
});

describe('backup orchestration', () => {
  it('reads the snapshot directory out of snapshot.ts output', () => {
    const out =
      '35 artifacts\n/Users/nick/.musterd/corpus-snapshots/2026-11-04T05-35-48-518Z\n\ndone\n';
    expect(snapshotDirFromOutput(out)).toBe(
      '/Users/nick/.musterd/corpus-snapshots/2026-11-04T05-35-48-518Z',
    );
    expect(snapshotDirFromOutput('nothing here')).toBeNull();
  });
});
