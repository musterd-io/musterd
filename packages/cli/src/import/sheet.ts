import { writeFileSync } from 'node:fs';
import { CliError } from '../errors.js';
import { IMPORT_COLUMNS, type Diagnostic, type ImportRow } from './rows.js';

/**
 * `musterd import sheet` (spec 2026-10-10 "bring work in", phase 3): a blank import file a person fills
 * in by hand — the header row and one example goal and lane to copy. A row still matching an example
 * at import time gets an `example_row` warning, so a forgotten example is seen before it is saved.
 */
type Column = (typeof IMPORT_COLUMNS)[number];

const EXAMPLES: Partial<Record<Column, string>>[] = [
  {
    kind: 'goal',
    key: 'first-release',
    title: 'Ship the first release',
    story: 'People can install it and use it without asking us how',
  },
  {
    kind: 'lane',
    key: 'install-guide',
    title: 'Write the install guide',
    detail: 'One page: install and run it once',
    goal: 'first-release',
    stakes: 'normal',
  },
];

export function renderSheet(): string {
  const line = (cells: string[]) => cells.map(quote).join(',');
  return (
    [
      line([...IMPORT_COLUMNS]),
      ...EXAMPLES.map((e) => line(IMPORT_COLUMNS.map((c) => e[c] ?? ''))),
    ].join('\n') + '\n'
  );
}

export function exampleDiagnostics(rows: ImportRow[]): Diagnostic[] {
  return rows
    .filter((r) => EXAMPLES.some((e) => e.kind === r.kind && e.title === r.title))
    .map((r) => ({
      level: 'warning',
      row: r.row,
      code: 'example_row',
      message: `"${r.title}" is still the sheet's example — delete it unless you mean it`,
    }));
}

/** Writes the sheet; refuses a path that already exists (`wx`), so a filled-in sheet is never lost. */
export function writeSheet(path: string): void {
  try {
    writeFileSync(path, renderSheet(), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw new CliError(`${path} already exists — pass another path, or import it`, 2);
    throw e;
  }
}

export function defaultSheetName(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `sheet-${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.csv`;
}

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
