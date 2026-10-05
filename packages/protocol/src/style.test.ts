import { describe, expect, it } from 'vitest';
import {
  STYLE_PROSE_MAX_LINES,
  StylePolicyOverrideSchema,
  StylePolicySchema,
  StylePrefsSchema,
  resolveStyle,
  styleEpoch,
  styleProseLineCount,
  styleProseProblem,
} from './style.js';

const shipped = StylePolicySchema.parse({});

describe('StylePolicySchema — shipped defaults (spec §4.1)', () => {
  it('parse({}) is the shipped floor, defaults and empty prose', () => {
    expect(StylePolicySchema.parse({})).toEqual({
      floor: {
        assess_before_agreeing: true,
        disagree_once_then_commit: true,
        concession_names_check: true,
        human_critique_weighed_as_peer: true,
      },
      defaults: { pushback: 'when-it-matters', bluntness: 'plain', length: 'normal', format: 'prose' },
      prose: '',
    });
  });
  it('an admin may turn one floor boolean off and the other three stay on', () => {
    const p = StylePolicySchema.parse({ floor: { assess_before_agreeing: false } });
    expect(p.floor.assess_before_agreeing).toBe(false);
    expect(p.floor.disagree_once_then_commit).toBe(true);
  });
  it('an unknown dial value is refused', () => {
    expect(() => StylePolicySchema.parse({ defaults: { length: 'terse' } })).toThrow();
  });
});

describe('StylePolicyOverrideSchema — sparse (ADR 185)', () => {
  it('keeps only what was written, at every level', () => {
    expect(StylePolicyOverrideSchema.parse({ floor: { concession_names_check: false } })).toEqual({
      floor: { concession_names_check: false },
    });
  });
});

describe("StylePrefsSchema — a human's own dials", () => {
  it('parse({}) is empty: every dial falls to the team default', () => {
    expect(StylePrefsSchema.parse({})).toEqual({});
  });
  it('refuses a key that is not a dial (the floor is not a preference)', () => {
    expect(() => StylePrefsSchema.parse({ assess_before_agreeing: false })).toThrow();
  });
  it('accepts prose of exactly the cap', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(StylePrefsSchema.parse({ prose: five }).prose).toBe(five);
  });
  it('refuses prose over the cap', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(() => StylePrefsSchema.parse({ prose: six })).toThrow();
  });
});

describe('styleProseLineCount / styleProseProblem', () => {
  it('a trailing newline is not a line', () => {
    expect(styleProseLineCount('a\nb\n')).toBe(2);
  });
  it('CRLF counts like LF', () => {
    expect(styleProseLineCount('a\r\nb\r\nc')).toBe(3);
  });
  it('empty prose is zero lines and no problem', () => {
    expect(styleProseLineCount('')).toBe(0);
    expect(styleProseProblem('')).toBeNull();
  });
  it('the problem names the count and the cap', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
    expect(styleProseProblem(six)).toBe(`prose is 6 lines; the cap is ${STYLE_PROSE_MAX_LINES}`);
  });
});

describe('resolveStyle (spec §4.1)', () => {
  it('with no prefs, every dial is the team default and both proses are empty', () => {
    const r = resolveStyle(shipped);
    expect(r.dials).toEqual(shipped.defaults);
    expect(r.team_prose).toBe('');
    expect(r.human_prose).toBe('');
  });
  it.each([
    ['pushback', 'every-time'],
    ['bluntness', 'direct'],
    ['length', 'concise'],
    ['format', 'structured'],
  ] as const)("a human's %s overrides the team default", (dial, value) => {
    const r = resolveStyle(shipped, { [dial]: value });
    expect(r.dials[dial]).toBe(value);
    for (const other of ['pushback', 'bluntness', 'length', 'format'] as const)
      if (other !== dial) expect(r.dials[other]).toBe(shipped.defaults[other]);
  });
  it('the floor comes from policy only — prefs cannot reach it', () => {
    const policy = StylePolicySchema.parse({ floor: { concession_names_check: false } });
    const r = resolveStyle(policy, { pushback: 'only-on-risk' });
    expect(r.floor).toEqual(policy.floor);
  });
  it('team prose and human prose are kept apart, in that order', () => {
    const policy = StylePolicySchema.parse({ prose: 'Say numbers with units.' });
    const r = resolveStyle(policy, { prose: 'Lead with the result.' });
    expect(r.team_prose).toBe('Say numbers with units.');
    expect(r.human_prose).toBe('Lead with the result.');
  });
  it('empty prefs resolve identically to no prefs — same epoch', () => {
    expect(resolveStyle(shipped, {}).epoch).toBe(resolveStyle(shipped).epoch);
  });
});

describe('styleEpoch', () => {
  it('is 8 hex chars and stable for equal inputs', () => {
    const a = resolveStyle(shipped);
    const b = resolveStyle(StylePolicySchema.parse({}));
    expect(a.epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(a.epoch).toBe(b.epoch);
    expect(styleEpoch(a)).toBe(a.epoch);
  });
  it('moves when a dial moves, and when a floor boolean moves', () => {
    const base = resolveStyle(shipped).epoch;
    expect(resolveStyle(shipped, { length: 'concise' }).epoch).not.toBe(base);
    expect(
      resolveStyle(StylePolicySchema.parse({ floor: { assess_before_agreeing: false } })).epoch,
    ).not.toBe(base);
  });
  it('moves when prose moves', () => {
    const base = resolveStyle(shipped).epoch;
    expect(resolveStyle(shipped, { prose: 'x' }).epoch).not.toBe(base);
  });
});
