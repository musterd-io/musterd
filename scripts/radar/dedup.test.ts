import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSeen, mergeCandidates, partitionRadarCandidates } from './dedup.ts';
import type { PendingCandidate, RadarCandidate } from './types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const candidate = (id: string, published = '2026-10-09'): RadarCandidate => ({
  source: 'arxiv',
  id,
  title: `Paper ${id}`,
  url: `https://example.org/${id}`,
  published,
  relatedExn: [],
});

const pending = (id: string, firstAttempt: string): PendingCandidate => ({
  sourceIds: [{ source: 'arxiv', id }],
  canonicalId: id,
  title: `Paper ${id}`,
  url: `https://example.org/${id}`,
  published: '2020-01-01',
  episodeIds: ['episode-1'],
  firstAttempt,
  lastAttempt: firstAttempt,
  failure: 'article_retrieval',
});

describe('loadSeen', () => {
  it('reads legacy ledgers without pending as an empty retry list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-ledger-test-'));
    dirs.push(dir);
    const file = join(dir, 'seen.json');
    writeFileSync(file, JSON.stringify({ arxiv: ['a'], hf: [], exn: [] }));
    expect(loadSeen(file).pending ?? []).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('pending');
  });
});

describe('partitionRadarCandidates', () => {
  it('excludes every pending ID before capping the genuinely fresh batch', () => {
    const backlog = Array.from({ length: 100 }, (_, i) => pending(`p${i}`, '2026-10-01'));
    const feed = [...backlog.map((p) => candidate(p.canonicalId)), candidate('fresh')];
    const result = partitionRadarCandidates(
      feed,
      { arxiv: [], hf: [], exn: [], pending: backlog },
      50,
    );
    expect(result.ready.filter(({ id }) => id.startsWith('p'))).toHaveLength(50);
    expect(result.ready.some(({ id }) => id === 'fresh')).toBe(true);
  });
  it('retries candidates older than the feed window, oldest first, and keeps the backlog deferred', () => {
    const seen = {
      arxiv: [],
      hf: [],
      exn: [],
      pending: [pending('newer', '2026-10-08'), pending('older', '2026-10-01')],
    };
    const result = partitionRadarCandidates([], seen, 1);
    expect(result.ready.map(({ id }) => id)).toEqual(['older']);
    expect(result.ready[0]?.published).toBe('2020-01-01');
    expect(result.ready[0]?.relatedExn).toEqual([{ episodeId: 'episode-1' }]);
    expect(result.deferred.map(({ canonicalId }) => canonicalId)).toEqual(['newer']);
    expect(result.truncated).toBe(true);
  });

  it('caps retries and fresh candidates independently at 50', () => {
    const backlog = Array.from({ length: 51 }, (_, index) =>
      pending(`p${index}`, `2026-09-${String(index + 1).padStart(2, '0')}`),
    );
    const fresh = Array.from({ length: 51 }, (_, index) => candidate(`f${index}`));
    const result = partitionRadarCandidates(
      fresh,
      { arxiv: [], hf: [], exn: [], pending: backlog },
      50,
    );
    expect(result.ready).toHaveLength(100);
    expect(result.ready.filter(({ id }) => id.startsWith('p'))).toHaveLength(50);
    expect(result.ready.filter(({ id }) => id.startsWith('f'))).toHaveLength(50);
    expect(result.deferred).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('merges attached episode IDs when an arXiv row replaces an HF duplicate', () => {
    const merged = mergeCandidates([
      [{ ...candidate('2601.00001'), source: 'hf' }],
      [{ ...candidate('2601.00001'), relatedExn: [{ episodeId: 'episode-1' }] }],
    ]);
    expect(merged[0]?.source).toBe('arxiv');
    expect(merged[0]?.relatedExn).toEqual([{ episodeId: 'episode-1' }]);
  });
});
