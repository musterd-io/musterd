import type { Envelope, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveConfig } from './client';
import { QuestionTriage } from './QuestionTriage';
import type { QuestionCard } from './questions';
import { WaitingOnYou } from './WaitingOnYou';

/** First-frame markup of the list and the triage card (static render, no DOM — the AsksStrip
 *  convention). The keys and the send path are pure, and tested in `triage.test.ts`. */
const cfg = { as: 'nick', team: 'revive' } as unknown as LiveConfig;
const roster = [{ name: 'ryder', kind: 'agent' }] as unknown as MemberSummary[];
const card = (id: string, text: string): QuestionCard => ({
  id,
  asker: 'ryder',
  to: 'nick',
  question: {
    text,
    why: 'CI is still running on the last push.',
    options: [
      { label: 'Merge now', consequence: 'Fastest; merges on its own if it passes' },
      { label: 'Wait for CI' },
    ],
    context: { lane: '01M674', pr: 3640, branch: 'feat/x' },
    blocking: false,
    audience: 'addressee',
    inferred: false,
  },
  askedAt: 0,
  waitedMs: 120_000,
  laneTitle: 'Seats ask 1e',
  undelivered: false,
  env: { id } as Envelope,
});
const ask = (id: string, text: string): Envelope =>
  ({
    v: 1,
    id,
    team: 'revive',
    from: 'ryder',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    ts: Date.now() - 120_000,
    body: text,
    thread: null,
    meta: { species: 'consult', tier: 'advisory', question: { text, blocking: false, audience: 'addressee', inferred: false } },
  }) as unknown as Envelope;
const props = (envelopes: Envelope[]) => ({ roster, cfg, envelopes });

describe('WaitingOnYou (seats ask 1e)', () => {
  it('lists each question with its seat, lane and wait, under a count and Answer all', () => {
    const html = renderToStaticMarkup(
      createElement(WaitingOnYou, props([ask('a', 'Merge now?'), ask('b', 'Rename it?'), ask('c', 'Ship?')])),
    );
    expect(html).toContain('Waiting on you <span class="wy__n">· 3</span>');
    expect(html).toContain('Merge now?');
    expect(html).toContain('ryder');
    expect(html).toContain('2m');
    expect(html).toMatch(/Answer all <kbd>(⌘K|Ctrl K)<\/kbd>/);
  });

  it('renders nothing with no questions', () => {
    expect(renderToStaticMarkup(createElement(WaitingOnYou, props([])))).toBe('');
  });

  it('the triage card shows the question, why, keyed options with consequences, and the reply box', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionTriage, {
        cards: [card('a', 'Merge now?')],
        roster,
        cfg,
        recent: () => [],
        onClose: () => {},
        onAnswered: () => {},
      }),
    );
    expect(html).toContain('1 of 1 waiting');
    expect(html).toContain('waiting · 2m');
    expect(html).toContain('Seats ask 1e · #3640 · feat/x');
    expect(html).toContain('Merge now?');
    expect(html).toContain('CI is still running');
    expect(html).toContain('<kbd class="qt__key">1</kbd>');
    expect(html).toContain('Fastest; merges on its own if it passes');
    expect(html).toContain('Or tell ryder something else…');
    expect(html).toContain('aria-modal="true"');
  });
});
