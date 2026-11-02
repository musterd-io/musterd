import type { Envelope, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deriveAsks } from './asks';
import type { LiveConfig } from './client';
import { QuestionTriage } from './QuestionTriage';
import type { QuestionCard, WaitingItem } from './questions';
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
/** A plain approval routed to nick — the kind the rail used to keep (lane 01M6DBDSGH). */
const approval = (id: string, body: string, agoMs = 120_000): Envelope =>
  ({
    v: 1,
    id,
    team: 'revive',
    from: 'ryder',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    ts: Date.now() - agoMs,
    body,
    thread: null,
    meta: { species: 'approve', tier: 'standard' },
  }) as unknown as Envelope;
const props = (envelopes: Envelope[]) => ({ roster, cfg, envelopes });
const qItem = (c: QuestionCard): WaitingItem => ({
  kind: 'question',
  id: c.id,
  asker: c.asker,
  askedAt: c.askedAt,
  waitedMs: c.waitedMs,
  card: c,
});

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

  it('lists an approval routed to you beside the questions, oldest first, with its species (lane 01M6DBDSGH)', () => {
    const html = renderToStaticMarkup(
      createElement(WaitingOnYou, {
        ...props([ask('q', 'Merge now?'), approval('p', 'Deploy the site tip 6c900fd8?', 150_000)]),
        roster: [...roster, { name: 'nick', kind: 'human' } as unknown as MemberSummary],
      }),
    );
    expect(html).toContain('Waiting on you <span class="wy__n">· 2</span>');
    expect(html.indexOf('Deploy the site tip')).toBeLessThan(html.indexOf('Merge now?'));
    expect(html).toContain('wy__row--ask');
    expect(html).toContain('needs your approval');
  });

  it('keeps an ask addressed to someone else, or to the team, off the list', () => {
    const other = { ...approval('o', 'For izzo'), to: { kind: 'member', name: 'izzo' } } as Envelope;
    const team = { ...approval('t', 'For anyone'), to: { kind: 'team' } } as Envelope;
    expect(renderToStaticMarkup(createElement(WaitingOnYou, props([other, team])))).toBe('');
  });

  it('the triage card for an approval shows the body, the hold line, Approve/Deny and Deciding', () => {
    const env = approval('p', 'Deploy the site tip 6c900fd8?');
    const [view] = deriveAsks([env]);
    const html = renderToStaticMarkup(
      createElement(QuestionTriage, {
        items: [{ kind: 'ask', id: 'p', asker: 'ryder', askedAt: env.ts, waitedMs: 300_000, ask: view! }],
        roster,
        cfg,
        now: Date.now(),
        recent: () => [],
        onClose: () => {},
        onAnswered: () => {},
      }),
    );
    expect(html).toContain('qt__card--ask');
    expect(html).toContain('Deploy the site tip 6c900fd8?');
    expect(html).toContain('needs your approval');
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Deny<');
    expect(html).toContain('Deciding — 1h');
    expect(html).not.toContain('Or tell ryder');
  });

  it('renders nothing with no questions', () => {
    expect(renderToStaticMarkup(createElement(WaitingOnYou, props([])))).toBe('');
  });

  it('the triage card shows the question, why, keyed options with consequences, and the reply box', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionTriage, {
        items: [qItem(card('a', 'Merge now?'))],
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
