import { describe, expect, it } from 'vitest';
import type { CandidateReadResult } from './fullText.ts';
import { runTriage } from './triage.ts';
import type { RadarCandidate } from './types.ts';

const candidate = (id: string): RadarCandidate => ({
  source: 'arxiv',
  id,
  title: `Paper ${id}`,
  url: `https://example.org/${id}`,
  published: '2026-08-24',
  relatedExn: [],
  abstract: `abstract-${id}`,
});

const complete = (candidateId: string, evidence: string): CandidateReadResult => ({
  status: 'complete',
  candidateId,
  evidence,
  manifest: [
    {
      source: 'article',
      url: `https://example.org/${candidateId}`,
      characters: 20,
      chunks: 1,
      complete: true,
    },
  ],
});

const failed = (candidateId: string): CandidateReadResult => ({
  status: 'failed',
  candidateId,
  failure: 'article_retrieval',
  manifest: [
    {
      source: 'article',
      url: `https://example.org/${candidateId}`,
      characters: 0,
      chunks: 0,
      complete: false,
    },
  ],
});

describe('runTriage with complete-read results', () => {
  it('does not expose provider response bodies through failure warnings', async () => {
    const report = await runTriage({
      candidates: [candidate('a')],
      apiKey: 'test',
      promptBody: 'test',
      completeFn: async () => {
        throw new Error('private source text');
      },
    });
    expect(report.warnings.join(' ')).not.toContain('private source text');
    expect(report.warnings.join(' ')).toContain('tier-1 failed');
  });
  it('sends only successful full-text evidence through tier-1 and tier-2', async () => {
    const calls: Array<{ model: string; user: string }> = [];
    const completeFn = async (args: { model: string; messages: Array<{ content: string }> }) => {
      calls.push({ model: args.model, user: args.messages[0]!.content });
      if (calls.length === 1) {
        return {
          model: args.model,
          text: JSON.stringify([
            { id: 'good', keep: true, score: 0.9, reason: 'full text evidence' },
          ]),
        };
      }
      return {
        model: args.model,
        text: JSON.stringify([
          {
            id: 'good',
            score: 0.9,
            dimensions: { 'coordination-layer': 0.9 },
            one_line: 'A coordination result.',
            why_musterd: 'Peer coordination evidence.',
            gut_check: 'Small sample.',
            confidence: 0.8,
            verdict: 'record-as-evidence',
          },
        ]),
      };
    };

    const report = await runTriage({
      candidates: [candidate('good'), candidate('failed')],
      readResults: [complete('good', 'Derived full-text evidence.'), failed('failed')],
      apiKey: 'test-key',
      completeFn,
      promptBody: 'Pinned radar prompt.',
    });

    expect(report.candidates_in).toBe(1);
    expect(report.tier1.map(({ id }) => id)).toEqual(['good']);
    expect(report.tier2.map(({ id }) => id)).toEqual(['good']);
    expect(calls).toHaveLength(2);
    expect(calls.every(({ user }) => user.includes('Derived full-text evidence.'))).toBe(true);
    expect(calls.every(({ user }) => !user.includes('abstract-good'))).toBe(true);
    expect(calls.every(({ user }) => !user.includes('Paper failed'))).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/failed.*article_retrieval/);
  });

  it('keeps the existing summary-only triage path usable', async () => {
    const calls: string[] = [];
    const completeFn = async (args: { messages: Array<{ content: string }>; model: string }) => {
      calls.push(args.messages[0]!.content);
      return calls.length === 1
        ? {
            model: args.model,
            text: JSON.stringify([
              { id: 'summary', keep: false, score: 0.1, reason: 'summary only' },
            ]),
          }
        : { model: args.model, text: '[]' };
    };
    const report = await runTriage({
      candidates: [candidate('summary')],
      apiKey: 'test-key',
      completeFn,
      promptBody: 'Pinned radar prompt.',
    });
    expect(report.candidates_in).toBe(1);
    expect(calls[0]).toContain('abstract: abstract-summary');
  });
});
