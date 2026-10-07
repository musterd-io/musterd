import { describe, expect, it } from 'vitest';
import { teamKnobSet, withDial, withProse, withTeamStyle } from './styleEdit';

/** ADR 514 inc 5: the /board style sheet's merges — every write is a whole-doc replace server-side. */
describe('styleEdit', () => {
  describe('withDial (a human’s own prefs)', () => {
    it('sets one dial and keeps the rest', () => {
      expect(withDial({ length: 'concise', prose: 'hi' }, 'pushback', 'every-time')).toEqual({
        length: 'concise',
        prose: 'hi',
        pushback: 'every-time',
      });
    });
    it('null hands the dial back to the team default by dropping the key', () => {
      expect(withDial({ length: 'concise', format: 'structured' }, 'length', null)).toEqual({
        format: 'structured',
      });
    });
    it('never mutates what it was given', () => {
      const prefs = { length: 'concise' as const };
      withDial(prefs, 'length', 'thorough');
      expect(prefs).toEqual({ length: 'concise' });
    });
  });

  describe('withProse', () => {
    it('stores the text, and blank (whitespace only) removes the key', () => {
      expect(withProse({ length: 'concise' }, 'skip the recap')).toEqual({
        length: 'concise',
        prose: 'skip the recap',
      });
      expect(withProse({ length: 'concise', prose: 'x' }, '  \n ')).toEqual({ length: 'concise' });
    });
  });

  describe('withTeamStyle (admin, sparse policy)', () => {
    const stored = { residency: { mode: 'local' }, style: { defaults: { length: 'normal' as const } } };

    it('keeps every other policy key — a dropped key would reset to its default', () => {
      const next = withTeamStyle(stored, { floor: { assess_before_agreeing: false } });
      expect(next.residency).toEqual({ mode: 'local' });
      expect(next.style).toEqual({
        defaults: { length: 'normal' },
        floor: { assess_before_agreeing: false },
      });
    });
    it('a dial merges into the stored defaults', () => {
      expect(withTeamStyle(stored, { defaults: { pushback: 'only-on-risk' } }).style).toEqual({
        defaults: { length: 'normal', pushback: 'only-on-risk' },
      });
    });
    it('blank prose removes it; a style left empty is dropped whole', () => {
      const withProseSet = withTeamStyle({ style: { prose: 'be brief' } }, { prose: '' });
      expect(withProseSet).toEqual({});
    });
    it('starts a style block when there was none', () => {
      expect(withTeamStyle({}, { prose: 'ship it' })).toEqual({ style: { prose: 'ship it' } });
    });
  });

  describe('teamKnobSet', () => {
    const stored = { style: { floor: { concession_names_check: true }, defaults: { length: 'thorough' as const } } };
    it('a knob named in the stored doc was set for the team — even to its shipped value', () => {
      expect(teamKnobSet(stored, 'floor', 'concession_names_check')).toBe(true);
      expect(teamKnobSet(stored, 'defaults', 'length')).toBe(true);
    });
    it('anything absent is the shipped default', () => {
      expect(teamKnobSet(stored, 'floor', 'assess_before_agreeing')).toBe(false);
      expect(teamKnobSet({}, 'defaults', 'pushback')).toBe(false);
      expect(teamKnobSet({}, 'prose')).toBe(false);
      expect(teamKnobSet({ style: { prose: 'x' } }, 'prose')).toBe(true);
    });
  });
});
