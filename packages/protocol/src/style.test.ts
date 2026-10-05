import { describe, expect, it } from 'vitest';
import {
  STYLE_PROSE_MAX_LINES,
  StylePolicyOverrideSchema,
  StylePolicySchema,
  StylePrefsSchema,
  styleProseLineCount,
  styleProseProblem,
} from './style.js';

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
