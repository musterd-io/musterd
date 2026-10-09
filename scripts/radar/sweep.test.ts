import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, runSweep } from './sweep.ts';
import type { PendingCandidate } from './types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('parseArgs full-text sweep flags', () => {
  it('requires triage for full-text reads and accepts an explicit retry limit', () => {
    expect(parseArgs(['--full-text', '--triage', '--retry-limit', '50'])).toMatchObject({
      fullText: true,
      triage: true,
      retryLimit: 50,
    });
    expect(() => parseArgs(['--full-text'])).toThrow(/--triage/);
  });

  it('rejects invalid retry limits', () => {
    expect(() => parseArgs(['--retry-limit', '0'])).toThrow(/--retry-limit/);
  });

  it('retries old pending candidates through full-text reads outside the feed window', async () => {
    vi.stubEnv('EXA_API_KEY', 'exa-test');
    vi.stubEnv('EXPLORING_API_KEY', 'exn-test');
    const dir = mkdtempSync(join(tmpdir(), 'radar-sweep-test-'));
    dirs.push(dir);
    const seenFile = join(dir, 'seen.json');
    const pending: PendingCandidate = {
      sourceIds: [
        { source: 'arxiv', id: '2401.00001' },
        { source: 'exn', id: 'episode-old' },
      ],
      canonicalId: '2401.00001',
      title: 'Old multi-agent coordination paper',
      url: 'https://example.org/old-paper',
      published: '2020-01-01',
      episodeIds: ['episode-old'],
      firstAttempt: '2020-01-02',
      lastAttempt: '2020-01-02',
      failure: 'article_retrieval',
    };
    writeFileSync(seenFile, JSON.stringify({ arxiv: [], hf: [], exn: [], pending: [pending] }));
    const fetchFn = async (url: string) => {
      if (url.startsWith('https://export.arxiv.org/')) return new Response('<feed></feed>');
      if (url.startsWith('https://huggingface.co/')) return new Response('[]');
      if (url.startsWith('https://ingest.sandrise.io/feed')) return new Response('{"items":[]}');
      if (url === 'https://api.exa.ai/contents') {
        return new Response(
          JSON.stringify({
            results: [{ url: 'https://example.org/old-paper', text: 'Complete article body.' }],
            statuses: [{ id: 'https://example.org/old-paper', status: 'success' }],
          }),
        );
      }
      if (url.includes('/episode-old/script')) {
        return new Response(
          JSON.stringify({ segments: [{ speaker: 'Ava', text: 'Full script.' }] }),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const completeFn = async (args: {
      system: string;
      messages: Array<{ content: string }>;
      model: string;
    }) => {
      if (args.system.includes('Extract concise factual claims')) {
        return { model: args.model, text: '{"claims":["The paper studies agent coordination."]}' };
      }
      return {
        model: args.model,
        text: JSON.stringify([{ id: '2401.00001', keep: false, score: 0.1, reason: 'off thesis' }]),
      };
    };

    const report = await runSweep({
      ...parseArgs(['--full-text', '--triage', '--since', '1']),
      seenFile,
      apiKey: 'anthropic-test',
      fetchFn,
      completeFn,
      promptBody: 'test prompt',
    });

    expect(report.new.map(({ id }) => id)).toEqual(['2401.00001']);
    expect(report.triage?.candidates_in).toBe(1);
    expect(report.triage?.tier1[0]?.id).toBe('2401.00001');
  });
});
