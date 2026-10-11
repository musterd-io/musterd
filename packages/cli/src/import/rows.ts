import { GoalStorySchema, LANE_STAKES, type LaneStakes } from '@musterd/protocol';
import { z } from 'zod';
import { CsvError, readCsv } from './csv.js';

/**
 * Import rows (spec 2026-10-10 "bring work in" §"The import file"). One table; `kind` says what a row
 * is. Row-local checks happen here; anything that needs the live board happens in check.ts. A row that
 * fails is reported and dropped, so later stages only ever see valid rows.
 */
export type ImportFormat = 'csv' | 'jsonl';

export interface Diagnostic {
  level: 'error' | 'warning';
  row: number | null;
  code: string;
  message: string;
}

export interface ImportRow {
  row: number;
  kind: 'goal' | 'lane';
  key?: string;
  title: string;
  detail?: string;
  story?: string;
  goal?: string;
  depends_on: string[];
  stakes?: LaneStakes;
  source_ref?: string;
}

export const GOAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const COLUMNS = [
  'kind',
  'key',
  'title',
  'detail',
  'story',
  'goal',
  'depends_on',
  'stakes',
  'source_ref',
] as const;
const LANE_ONLY = ['detail', 'goal', 'stakes'] as const;
const GOAL_ONLY = ['story'] as const;

/** The boundary schema (hard rule 4). Cells arrive as strings (CSV) or JSON values (JSONL). */
const RawRowSchema = z
  .object({
    kind: z.string().optional(),
    key: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    story: z.string().optional(),
    goal: z.string().optional(),
    depends_on: z.union([z.string(), z.array(z.string())]).optional(),
    stakes: z.string().optional(),
    source_ref: z.string().optional(),
  })
  .passthrough();
type RawRow = z.infer<typeof RawRowSchema>;

export function formatFor(path: string): ImportFormat {
  return /\.(jsonl|ndjson)$/i.test(path) ? 'jsonl' : 'csv';
}

export function parseImportFile(
  text: string,
  format: ImportFormat,
): { rows: ImportRow[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const raws = format === 'csv' ? csvRaws(text, diagnostics) : jsonlRaws(text, diagnostics);
  const rows: ImportRow[] = [];
  const seenKeys = new Map<string, number>();
  const warnedColumns = new Set<string>();

  for (const { row, value } of raws) {
    const parsed = RawRowSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push(
        err(
          row,
          'invalid_row',
          `row is not a valid import row: ${parsed.error.issues[0]?.message ?? 'shape'}`,
        ),
      );
      continue;
    }
    for (const col of Object.keys(parsed.data)) {
      if (!(COLUMNS as readonly string[]).includes(col) && !warnedColumns.has(col)) {
        warnedColumns.add(col);
        diagnostics.push(warn(row, 'unknown_column', `unknown column "${col}" is ignored`));
      }
    }
    const r = toRow(row, parsed.data, diagnostics);
    if (!r) continue;
    if (r.key !== undefined) {
      const first = seenKeys.get(r.key);
      if (first !== undefined) {
        diagnostics.push(
          err(row, 'duplicate_key', `key "${r.key}" is already used on line ${String(first)}`),
        );
        continue;
      }
      seenKeys.set(r.key, row);
    }
    rows.push(r);
  }
  return { rows, diagnostics };
}

function toRow(row: number, raw: RawRow, out: Diagnostic[]): ImportRow | null {
  const s = (v: string | undefined) => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  const kind = s(raw.kind)?.toLowerCase();
  if (kind !== 'goal' && kind !== 'lane') {
    out.push(err(row, 'unknown_kind', `kind must be "goal" or "lane", got "${raw.kind ?? ''}"`));
    return null;
  }
  const title = s(raw.title);
  if (!title) {
    out.push(err(row, 'missing_title', 'title is required'));
    return null;
  }
  const key = s(raw.key);
  if (kind === 'goal') {
    if (!key) {
      out.push(err(row, 'missing_goal_key', 'a goal needs a key — it becomes the goal id'));
      return null;
    }
    if (!GOAL_ID_RE.test(key)) {
      out.push(
        err(
          row,
          'invalid_goal_key',
          `goal key "${key}" must be lowercase letters, digits and dashes`,
        ),
      );
      return null;
    }
  }
  const story = s(raw.story);
  if (kind === 'goal' && story !== undefined && !GoalStorySchema.safeParse(story).success) {
    out.push(err(row, 'story_too_long', 'story is longer than 140 characters'));
    return null;
  }
  const stakesRaw = s(raw.stakes)?.toLowerCase();
  if (
    kind === 'lane' &&
    stakesRaw !== undefined &&
    !(LANE_STAKES as readonly string[]).includes(stakesRaw)
  ) {
    out.push(err(row, 'invalid_stakes', `stakes must be low, normal or high, got "${stakesRaw}"`));
    return null;
  }
  const misplaced = kind === 'goal' ? LANE_ONLY : GOAL_ONLY;
  for (const f of misplaced) {
    if (s(raw[f]) !== undefined)
      out.push(warn(row, 'ignored_field', `"${f}" does not apply to a ${kind} and is ignored`));
  }
  const deps = Array.isArray(raw.depends_on) ? raw.depends_on : (raw.depends_on ?? '').split(';');
  const out_: ImportRow = {
    row,
    kind,
    title,
    depends_on: deps.map((d) => d.trim()).filter(Boolean),
  };
  if (key !== undefined) out_.key = key;
  const sourceRef = s(raw.source_ref);
  if (sourceRef !== undefined) out_.source_ref = sourceRef;
  if (kind === 'goal') {
    if (story !== undefined) out_.story = story;
  } else {
    const detail = s(raw.detail);
    const goal = s(raw.goal);
    if (detail !== undefined) out_.detail = detail;
    if (goal !== undefined) out_.goal = goal;
    if (stakesRaw !== undefined) out_.stakes = stakesRaw as LaneStakes;
  }
  return out_;
}

function csvRaws(
  text: string,
  out: Diagnostic[],
): { row: number; value: Record<string, string> }[] {
  let records: string[][];
  try {
    records = readCsv(text);
  } catch (e) {
    if (e instanceof CsvError) {
      out.push(err(e.line, 'csv_syntax', e.message));
      return [];
    }
    throw e;
  }
  const [header, ...body] = records;
  if (!header) return [];
  const cols = header.map((h) => h.trim().toLowerCase());
  const result: { row: number; value: Record<string, string> }[] = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const value: Record<string, string> = {};
    cols.forEach((c, j) => {
      if (c !== '') value[c] = cells[j] ?? '';
    });
    result.push({ row: i + 2, value });
  });
  return result;
}

function jsonlRaws(text: string, out: Diagnostic[]): { row: number; value: unknown }[] {
  const result: { row: number; value: unknown }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('not an object');
      result.push({ row: i + 1, value });
    } catch {
      out.push(err(i + 1, 'invalid_json', 'line is not a JSON object'));
    }
  });
  return result;
}

const err = (row: number | null, code: string, message: string): Diagnostic => ({
  level: 'error',
  row,
  code,
  message,
});
const warn = (row: number | null, code: string, message: string): Diagnostic => ({
  level: 'warning',
  row,
  code,
  message,
});
