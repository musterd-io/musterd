import { describe, expect, it } from 'vitest';
import { CsvError, readCsv } from './csv.js';

describe('readCsv', () => {
  it('reads a header and rows', () => {
    expect(readCsv('kind,title\ngoal,Ship it\n')).toEqual([
      ['kind', 'title'],
      ['goal', 'Ship it'],
    ]);
  });

  it('handles quoted commas, newlines and doubled quotes', () => {
    expect(readCsv('a,b\n"x, y","line1\nline2 ""q"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'line1\nline2 "q"'],
    ]);
  });

  it('strips a UTF-8 BOM and accepts CRLF (spreadsheet exports)', () => {
    expect(readCsv('﻿kind,title\r\ngoal,A\r\n')).toEqual([
      ['kind', 'title'],
      ['goal', 'A'],
    ]);
  });

  it('keeps empty fields and a final record without a newline', () => {
    expect(readCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('refuses an unterminated quote with its starting line', () => {
    expect(() => readCsv('a\n"open\n')).toThrow(CsvError);
    try {
      readCsv('a\n"open\n');
    } catch (e) {
      expect((e as CsvError).line).toBe(2);
    }
  });

  it('refuses a quote inside an unquoted field', () => {
    expect(() => readCsv('a\nab"c\n')).toThrow(/line 2/);
  });
});
