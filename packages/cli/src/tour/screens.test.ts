import { describe, expect, it } from 'vitest';
import { initialState, type TourState } from './machine.js';
import {
  hintFor,
  printable,
  rosterLines,
  stepBody,
  stepTitle,
  verdictLine,
  wrapBody,
} from './screens.js';

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
        'ada is running claude-opus-5-5. The tool ada runs in reports that name, so an agent cannot claim to be a model it is not.',
      ].join('\n'),
    );
  });

  it('cmd/tour · team roster: you, then the agent', () => {
    const roster = [
      { name: 'nick', kind: 'human' },
      { name: 'ada', kind: 'agent', model: 'claude-opus-5-5' },
      { name: 'bo', kind: 'agent' },
      { name: 'cy', kind: 'human' },
    ];
    expect(rosterLines(roster, 'nick', 'ada')).toEqual([
      '  nick  human, you',
      '  ada   agent',
      '  and 2 more members',
    ]);
    expect(rosterLines([roster[0]!, roster[2]!], 'nick', 'bo')).toEqual([
      '  nick  human, you',
      '  bo    agent',
    ]);
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

describe('wrapBody', () => {
  it('leaves lines that fit untouched, spacing included', () => {
    const body = 'musterd board          the board\n  More capacity: short';
    expect(wrapBody(body, 80)).toBe(body);
  });

  it('wraps a long line at word boundaries, keeping its indent', () => {
    expect(wrapBody('one two three four five', 10)).toBe('one two\nthree four\nfive');
    expect(wrapBody('  aa bb cc dd', 8)).toBe('  aa bb\n  cc dd');
  });

  it('never returns a line wider than the width when words fit', () => {
    const long = stepBody(at('what'), v);
    for (const line of wrapBody(long, 74).split('\n')) expect(line.length).toBeLessThanOrEqual(74);
  });
});

describe('printable', () => {
  it('keeps newlines and tabs, drops every other control character', () => {
    expect(printable('a\tb\nc\x1b[31md\x07\x9be\r')).toBe('a\tb\nc[31mde');
  });
});
