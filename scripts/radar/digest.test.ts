import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitRadarArtifacts, emitDigest, isoWeek, renderDigest } from './digest.ts';
import { parseArgs } from './sweep.ts';
import type { SweepReport } from './types.ts';

const dirs: string[] = [];
function tempRadarDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'radar-digest-test-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ arxiv: [], hf: [] }, null, 2));
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function report(): SweepReport {
  return {
    generated: '2026-08-24T16:00:00.000Z',
    since_days: 14,
    candidates_fetched: 12,
    already_seen: 3,
    new_count: 9,
    printed: 9,
    truncated: false,
    new: [
      {
        source: 'arxiv',
        id: '2608.01001',
        title: 'P1',
        url: 'https://x/1',
        published: '2026-08-20',
        relatedExn: [{ episodeId: 'episode-p1' }],
      },
      {
        source: 'hf',
        id: '2608.01002',
        title: 'P2',
        url: 'https://x/2',
        published: '2026-08-21',
        relatedExn: [],
      },
      {
        source: 'arxiv',
        id: '2608.01003',
        title: 'P3',
        url: 'https://x/3',
        published: '2026-08-22',
        relatedExn: [],
      },
    ],
    warnings: [],
    triage: {
      prompt_version: 'radar-v1',
      tier1_model: 'claude-haiku-4-5',
      tier2_model: 'claude-sonnet-5',
      relevance_floor: 0.55,
      candidates_in: 3,
      shortlisted: 2,
      shortlist_truncated: false,
      tier1: [
        { id: '2608.01001', keep: true, score: 0.9, reason: 'on-thesis' },
        { id: '2608.01002', keep: true, score: 0.8, reason: 'adjacent' },
        { id: '2608.01003', keep: false, score: 0.2, reason: 'off-topic' },
      ],
      surfaced: [
        {
          id: '2608.01001',
          title: 'P1',
          url: 'https://x/1',
          score: 0.91,
          dimensions: { 'coordination-layer': 0.9 },
          one_line: 'Peer coordination result.',
          why_musterd: 'Touches ADR 314.',
          gut_check: 'Real result, small N.',
          confidence: 0.8,
          verdict: 'consider-ADR',
        },
        {
          id: '2608.01002',
          title: 'P2',
          url: 'https://x/2',
          score: 0.62,
          dimensions: { 'human-agent-loop': 0.7 },
          one_line: 'HITL eval harness.',
          why_musterd: 'Evidence for reachability.',
          gut_check: 'Repackages known ideas.',
          confidence: 0.6,
          verdict: 'record-as-evidence',
        },
      ],
      tier2: [],
      warnings: [],
    },
  };
}

describe('isoWeek', () => {
  it('computes the ISO week, including the year-boundary edge', () => {
    expect(isoWeek('2026-01-01')).toBe('2026-W01'); // Thursday — belongs to W01 of its own year
    expect(isoWeek('2024-12-30')).toBe('2025-W01'); // Monday — belongs to next year's W01
    expect(isoWeek('2026-08-24')).toBe('2026-W35');
  });
});

describe('renderDigest', () => {
  it('renders frontmatter with week, models, prompt version, and counts', () => {
    const md = renderDigest(report());
    expect(md).toContain('week: 2026-W35');
    expect(md).toContain('generated: 2026-08-24');
    expect(md).toContain('prompt_version: radar-v1');
    expect(md).toContain('tier1_model: claude-haiku-4-5');
    expect(md).toContain('tier2_model: claude-sonnet-5');
    expect(md).toContain('candidates_seen: 9');
    expect(md).toContain('shortlisted: 2');
  });

  it('groups surfaced papers by verdict, consider-ADR first, with the entry fields', () => {
    const md = renderDigest(report());
    const adr = md.indexOf('## consider-ADR');
    const evidence = md.indexOf('## record-as-evidence');
    expect(adr).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(adr);
    expect(md).toContain('[P1](https://x/1)');
    expect(md).toContain('Peer coordination result.');
    expect(md).toContain('Touches ADR 314.');
    expect(md).toContain('Real result, small N.');
  });

  it('refuses a report without triage — a digest is a triage artifact', () => {
    const r = report();
    delete r.triage;
    expect(() => renderDigest(r)).toThrow(/triage/);
  });

  it('does not render source bodies carried in feed metadata', () => {
    const r = report();
    r.new[0]!.abstract = 'RAW ARTICLE BODY: private source text';
    expect(renderDigest(r)).not.toContain('RAW ARTICLE BODY');
  });
});

