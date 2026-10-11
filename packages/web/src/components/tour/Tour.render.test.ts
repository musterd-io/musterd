import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TourPanel } from './Tour';
import { initialState, type TourState } from './tourMachine';

const LANE = '01M4M4DDYFFX7FFD5YVRAQ1C50';
const noop = () => {};
const vars = { you: 'nick', agent: 'dolly', lane: LANE, model: 'claude-opus-5-5' };
const panel = (s: TourState, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TourPanel, {
      s,
      vars: { ...vars, agent: s.agent },
      hint: null,
      agents: ['dolly'],
      detail: '',
      note: null,
      busy: false,
      error: null,
      onPick: noop,
      onContinue: noop,
      onSkip: noop,
      onToNext: noop,
      onDone: noop,
      onStop: noop,
      onNote: noop,
      onVerdict: noop,
      ...over,
    }),
  );
const at = (step: TourState['step'], over: Partial<TourState> = {}): TourState => ({
  ...initialState('nick', 'dolly'),
  step,
  laneId: LANE,
  ...over,
});

describe('TourPanel — spec docs/design/tour-web-copy.md §3', () => {
  it('opens on what musterd is, with Continue and Stop', () => {
    const html = panel(initialState('nick', 'dolly'));
    expect(html).toContain('Step 1 of 9 · What musterd is');
    expect(html).toContain('<p>musterd makes your agents accountable.</p>');
    expect(html).toContain('In the next few minutes you give dolly a small piece of work');
    expect(html).toContain('>Continue<');
    expect(html).toContain('>Stop<');
  });

  it('asks which agent before naming one, when there are several', () => {
    const html = panel(initialState('nick', ''), { agents: ['dolly', 'ghost'] });
    expect(html).toContain('Which agent should take the tour lane?');
    expect(html).toContain('>dolly<');
    expect(html).toContain('>ghost<');
    expect(html).not.toContain('{agent}');
    expect(html).not.toContain('>Continue<');
  });

  it('shows the latest due hint while it waits on the claim', () => {
    const html = panel(at('claims'), { hint: 'Still waiting.' });
    expect(html).toContain(`The tour has asked dolly to claim lane ${LANE}.`);
    expect(html).toContain('Still waiting.');
  });

  it('while it waits, shows the clock, what the roster says and what the agent said', () => {
    const html = panel(at('claims'), {
      wait: { elapsed: '0:32', now: 'dolly is online and has the request.', said: 'on it' },
    });
    expect(html).toContain('Waiting on dolly');
    expect(html).toMatch(/aria-hidden="true">0:32</);
    expect(html).toContain('dolly is online and has the request.');
    expect(html).toContain('dolly says: <q>on it</q>');
    expect(panel(at('claims'))).not.toContain('Waiting on');
  });

  it('shows what the agent wrote as text, never as markup, with both verdicts', () => {
    const html = panel(at('judge', { askId: 'ask1' }), { detail: '<b>three</b>\nlines' });
    expect(html).toContain('&lt;b&gt;three&lt;/b&gt;');
    expect(html).toContain('>Accept it<');
    expect(html).toContain('>Send it back with a note<');
  });

  it('says so when the lane has no summary yet, and the note field is required', () => {
    expect(panel(at('judge', { askId: 'ask1' }))).toContain('The lane has no summary yet.');
    const note = panel(at('judge', { askId: 'ask1' }), { note: '' });
    expect(note).toContain('What should change?');
    expect(note).toMatch(/<textarea[^>]*required/);
    expect(note).toContain('>Send it back<');
  });

  it('after a send-back, says it went back to the agent', () => {
    expect(panel(at('hands_back', { sentBack: 1 }))).toContain(
      'Sent back to dolly with your note. It will submit again.',
    );
  });

  it('on a decline, quotes the reason and offers the record or a stop', () => {
    const html = panel(at('claims', { outcome: 'declined', declineReason: 'not today' }));
    expect(html).toContain(`dolly said no to lane ${LANE}:`);
    expect(html).toContain('not today');
    expect(html).toContain('>See the record<');
    expect(html).toContain('>Stop here<');
  });

  it('reads the record and when to add a seat as one screen, without Stop', () => {
    const html = panel(at('record', { outcome: 'accepted' }));
    expect(html).toContain(
      'opened by nick · claimed by dolly · model claude-opus-5-5 · accepted by nick',
    );
    expect(html).toContain('Step 8 of 9 · When to add a seat');
    expect(html).toContain('<li>More capacity:');
    expect(html).not.toContain('>Stop<');
  });

  it('says a self-close before the record', () => {
    expect(panel(at('record', { outcome: 'self_closed' }))).toContain(
      `dolly closed lane ${LANE} itself before you judged it.`,
    );
  });

  it('sets the next steps as commands, and ends on Done', () => {
    const html = panel(at('next'));
    expect(html).toContain('<code class="tour__cmd">musterd board');
    expect(html).toContain('>Done<');
  });
});
