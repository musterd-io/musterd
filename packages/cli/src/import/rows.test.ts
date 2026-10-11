import { describe, expect, it } from 'vitest';
import { formatFor, parseImportFile } from './rows.js';

const csv = (s: string) => parseImportFile(s, 'csv');
const codes = (r: ReturnType<typeof csv>) => r.diagnostics.map((d) => `${d.level}:${d.code}`);

describe('parseImportFile', () => {
  it('parses goals and lanes with ; lists and source line numbers', () => {
    const r = csv(
      'kind,key,title,goal,depends_on,stakes,source_ref\n' +
        'goal,first-run,First run,,,,\n' +
        'lane,a,Import command,first-run,,high,github#12\n' +
        'lane,,Skill,first-run,a; b,,\n',
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.rows).toEqual([
      { row: 2, kind: 'goal', key: 'first-run', title: 'First run', depends_on: [] },
      {
        row: 3,
        kind: 'lane',
        key: 'a',
        title: 'Import command',
        goal: 'first-run',
        depends_on: [],
        stakes: 'high',
        source_ref: 'github#12',
      },
      { row: 4, kind: 'lane', title: 'Skill', goal: 'first-run', depends_on: ['a', 'b'] },
    ]);
  });

  it('skips fully blank rows and trims cells (a hand-filled sheet)', () => {
    const r = csv('kind,title\n lane , Tidy up \n,\n\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.rows).toEqual([{ row: 2, kind: 'lane', title: 'Tidy up', depends_on: [] }]);
  });

  it('reports row errors and drops the bad rows', () => {
    const r = csv(
      'kind,key,title,stakes,story\n' +
        'epic,,X,,\n' + // unknown kind
        'lane,,,,\n' + // missing title
        'goal,,No key,,\n' + // goal without key
        'goal,Bad Key,T,,\n' + // invalid goal id
        'lane,,T,urgent,\n' + // bad stakes
        `goal,g,T,,${'x'.repeat(141)}\n`, // story too long
    );
    expect(codes(r)).toEqual([
      'error:unknown_kind',
      'error:missing_title',
      'error:missing_goal_key',
      'error:invalid_goal_key',
      'error:invalid_stakes',
      'error:story_too_long',
    ]);
    expect(r.rows).toEqual([]);
  });

  it('errors on a duplicate key and keeps the first', () => {
    const r = csv('kind,key,title\ngoal,g,One\nlane,g,Two\n');
    expect(codes(r)).toEqual(['error:duplicate_key']);
    expect(r.diagnostics[0]!.row).toBe(3);
    expect(r.rows.map((x) => x.title)).toEqual(['One']);
  });

  it('warns once per unknown column and on a misplaced field', () => {
    const r = csv('kind,key,title,owner,story,stakes\nlane,,A,ada,hi,\ngoal,g,B,bob,,low\n');
    expect(codes(r)).toEqual([
      'warning:unknown_column',
      'warning:ignored_field',
      'warning:ignored_field',
    ]);
  });

  it('turns a CSV syntax error into one file-level error', () => {
    const r = csv('kind,title\nlane,"open\n');
    expect(r.rows).toEqual([]);
    expect(r.diagnostics).toMatchObject([{ level: 'error', code: 'csv_syntax', row: 2 }]);
  });

  it('reads JSONL with the same keys and arrays for depends_on', () => {
    const r = parseImportFile(
      '{"kind":"goal","key":"g","title":"G"}\n\n{"kind":"lane","title":"L","goal":"g","depends_on":["x"]}\nnot json\n',
      'jsonl',
    );
    expect(r.rows).toEqual([
      { row: 1, kind: 'goal', key: 'g', title: 'G', depends_on: [] },
      { row: 3, kind: 'lane', title: 'L', goal: 'g', depends_on: ['x'] },
    ]);
    expect(codes(r)).toEqual(['error:invalid_json']);
  });

  it('picks the format from the extension', () => {
    expect(formatFor('a.jsonl')).toBe('jsonl');
    expect(formatFor('a.ndjson')).toBe('jsonl');
    expect(formatFor('a.CSV')).toBe('csv');
  });
});