describe('emitDigest', () => {
  it('preserves the existing digest and ledger when explicitly resuming an unreviewed draft', () => {
    const dir = tempRadarDir();
    emitDigest(report(), dir);
    const previous = readFileSync(join(dir, '2026-W35.md'), 'utf8');
    const retry = report();
    retry.new = [{ ...retry.new[0]!, id: 'retry' }];
    retry.triage!.tier1 = [];
    emitDigest(retry, dir, [], true);
    expect(readFileSync(join(dir, '2026-W35.md'), 'utf8')).toContain(previous);
    const ledger = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(ledger.arxiv).toContain('2608.01001');
    expect(ledger.pending[0].canonicalId).toBe('retry');
  });
  it('keeps omitted model results pending while preserving successful tier-1 drops', () => {
    const r = report();
    r.triage!.tier1[1] = { id: '2608.01002', keep: false, score: 0, reason: 'tier-1 omitted' };
    r.triage!.tier2 = [];
    r.triage!.surfaced = [];
    r.triage!.warnings = ['tier-2 failed: provider_error'];
    const dir = tempRadarDir();
    emitDigest(r, dir);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.arxiv).toEqual(['2608.01003']);
    expect(seen.hf).toEqual([]);
    expect(seen.pending.map((p: { canonicalId: string }) => p.canonicalId)).toEqual([
      '2608.01001',
      '2608.01002',
    ]);
  });
  it('writes the weekly digest file and appends every triaged candidate to seen.json', () => {
    const dir = tempRadarDir();
    const out = emitDigest(report(), dir);
    expect(out.digestPath).toBe(join(dir, '2026-W35.md'));
    expect(readFileSync(out.digestPath, 'utf8')).toContain('week: 2026-W35');
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.arxiv).toEqual(['2608.01001', '2608.01003']);
    expect(seen.hf).toEqual(['2608.01002']);
    expect(seen.exn).toEqual(['episode-p1']);
    expect(seen.pending).toEqual([]);
  });

  it('preserves ids already in the ledger and never duplicates', () => {
    const dir = tempRadarDir();
    writeFileSync(
      join(dir, 'seen.json'),
      JSON.stringify({ arxiv: ['old.1', '2608.01001'], hf: [] }, null, 2),
    );
    emitDigest(report(), dir);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.arxiv).toEqual(['old.1', '2608.01001', '2608.01003']);
  });

  it('keeps failed full-text candidates pending and preserves their first attempt date', () => {
    const dir = tempRadarDir();
    writeFileSync(
      join(dir, 'seen.json'),
      JSON.stringify({
        arxiv: [],
        hf: [],
        exn: [],
        pending: [
          {
            sourceIds: [
              { source: 'arxiv', id: '2608.01001' },
              { source: 'exn', id: 'episode-p1' },
            ],
            canonicalId: '2608.01001',
            title: 'P1',
            url: 'https://x/1',
            published: '2026-08-20',
            episodeIds: ['episode-p1'],
            firstAttempt: '2026-08-01',
            lastAttempt: '2026-08-10',
            failure: 'article_retrieval',
          },
        ],
      }),
    );

    const result = emitDigest(report(), dir, [
      { candidateId: '2608.01001', failure: 'article_retrieval' },
    ]);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(result.pending).toBe(1);
    expect(seen.pending[0]).toMatchObject({
      canonicalId: '2608.01001',
      firstAttempt: '2026-08-01',
      lastAttempt: '2026-08-24',
      failure: 'article_retrieval',
    });
    expect(seen.arxiv).not.toContain('2608.01001');
    expect(seen.exn).not.toContain('episode-p1');
  });

  it('clears a successful pending retry after recording its canonical and episode IDs', () => {
    const dir = tempRadarDir();
    writeFileSync(
      join(dir, 'seen.json'),
      JSON.stringify({
        arxiv: [],
        hf: [],
        exn: [],
        pending: [
          {
            sourceIds: [
              { source: 'arxiv', id: '2608.01001' },
              { source: 'exn', id: 'episode-p1' },
            ],
            canonicalId: '2608.01001',
            title: 'P1',
            url: 'https://x/1',
            published: '2026-08-20',
            episodeIds: ['episode-p1'],
            firstAttempt: '2026-08-01',
            lastAttempt: '2026-08-10',
            failure: 'article_retrieval',
          },
        ],
      }),
    );

    const result = emitDigest(report(), dir);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(result.pending).toBe(0);
    expect(seen.pending).toEqual([]);
    expect(seen.arxiv).toContain('2608.01001');
    expect(seen.exn).toContain('episode-p1');
  });

  it('refuses to overwrite an existing digest for the same week', () => {
    const dir = tempRadarDir();
    emitDigest(report(), dir);
    expect(() => emitDigest(report(), dir)).toThrow(/already exists/);
  });

  it('creates the radar dir if missing rather than failing on a fresh checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-digest-test-'));
    dirs.push(dir);
    const sub = join(dir, 'radar');
    const out = emitDigest(report(), sub);
    expect(existsSync(out.digestPath)).toBe(true);
  });

  it('preserves the prior digest and ledger when the second artifact replacement fails', () => {
    const dir = tempRadarDir();
    const digestPath = join(dir, '2026-W35.md');
    const seenPath = join(dir, 'seen.json');
    writeFileSync(digestPath, 'previous digest');
    writeFileSync(seenPath, '{"arxiv":["old"],"hf":[],"exn":[]}\n');
    let renames = 0;
    const replace = (
      from: Parameters<typeof renameSync>[0],
      to: Parameters<typeof renameSync>[1],
    ) => {
      renames += 1;
      if (renames === 2) throw new Error('simulated replacement failure');
      renameSync(from, to);
    };

    expect(() =>
      commitRadarArtifacts(
        digestPath,
        seenPath,
        'new digest',
        { arxiv: [], hf: [], exn: [] },
        replace,
      ),
    ).toThrow(/simulated replacement failure/);
    expect(readFileSync(digestPath, 'utf8')).toBe('previous digest');
    expect(readFileSync(seenPath, 'utf8')).toBe('{"arxiv":["old"],"hf":[],"exn":[]}\n');
  });

  it('preserves both prior artifacts when the first replacement fails', () => {
    const dir = tempRadarDir();
    const digestPath = join(dir, '2026-W35.md');
    const seenPath = join(dir, 'seen.json');
    writeFileSync(digestPath, 'previous digest');
    writeFileSync(seenPath, '{"arxiv":["old"],"hf":[],"exn":[]}\n');
    const replace: typeof renameSync = () => {
      throw new Error('simulated first replacement failure');
    };

    expect(() =>
      commitRadarArtifacts(
        digestPath,
        seenPath,
        'new digest',
        { arxiv: [], hf: [], exn: [] },
        replace,
      ),
    ).toThrow(/simulated first replacement failure/);
    expect(readFileSync(digestPath, 'utf8')).toBe('previous digest');
    expect(readFileSync(seenPath, 'utf8')).toBe('{"arxiv":["old"],"hf":[],"exn":[]}\n');
  });
});

describe('parseArgs --emit', () => {
  it('accepts --emit only together with --triage', () => {
    expect(parseArgs(['--triage', '--emit']).emit).toBe(true);
    expect(() => parseArgs(['--emit'])).toThrow(/--triage/);
  });

  it('defaults to print-only', () => {
    expect(parseArgs([]).emit).toBe(false);
  });
});
