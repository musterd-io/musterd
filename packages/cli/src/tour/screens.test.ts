import { describe, expect, it } from 'vitest';
import { initialState, type TourState } from './machine.js';
import { hintFor, stepBody, stepTitle, verdictLine } from './screens.js';

const v = { you: 'nick', agent: 'ada', lane: '01M4TOUR01', model: 'claude-opus-5-5' };
const at = (step: TourState['step'], extra: Partial<TourState> = {}): TourState => ({
  ...initialState('nick', 'ada'),
  step,
  laneId: v.lane,
  ...extra,
});

// The cmd/tour frames in docs/design/figma-brief-terminal.md are pinned here (AGENTS.md hard rule 2).
describe('cmd/tour frames', () => {
  it('cmd/tour · title', () => {
    expect(stepTitle('give_work')).toBe('Step 3 of 9 · Give it work');
    expect(stepTitle('next')).toBe('Step 9 of 9 · Where to go next');
  });

  it('cmd/tour · team', () => {
    expect(stepBody(at('team'), v)).toBe(
      [
        'This is your roster. You and ada are both members, each with a name that stays.',
        'ada is running claude-opus-5-5. The harness reports the model; the agent does not choose what it says.',
      ].join('\n'),
    );
  });

  it('cmd/tour · team, model unattested: the model line drops', () => {
    expect(stepBody(at('team'), { ...v, model: '' })).toBe(
      'This is your roster. You and ada are both members, each with a name that stays.',
    );
  });

  it('cmd/tour · record (accepted)', () => {
    expect(stepBody(at('record', { outcome: 'accepted' }), v)).toBe(
      [
        'This is the chain the team keeps for lane 01M4TOUR01:',
        'opened by nick · claimed by ada · model claude-opus-5-5 · accepted by nick',
        'Every lane on the team carries the same chain, whoever does the work.',
      ].join('\n'),
    );
  });

  it('cmd/tour · record, model unattested', () => {
    expect(stepBody(at('record', { outcome: 'accepted' }), { ...v, model: '' })).toContain(
      'opened by nick · claimed by ada · model unattested · accepted by nick',
    );
  });

  it('verdict lines', () => {
    expect(verdictLine(at('record', { outcome: 'accepted', sentBack: 1 }), 'nick')).toBe(
      'sent back by nick, then accepted by nick',
    );
    expect(verdictLine(at('record', { outcome: 'self_closed' }), 'nick')).toBe(
      'closed by ada itself',
    );
    expect(verdictLine(at('record', { outcome: 'declined' }), 'nick')).toBe('declined by ada');
  });

  it('cmd/tour · hints arrive at 60s and 3m on claims', () => {
    expect(hintFor('claims', 59_000, v)).toBeNull();
    expect(hintFor('claims', 61_000, v)).toBe(
      "Still waiting. Switch to ada's window and say: check your inbox.",
    );
    expect(hintFor('claims', 181_000, v)).toMatch(/^ada can take a few minutes to wake\./);
  });
});
