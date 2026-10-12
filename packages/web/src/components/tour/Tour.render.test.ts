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
      picks: [{ name: 'dolly', readiness: 'ready' }],
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
    const html = panel(initialState('nick', ''), {
      picks: [
        { name: 'ghost', readiness: 'asleep' },
        { name: 'dolly', readiness: 'ready' },
      ],
      suggested: 'dolly',
    });
    expect(html).toContain('Which agent should take the tour lane?');
    expect(html).toContain('>ghost<');
    expect(html).toContain('asleep · ~1 min to wake');
    // The suggestion is the readiest agent, and Enter takes it.
    expect(html).toMatch(/is-suggested" data-primary="">.*?>dolly</);
    expect(html).toContain('Suggested · online · ready now');
    expect(html).not.toContain('{agent}');
    expect(html).not.toContain('>Continue<');
  });

  it('shows the latest due hint while it waits on the claim', () => {
    const html = panel(at('claims'), { hint: 'Still waiting.' });
    expect(html).toContain(`The tour has asked dolly to claim lane ${LANE}.`);
    expect(html).toContain('Still waiting.');
  });

  it('while it waits, shows the clock and what the roster says', () => {
    const html = panel(at('claims'), {
      wait: { elapsed: '0:32', now: 'dolly is online and has the request.' },
    });
    expect(html).toContain('Waiting on dolly');
    expect(html).toMatch(/aria-hidden="true">0:32</);
    expect(html).toContain('dolly is online and has the request.');
    expect(panel(at('claims'))).not.toContain('Waiting on');
  });

  it('lights the rail up to the current step', () => {
    const html = panel(at('hands_back'));
    expect(html.match(/class="is-done"/g)).toHaveLength(4);
    expect(html).toContain('class="is-now"');
  });

  it('shows the lane ticket with its track and story, and stamps an accept', () => {
    const ticket = {
      title: "[tour] nick: summarise this repo's README in three lines",
      stage: 2,
      entries: [{ id: 'c', ts: 0, text: 'dolly claimed it' }],
    };
    const html = panel(at('hands_back'), { ticket });
    expect(html).toContain('01M4M4DDYF');
    expect(html).toContain('owner dolly');
    expect(html.match(/tour-track__stop is-done/g)).toHaveLength(2);
    expect(html).toContain('tour-track__stop is-next');
    expect(html).toContain('dolly claimed it');
    expect(html).not.toContain('tour-ticket__stamp');
    const won = panel(at('record', { outcome: 'accepted' }), { ticket: { ...ticket, stage: 4 } });
    expect(won).toContain('Accepted · nick');
    expect(won).toContain('tour-confetti');
    expect(won).toContain('tour--won');
  });

  it('marks a declined request on the claim stop', () => {
    const html = panel(at('claims', { outcome: 'declined', declineReason: 'no' }), {
      ticket: { title: 't', stage: 1, entries: [] },
    });
    expect(html).toContain('tour-track__stop is-failed');
    expect(html).toContain('Declined');
  });

  it('marks the main action so Enter can take it', () => {
    expect(panel(initialState('nick', 'dolly'))).toMatch(/data-primary="">Continue</);
    expect(panel(at('next'))).toMatch(/data-primary="">Done</);
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
