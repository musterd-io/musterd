import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_COLUMNS, parseImportFile } from './rows.js';
import { defaultSheetName, exampleDiagnostics, renderSheet, writeSheet } from './sheet.js';

describe('renderSheet', () => {
  it('has every column and two example rows that import cleanly', () => {
    const text = renderSheet();
    expect(text.split('\n')[0]).toBe(IMPORT_COLUMNS.join(','));
    const { rows, diagnostics } = parseImportFile(text, 'csv');
    expect(diagnostics).toEqual([]);
    expect(rows.map((r) => r.kind)).toEqual(['goal', 'lane']);
    expect(rows[1]!.goal).toBe(rows[0]!.key);
  });
});

describe('exampleDiagnostics', () => {
  it('warns on a row still matching a sheet example, and only on those', () => {
    const { rows } = parseImportFile(
      renderSheet() + 'lane,,Write the upgrade guide,,,,,,\n',
      'csv',
    );
    const d = exampleDiagnostics(rows);
    expect(d.map((x) => [x.level, x.code, x.row])).toEqual([
      ['warning', 'example_row', 2],
      ['warning', 'example_row', 3],
    ]);
    expect(d[0]!.message).toMatch(/still the sheet's example — delete it/);
  });
});

describe('writeSheet', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-sheet-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the sheet and never overwrites a file', () => {
    const path = join(dir, 'plan.csv');
    writeSheet(path);
    expect(readFileSync(path, 'utf8')).toBe(renderSheet());
    writeFileSync(path, 'mine');
    expect(() => writeSheet(path)).toThrow(/already exists/);
    expect(readFileSync(path, 'utf8')).toBe('mine');
  });

  it('names the default sheet by date', () => {
    expect(defaultSheetName(Date.UTC(2026, 9, 10, 23))).toBe('sheet-20261010.csv');
  });
});
