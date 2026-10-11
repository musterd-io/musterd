# Bring Existing Work In — Implementation Plan (phase 1)

> **For agentic workers:** implement in your own seat with `superpowers:executing-plans` (AGENTS.md hard
> rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new team turns its repo and GitHub issues into goals and lanes in two steps —
`musterd import <file>` previews and stages, `musterd import save <id>` creates them — driven by a
`musterd-import` skill that `musterd init` installs.

**Architecture:** a pure pipeline in `packages/cli/src/import/` (CSV/JSONL reader → row parser → board
check → stage file → resumable save) behind one command, `packages/cli/src/commands/import.ts`. Save uses
the existing `HttpClient.declareGoal` / `HttpClient.openLane`; no protocol schema changes. The skill's
prose is rendered from `@musterd/protocol` `guidance.ts` like `musterd-orient`, and written per harness
by `onboard/guidance.ts`.

**Tech Stack:** TypeScript, Node ≥22, zod 3 (already a CLI dependency), vitest.

**Spec:** [`docs/superpowers/specs/2026-10-10-bring-work-in-design.md`](../specs/2026-10-10-bring-work-in-design.md)

**Lane:** `01M4FDBSN8JKWV6GJQ7C3VB888` (phase 1 of the spec). Phases 2–4 are lanes
`01M4M4A67Z9ZMYCSPHG55FSY8E`, `01M4M4AAJA75AS1YEN8CCHJ6DY`, `01M4M4ABWQ7M5VEB9RS3VG99VF`; this plan
builds none of them.

## Global Constraints

- **No new runtime dependency** (AGENTS.md hard rule 6). The CSV reader is hand-written.
- **No `@musterd/protocol` schema change** (hard rule 1). The import-row zod schema lives in the CLI: the
  import file is local input, not a wire frame. Guidance *prose* in `protocol/src/guidance.ts` is not a
  schema; it follows ADR 085's version-bump rule instead (`GUIDANCE_CONTENT_VERSION` 46 → 47).
- **Parse all external input with zod at the boundary** (hard rule 4): every row passes `ImportRowSchema`.
- **The CLI talks to the server over the wire only**; tests may import `@musterd/server` (as
  `seed.test.ts` does).
- **Docs and code agree at every commit** (hard rule 3): each new source file gets its described line in
  `docs/architecture/04-cli.md`'s file tree in the same commit (`arch-trees:check`).
- **Vocabulary:** never write `kit`, `profile`, `template`, `worktree` in new prose (`vocab:check`). The
  blank-sheet command (phase 3) is `import sheet`.
- **Imported lanes open unclaimed** and carry no `scope`, `risk`, `branch`, `role`, owner.
- **A goal that already exists is linked, never re-declared** (re-declaring amends it, latest wins).
- **Stage path:** `<workspace>/.musterd/imports/<id>.json`; the first stage write also writes
  `.musterd/imports/.gitignore` containing `*`.
- **Stage expiry:** 24 hours (`STAGE_TTL_MS = 24 * 60 * 60 * 1000`).
- **First-import cap** (skill prose only, not enforced by the CLI): about 5 goals and 30 lanes.
- **Local verification:** single test files with `pnpm --filter @musterd/cli exec vitest run <file>`,
  plus `pnpm typecheck && pnpm lint && pnpm format:check` before pushing. Never the full suite
  (the laptop hosts many seats; CI is the authority).
- **Commit trailer:** `Co-authored-by: dolly <dolly@revive.musterd>`.

## Review Focus

1. **A spreadsheet exported with a UTF-8 BOM and CRLF line endings** (Excel, Google Sheets) — the header
   must still read `kind`, not `﻿kind`, and no field may end in `\r`. Test in Task 1.
2. **Blank trailing rows and stray whitespace in cells** (a person filling a sheet) — fully blank rows are
   skipped, not errors; cells are trimmed. Test in Task 1 and Task 2.
3. **A lane depending on a lane that is already done on the board** (`history: true`) — it resolves; only
   ids absent from the whole board are errors. Test in Task 3.
4. **A save interrupted after the goals but mid-lanes, then re-run** — no goal is declared twice and no
   lane opened twice, and staged dependencies resolve to the ids created in the first run. Test in
   Task 5.
5. **Running `import save` from a different team's workspace, or on an old stage** — refused with the
   re-run instruction, nothing created. Test in Task 5.

---

## File map

| File | Responsibility |
| --- | --- |
| Create `packages/cli/src/import/csv.ts` | RFC 4180 reader → `string[][]` |
| Create `packages/cli/src/import/rows.ts` | `ImportRowSchema`; CSV/JSONL text → typed rows + per-row diagnostics |
| Create `packages/cli/src/import/check.ts` | rows + live board → plan (goals, lanes in creation order) + diagnostics |
| Create `packages/cli/src/import/stage.ts` | stage type; create/read/write/list; `.gitignore`; ids |
| Create `packages/cli/src/import/save.ts` | refusals; resumable save through a two-method port |
| Create `packages/cli/src/import/render.ts` | preview, save result and list text |
| Create `packages/cli/src/commands/import.ts` | `musterd import <file>` / `save <id>` / `list` |
| Modify `packages/cli/src/commandTable.ts` | register `import` |
| Modify `packages/cli/src/help/catalog.ts` | catalog entry, group `work` |
| Modify `packages/protocol/src/guidance.ts` | `renderImportSkill`, `renderImportFrontmatter`; version 47; `'import'` in `SKILL_CLI_COMMANDS` |
| Modify `packages/protocol/src/guidance.test.ts` | snapshot 47 + skill content tests |
| Modify `packages/cli/src/onboard/harness.ts` | `HarnessGuidance.importSkillPath?` |
| Modify `packages/cli/src/onboard/harnesses/{claudeCode,cursor,grok}.ts` | set `importSkillPath` |
| Modify `packages/cli/src/onboard/guidance.ts` | write/target/map/remove the import skill (+ canonical `.musterd/skill/import.md`) |
| Modify `README.md` | quickstart's last step |
| Modify `docs/architecture/04-cli.md` | tree lines for every new file |

---

### Task 1: CSV reader

**Files:**
- Create: `packages/cli/src/import/csv.ts`
- Test: `packages/cli/src/import/csv.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree)

**Interfaces:**
- Produces: `export function readCsv(text: string): string[][]` — records in order, every field
  untrimmed, BOM stripped, CRLF/LF/CR all accepted, a trailing newline produces no extra record. Throws
  `CsvError` (`export class CsvError extends Error { constructor(message: string, readonly line: number) }`)
  for an unterminated quote or a stray quote inside an unquoted field.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/csv.test.ts`
Expected: FAIL — cannot resolve `./csv.js`.

- [ ] **Step 3: Implement**

```ts
/**
 * A small RFC 4180 reader for `musterd import` (spec 2026-10-10 "bring work in"). Hand-written rather
 * than a dependency (AGENTS.md hard rule 6): quoted fields, `""` escapes, commas and newlines inside
 * quotes, a header row, CRLF/LF/CR, and the UTF-8 BOM spreadsheet exports prepend.
 */
export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${String(line)})`);
  }
}

export function readCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let line = 1;
  let quoted = false;
  let quoteLine = 0;
  let fieldStarted = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (c === '\n') line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new CsvError('a quote inside an unquoted field', line);
      quoted = true;
      quoteLine = line;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line += 1;
      continue;
    }
    field += c;
    fieldStarted = true;
    i += 1;
  }
  if (quoted) throw new CsvError('an unterminated quote', quoteLine);
  if (fieldStarted || field !== '' || record.length > 0) endRecord();
  return records;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/csv.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the tree lines** in `docs/architecture/04-cli.md`, a new directory block after the
`archaeology/` block (keep alphabetical neighbours as the file does):

```
  import/             // `musterd import` (spec 2026-10-10 "bring work in"): file → board check → stage → resumable save; no protocol change
    csv.ts            // hand-written RFC 4180 reader (quotes, "" escapes, CRLF, BOM) — no dependency (hard rule 6)
```

Run: `pnpm arch-trees:check` — Expected: ✓.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/import/csv.ts packages/cli/src/import/csv.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): RFC 4180 reader for musterd import (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 2: Rows — parse a file into typed rows

**Files:**
- Create: `packages/cli/src/import/rows.ts`
- Test: `packages/cli/src/import/rows.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree)

**Interfaces:**
- Consumes: `readCsv`, `CsvError` (Task 1).
- Produces:

```ts
export type ImportFormat = 'csv' | 'jsonl';
export interface Diagnostic {
  level: 'error' | 'warning';
  /** 1-based source line of the row (CSV: the header is line 1), or null for file-level. */
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
export const GOAL_ID_RE: RegExp; // /^[a-z0-9][a-z0-9-]{0,63}$/
export function formatFor(path: string): ImportFormat; // .jsonl/.ndjson → jsonl, else csv
export function parseImportFile(text: string, format: ImportFormat): { rows: ImportRow[]; diagnostics: Diagnostic[] };
```

Row-level checks here (no board needed): unknown `kind`; missing title; goal row without `key`; goal
`key` not matching `GOAL_ID_RE`; `story` over 140 chars (reuse `GoalStorySchema` from
`@musterd/protocol`); invalid `stakes`; duplicate `key` across the file (goal and lane keys share one
namespace); unknown column (warning, once per column); lane-only field on a goal row or goal-only field on
a lane row (warning). Fully blank rows are skipped. Cells are trimmed. An invalid row is reported and
**dropped** from `rows`, so later stages see only valid rows. CSV read errors become one file-level
error. A JSONL line that is not a JSON object is an error for that line.

- [ ] **Step 1: Write the failing tests**

```ts
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
      { row: 3, kind: 'lane', key: 'a', title: 'Import command', goal: 'first-run', depends_on: [], stakes: 'high', source_ref: 'github#12' },
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
    expect(codes(r)).toEqual(['warning:unknown_column', 'warning:ignored_field', 'warning:ignored_field']);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/rows.test.ts`
Expected: FAIL — cannot resolve `./rows.js`.

- [ ] **Step 3: Implement**

```ts
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

const COLUMNS = ['kind', 'key', 'title', 'detail', 'story', 'goal', 'depends_on', 'stakes', 'source_ref'] as const;
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
      diagnostics.push(err(row, 'invalid_row', `row is not a valid import row: ${parsed.error.issues[0]?.message ?? 'shape'}`));
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
        diagnostics.push(err(row, 'duplicate_key', `key "${r.key}" is already used on line ${String(first)}`));
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
      out.push(err(row, 'invalid_goal_key', `goal key "${key}" must be lowercase letters, digits and dashes`));
      return null;
    }
  }
  const story = s(raw.story);
  if (kind === 'goal' && story !== undefined && !GoalStorySchema.safeParse(story).success) {
    out.push(err(row, 'story_too_long', 'story is longer than 140 characters'));
    return null;
  }
  const stakesRaw = s(raw.stakes)?.toLowerCase();
  if (kind === 'lane' && stakesRaw !== undefined && !(LANE_STAKES as readonly string[]).includes(stakesRaw)) {
    out.push(err(row, 'invalid_stakes', `stakes must be low, normal or high, got "${stakesRaw}"`));
    return null;
  }
  const misplaced = kind === 'goal' ? LANE_ONLY : GOAL_ONLY;
  for (const f of misplaced) {
    if (s(raw[f]) !== undefined) out.push(warn(row, 'ignored_field', `"${f}" does not apply to a ${kind} and is ignored`));
  }
  const deps = Array.isArray(raw.depends_on) ? raw.depends_on : (raw.depends_on ?? '').split(';');
  const out_: ImportRow = { row, kind, title, depends_on: deps.map((d) => d.trim()).filter(Boolean) };
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

function csvRaws(text: string, out: Diagnostic[]): { row: number; value: Record<string, string> }[] {
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
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
      result.push({ row: i + 1, value });
    } catch {
      out.push(err(i + 1, 'invalid_json', 'line is not a JSON object'));
    }
  });
  return result;
}

const err = (row: number | null, code: string, message: string): Diagnostic => ({ level: 'error', row, code, message });
const warn = (row: number | null, code: string, message: string): Diagnostic => ({ level: 'warning', row, code, message });
```

Note: the "unknown column" warning test expects `owner` warned once even though it appears in two rows —
`warnedColumns` covers that.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/rows.test.ts`
Expected: PASS (8 tests). If `GoalStorySchema` or `LANE_STAKES` is not re-exported from the package root,
import from the subpath the CLI already uses for lanes (`grep -rn "LANE_STAKES" packages/cli/src`).

- [ ] **Step 5: Tree line** under `import/` in `04-cli.md`:

```
    rows.ts           // CSV/JSONL → ImportRow[] through a CLI-local zod schema (hard rule 4; not a wire schema); row-local errors drop the row, warnings keep it
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/import/rows.ts packages/cli/src/import/rows.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): import rows — CSV/JSONL to typed goal and lane rows (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 3: Board check and creation order

**Files:**
- Create: `packages/cli/src/import/check.ts`
- Test: `packages/cli/src/import/check.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree)

**Interfaces:**
- Consumes: `ImportRow`, `Diagnostic` (Task 2).
- Produces:

```ts
export type LaneDep = { kind: 'existing'; id: string } | { kind: 'staged'; ref: string };
export interface PlannedGoal { ref: string; row: number; id: string; title: string; story?: string; depends_on: string[]; source_ref?: string }
export interface PlannedLane { ref: string; row: number; title: string; detail?: string; goal_id?: string; depends_on: LaneDep[]; stakes?: LaneStakes }
export interface BoardSnapshot {
  goals: { id: string }[];
  /** Every lane on the board, closed ones included (fetched with history: true). */
  lanes: { id: string; title: string; state: string }[];
}
export interface ImportPlan { goals: PlannedGoal[]; lanes: PlannedLane[]; linkedGoals: string[]; diagnostics: Diagnostic[] }
export function checkAgainstBoard(rows: ImportRow[], board: BoardSnapshot): ImportPlan;
export function normalizeTitle(t: string): string;
```

Rules:
- Goal `ref` = `goal:<key>`; lane `ref` = `lane:<key>` if keyed else `lane@<row>`.
- A goal row whose key is already a goal id on the board → **not planned**; key added to `linkedGoals`;
  warning `goal_exists`.
- A lane's `goal` resolves to a goal key in the file (planned or linked) or a goal id on the board; else
  error `unresolved_goal`. No goal → warning `no_goal`.
- A goal's `depends_on` entries resolve to goal keys in the file or goal ids on the board; else error
  `unresolved_dependency`.
- A lane's `depends_on` entries resolve to lane keys in the file (`staged`) or lane ids on the board,
  **any state** (`existing`); else error `unresolved_dependency` (message suggests the full lane id).
- Cycles among planned goals or among staged lane deps → error `dependency_cycle` naming the rows.
- Duplicate-title warning `likely_duplicate` when `normalizeTitle(lane.title)` equals that of a board
  lane whose state is not `done` or `abandoned`. `normalizeTitle`: lowercase, non-alphanumerics → space,
  collapse spaces, trim.
- `detail` gets `\n\nSource: <source_ref>` appended when a lane has `source_ref` (spec: a `Source:` line).
- `goals` and `lanes` are each returned in **creation order**: a stable topological order (input order
  among ready items). When a cycle exists, the order is the input order and the error blocks the save.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { checkAgainstBoard, normalizeTitle } from './check.js';
import type { ImportRow } from './rows.js';

const goal = (row: number, key: string, extra: Partial<ImportRow> = {}): ImportRow => ({ row, kind: 'goal', key, title: key, depends_on: [], ...extra });
const lane = (row: number, extra: Partial<ImportRow> = {}): ImportRow => ({ row, kind: 'lane', title: `Lane ${String(row)}`, depends_on: [], ...extra });
const empty = { goals: [], lanes: [] };
const codes = (p: ReturnType<typeof checkAgainstBoard>) => p.diagnostics.map((d) => `${d.level}:${d.code}@${String(d.row)}`);

describe('checkAgainstBoard', () => {
  it('links a goal that already exists instead of re-declaring it', () => {
    const p = checkAgainstBoard([goal(2, 'launch'), lane(3, { goal: 'launch' })], { goals: [{ id: 'launch' }], lanes: [] });
    expect(p.goals).toEqual([]);
    expect(p.linkedGoals).toEqual(['launch']);
    expect(p.lanes[0]!.goal_id).toBe('launch');
    expect(codes(p)).toEqual(['warning:goal_exists@2']);
  });

  it('resolves lane deps to staged keys and to board lanes in any state', () => {
    const p = checkAgainstBoard(
      [lane(2, { key: 'b', depends_on: ['a', '01DONE0000000000000000000A'], goal: 'g' }), lane(3, { key: 'a', goal: 'g' }), goal(4, 'g')],
      { goals: [], lanes: [{ id: '01DONE0000000000000000000A', title: 'Old', state: 'done' }] },
    );
    expect(p.diagnostics).toEqual([]);
    expect(p.lanes.map((l) => l.ref)).toEqual(['lane:a', 'lane:b']); // a before b
    expect(p.lanes[1]!.depends_on).toEqual([
      { kind: 'staged', ref: 'lane:a' },
      { kind: 'existing', id: '01DONE0000000000000000000A' },
    ]);
  });

  it('errors on unresolved goal and dependency references', () => {
    const p = checkAgainstBoard([lane(2, { goal: 'nope', depends_on: ['01M4FDBSN8'] }), goal(3, 'g', { depends_on: ['ghost'] })], empty);
    expect(codes(p)).toEqual(['error:unresolved_goal@2', 'error:unresolved_dependency@2', 'error:unresolved_dependency@3']);
    expect(p.diagnostics[1]!.message).toMatch(/full lane id/);
  });

  it('errors on a lane dependency cycle and on a goal cycle', () => {
    const p = checkAgainstBoard(
      [goal(2, 'x', { depends_on: ['y'] }), goal(3, 'y', { depends_on: ['x'] }), lane(4, { key: 'a', depends_on: ['b'], goal: 'x' }), lane(5, { key: 'b', depends_on: ['a'], goal: 'x' })],
      empty,
    );
    expect(codes(p).filter((c) => c.includes('dependency_cycle'))).toEqual(['error:dependency_cycle@2', 'error:dependency_cycle@4']);
  });

  it('warns on a likely duplicate of an open board lane, not a closed one, and on a lane with no goal', () => {
    const board = { goals: [], lanes: [{ id: 'L1', title: 'Fix: the login bug', state: 'open' }, { id: 'L2', title: 'Old thing', state: 'done' }] };
    const p = checkAgainstBoard([lane(2, { title: 'fix the  LOGIN bug' }), lane(3, { title: 'Old thing' })], board);
    expect(codes(p)).toEqual(['warning:likely_duplicate@2', 'warning:no_goal@2', 'warning:no_goal@3']);
  });

  it('appends the source line to detail', () => {
    const p = checkAgainstBoard([lane(2, { detail: 'Body', source_ref: 'github#7' })], empty);
    expect(p.lanes[0]!.detail).toBe('Body\n\nSource: github#7');
  });

  it('normalizes titles', () => {
    expect(normalizeTitle('  Fix: the LOGIN-bug ')).toBe('fix the login bug');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/check.test.ts`
Expected: FAIL — cannot resolve `./check.js`.

- [ ] **Step 3: Implement**

```ts
import type { LaneStakes } from '@musterd/protocol';
import type { Diagnostic, ImportRow } from './rows.js';

/**
 * The board half of `musterd import` (spec 2026-10-10 §"Step 1"). The server checks neither that a
 * lane's depends_on ids exist (store/lanes.ts stores them as given) nor that a goal id is new (a
 * re-declaration amends it, latest wins — store/goals.ts), so both guards live here.
 */
export type LaneDep = { kind: 'existing'; id: string } | { kind: 'staged'; ref: string };

export interface PlannedGoal {
  ref: string;
  row: number;
  id: string;
  title: string;
  story?: string;
  depends_on: string[];
  source_ref?: string;
}

export interface PlannedLane {
  ref: string;
  row: number;
  title: string;
  detail?: string;
  goal_id?: string;
  depends_on: LaneDep[];
  stakes?: LaneStakes;
}

export interface BoardSnapshot {
  goals: { id: string }[];
  lanes: { id: string; title: string; state: string }[];
}

export interface ImportPlan {
  goals: PlannedGoal[];
  lanes: PlannedLane[];
  linkedGoals: string[];
  diagnostics: Diagnostic[];
}

const CLOSED = new Set(['done', 'abandoned']);

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function checkAgainstBoard(rows: ImportRow[], board: BoardSnapshot): ImportPlan {
  const diagnostics: Diagnostic[] = [];
  const boardGoals = new Set(board.goals.map((g) => g.id));
  const boardLanes = new Set(board.lanes.map((l) => l.id));
  const openTitles = new Set(board.lanes.filter((l) => !CLOSED.has(l.state)).map((l) => normalizeTitle(l.title)));

  const goalRows = rows.filter((r) => r.kind === 'goal');
  const laneRows = rows.filter((r) => r.kind === 'lane');
  const fileGoalKeys = new Set(goalRows.map((r) => r.key!));
  const laneRefByKey = new Map(laneRows.filter((r) => r.key).map((r) => [r.key!, `lane:${r.key!}`]));

  const linkedGoals: string[] = [];
  const goals: PlannedGoal[] = [];
  for (const r of goalRows) {
    const id = r.key!;
    if (boardGoals.has(id)) {
      linkedGoals.push(id);
      diagnostics.push(warn(r.row, 'goal_exists', `goal "${id}" is already on the board — lanes link to it; it is not re-declared`));
      continue;
    }
    const deps: string[] = [];
    for (const d of r.depends_on) {
      if (fileGoalKeys.has(d) || boardGoals.has(d)) deps.push(d);
      else diagnostics.push(err(r.row, 'unresolved_dependency', `goal dependency "${d}" is not a goal in this file or on the board`));
    }
    goals.push({ ref: `goal:${id}`, row: r.row, id, title: r.title, depends_on: deps, ...(r.story ? { story: r.story } : {}), ...(r.source_ref ? { source_ref: r.source_ref } : {}) });
  }

  const lanes: PlannedLane[] = [];
  for (const r of laneRows) {
    const ref = r.key ? `lane:${r.key}` : `lane@${String(r.row)}`;
    const lane: PlannedLane = { ref, row: r.row, title: r.title, depends_on: [] };
    if (r.goal !== undefined) {
      if (fileGoalKeys.has(r.goal) || boardGoals.has(r.goal)) lane.goal_id = r.goal;
      else diagnostics.push(err(r.row, 'unresolved_goal', `goal "${r.goal}" is not a goal in this file or on the board`));
    }
    for (const d of r.depends_on) {
      const staged = laneRefByKey.get(d);
      if (staged) lane.depends_on.push({ kind: 'staged', ref: staged });
      else if (boardLanes.has(d)) lane.depends_on.push({ kind: 'existing', id: d });
      else diagnostics.push(err(r.row, 'unresolved_dependency', `lane dependency "${d}" is not a lane key in this file or a lane on the board (use the full lane id)`));
    }
    if (openTitles.has(normalizeTitle(r.title))) diagnostics.push(warn(r.row, 'likely_duplicate', `an open lane on the board has the same title: "${r.title}"`));
    if (lane.goal_id === undefined && r.goal === undefined) diagnostics.push(warn(r.row, 'no_goal', 'lane has no goal'));
    const detail = [r.detail, r.source_ref ? `Source: ${r.source_ref}` : undefined].filter(Boolean).join('\n\n');
    if (detail) lane.detail = detail;
    if (r.stakes) lane.stakes = r.stakes;
    lanes.push(lane);
  }

  const goalOrder = topo(goals, (g) => g.depends_on.filter((d) => fileGoalKeys.has(d) && !boardGoals.has(d)).map((d) => `goal:${d}`));
  const laneOrder = topo(lanes, (l) => l.depends_on.flatMap((d) => (d.kind === 'staged' ? [d.ref] : [])));
  for (const cyc of [goalOrder.cycle, laneOrder.cycle]) {
    if (cyc.length > 0) diagnostics.push(err(cyc[0]!, 'dependency_cycle', `dependency cycle among lines ${cyc.join(', ')}`));
  }

  diagnostics.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
  return { goals: goalOrder.items, lanes: laneOrder.items, linkedGoals, diagnostics };
}

/** Stable Kahn sort; on a cycle returns input order plus the rows left in the cycle. */
function topo<T extends { ref: string; row: number }>(items: T[], deps: (t: T) => string[]): { items: T[]; cycle: number[] } {
  const byRef = new Map(items.map((t) => [t.ref, t]));
  const placed = new Set<string>();
  const out: T[] = [];
  let progress = true;
  while (out.length < items.length && progress) {
    progress = false;
    for (const t of items) {
      if (placed.has(t.ref)) continue;
      if (deps(t).every((d) => placed.has(d) || !byRef.has(d))) {
        placed.add(t.ref);
        out.push(t);
        progress = true;
      }
    }
  }
  if (out.length === items.length) return { items: out, cycle: [] };
  return { items, cycle: items.filter((t) => !placed.has(t.ref)).map((t) => t.row) };
}

const err = (row: number, code: string, message: string): Diagnostic => ({ level: 'error', row, code, message });
const warn = (row: number, code: string, message: string): Diagnostic => ({ level: 'warning', row, code, message });
```

Note: the sort by row is stable (Array.prototype.sort is stable in Node ≥12), so diagnostics on one row
keep their emission order — the tests depend on that.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/check.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Tree line** under `import/`:

```
    check.ts          // rows vs the live board: goals that exist are linked, never re-declared (re-declare amends); deps resolve to file keys or board lanes in any state; cycles; likely duplicates; creation order (stable topo)
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/import/check.ts packages/cli/src/import/check.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): import board check — resolve, order, link existing goals (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 4: Stage files

**Files:**
- Create: `packages/cli/src/import/stage.ts`
- Test: `packages/cli/src/import/stage.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree)

**Interfaces:**
- Consumes: `ImportPlan`, `PlannedGoal`, `PlannedLane` (Task 3); `Diagnostic`, `ImportFormat` (Task 2);
  `writeJsonAtomic(path, value, validate?)` from `../onboard/atomicWrite.js`.
- Produces:

```ts
export const STAGE_TTL_MS: number; // 24h
export interface ImportStage {
  version: 1;
  id: string;
  team: string;
  project: string;
  created_at: number;
  source: { path: string; sha256: string; format: ImportFormat };
  goals: PlannedGoal[];
  lanes: PlannedLane[];
  linked_goals: string[];
  diagnostics: Diagnostic[];
  /** ref → real id, written after every create (the resume record). */
  created: Record<string, string>;
  saved_at: number | null;
}
export function importsDir(workspace: string): string; // <workspace>/.musterd/imports
export function newStageId(now: number): string;          // `${yyyymmdd}-${hhmmss}-${4 hex}`, UTC
export function createStage(workspace: string, init: Omit<ImportStage, 'version' | 'id' | 'created' | 'saved_at'>, now: number): ImportStage; // writes it + the .gitignore
export function readStage(workspace: string, id: string): ImportStage;     // throws CliError(…, 2) when missing or malformed
export function writeStage(workspace: string, stage: ImportStage): void;   // atomic
export function listStages(workspace: string): ImportStage[];              // newest first; skips malformed files
```

- [ ] **Step 1: Write the failing tests**

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStage, importsDir, listStages, newStageId, readStage, writeStage } from './stage.js';

describe('import stages', () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-import-'));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const init = {
    team: 'dawn',
    project: 'demo',
    created_at: 0,
    source: { path: '/tmp/x.csv', sha256: 'ab', format: 'csv' as const },
    goals: [],
    lanes: [],
    linked_goals: [],
    diagnostics: [],
  };

  it('creates a stage and a .gitignore that ignores everything in the folder', () => {
    const s = createStage(ws, { ...init, created_at: Date.UTC(2026, 9, 10, 13, 5, 9) }, Date.UTC(2026, 9, 10, 13, 5, 9));
    expect(s.id).toMatch(/^20261010-130509-[0-9a-f]{4}$/);
    expect(readFileSync(join(importsDir(ws), '.gitignore'), 'utf8')).toBe('*\n');
    expect(readStage(ws, s.id)).toEqual({ ...s });
    expect(s.created).toEqual({});
    expect(s.saved_at).toBeNull();
  });

  it('round-trips an update atomically', () => {
    const s = createStage(ws, init, 1);
    writeStage(ws, { ...s, created: { 'goal:g': 'g' } });
    expect(readStage(ws, s.id).created).toEqual({ 'goal:g': 'g' });
    expect(existsSync(join(importsDir(ws), `${s.id}.json.tmp-${String(process.pid)}`))).toBe(false);
  });

  it('refuses a missing or malformed stage with a usage error', () => {
    expect(() => readStage(ws, 'nope')).toThrow(/no staged import "nope"/);
    createStage(ws, init, 1);
    writeFileSync(join(importsDir(ws), 'bad.json'), '{"version":9}');
    expect(() => readStage(ws, 'bad')).toThrow(/not a readable staged import/);
  });

  it('lists stages newest first and skips unreadable ones', () => {
    const a = createStage(ws, { ...init, created_at: 1 }, Date.UTC(2026, 0, 1));
    const b = createStage(ws, { ...init, created_at: 2 }, Date.UTC(2026, 0, 2));
    writeFileSync(join(importsDir(ws), 'junk.json'), 'not json');
    expect(listStages(ws).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('makes ids that sort by time', () => {
    expect(newStageId(Date.UTC(2026, 9, 10, 1, 2, 3)) < newStageId(Date.UTC(2026, 9, 10, 1, 2, 4))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/stage.test.ts`
Expected: FAIL — cannot resolve `./stage.js`.

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from '../errors.js';
import { writeJsonAtomic } from '../onboard/atomicWrite.js';
import type { PlannedGoal, PlannedLane } from './check.js';
import type { Diagnostic, ImportFormat } from './rows.js';

/**
 * Staged imports (spec 2026-10-10 §"Step 1"/"Step 2"): what step 1 previewed, saved so step 2 creates
 * exactly that, plus the `created` map that makes a re-run resume instead of duplicate. Workspace-local;
 * `.musterd/` is not wholly gitignored (ADR 058 commits team.toml), so the folder ignores itself.
 */
export const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ImportStage {
  version: 1;
  id: string;
  team: string;
  project: string;
  created_at: number;
  source: { path: string; sha256: string; format: ImportFormat };
  goals: PlannedGoal[];
  lanes: PlannedLane[];
  linked_goals: string[];
  diagnostics: Diagnostic[];
  created: Record<string, string>;
  saved_at: number | null;
}

/** Shape guard for a file read back off disk — enough to refuse garbage, not a second schema of record. */
const StageShape = z
  .object({
    version: z.literal(1),
    id: z.string(),
    team: z.string(),
    project: z.string(),
    created_at: z.number(),
    source: z.object({ path: z.string(), sha256: z.string(), format: z.enum(['csv', 'jsonl']) }),
    goals: z.array(z.object({ ref: z.string(), id: z.string() }).passthrough()),
    lanes: z.array(z.object({ ref: z.string(), title: z.string() }).passthrough()),
    linked_goals: z.array(z.string()),
    diagnostics: z.array(z.object({ level: z.enum(['error', 'warning']) }).passthrough()),
    created: z.record(z.string()),
    saved_at: z.number().nullable(),
  })
  .passthrough();

export function importsDir(workspace: string): string {
  return join(workspace, '.musterd', 'imports');
}

export function newStageId(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}

export function createStage(
  workspace: string,
  init: Omit<ImportStage, 'version' | 'id' | 'created' | 'saved_at'>,
  now: number,
): ImportStage {
  const dir = importsDir(workspace);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const stage: ImportStage = { version: 1, id: newStageId(now), ...init, created: {}, saved_at: null };
  writeStage(workspace, stage);
  return stage;
}

export function writeStage(workspace: string, stage: ImportStage): void {
  writeJsonAtomic(join(importsDir(workspace), `${stage.id}.json`), stage, (v) => StageShape.safeParse(v).success);
}

export function readStage(workspace: string, id: string): ImportStage {
  const path = join(importsDir(workspace), `${id}.json`);
  if (!/^[\w-]+$/.test(id) || !existsSync(path)) {
    throw new CliError(`no staged import "${id}" in this workspace — run \`musterd import list\``, 2);
  }
  const parsed = safeParse(readFileSync(path, 'utf8'));
  if (!parsed) throw new CliError(`${path} is not a readable staged import — re-run \`musterd import <file>\``, 2);
  return parsed;
}

export function listStages(workspace: string): ImportStage[] {
  const dir = importsDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const s = safeParse(readFileSync(join(dir, f), 'utf8'));
      return s ? [s] : [];
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

function safeParse(text: string): ImportStage | null {
  try {
    const r = StageShape.safeParse(JSON.parse(text));
    return r.success ? (r.data as unknown as ImportStage) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/stage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Tree line** under `import/`:

```
    stage.ts          // .musterd/imports/<id>.json: what step 1 previewed + the `created` resume map; writes the folder's own .gitignore (`*`) — .musterd/ is not wholly ignored (ADR 058); atomic writes
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/import/stage.ts packages/cli/src/import/stage.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): import stage files with a resume map (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 5: Resumable save

**Files:**
- Create: `packages/cli/src/import/save.ts`
- Test: `packages/cli/src/import/save.test.ts`
- Modify: `docs/architecture/04-cli.md` (tree)

**Interfaces:**
- Consumes: `ImportStage`, `STAGE_TTL_MS`, `writeStage` (Task 4); `PlannedLane`, `LaneDep` (Task 3);
  `CliError` from `../errors.js`; `DeclareGoal`, `OpenLane` types from `@musterd/protocol`.
- Produces:

```ts
/** The two calls save needs. HttpClient satisfies it structurally. */
export interface SavePort {
  declareGoal(team: string, body: DeclareGoal): Promise<{ id: string }>;
  openLane(team: string, body: OpenLane): Promise<{ lane: { id: string } }>;
}
export function refusal(stage: ImportStage, team: string, now: number): string | null;
export interface SaveResult { goals: { ref: string; id: string; resumed: boolean }[]; lanes: { ref: string; id: string; title: string; resumed: boolean }[] }
export async function saveStage(stage: ImportStage, opts: { team: string; port: SavePort; persist: (s: ImportStage) => void; now: () => number }): Promise<SaveResult>;
```

Behaviour: `refusal` returns the first of — errors present (`N errors — fix the file and re-run
\`musterd import <file>\``), already saved (`already saved <iso time>`), team mismatch (`staged for team
"<a>", this workspace is "<b>"`), expired (`older than 24 hours — re-run \`musterd import <file>\``) — or
null. `saveStage` throws `CliError(<refusal>, 2)` when refused. Then for each goal in order: skip when
`created[ref]` exists, else `declareGoal(team, { id, title, story?, depends_on? })`, set `created[ref]`,
`persist`. Then lanes the same way with `openLane(team, { title, project, detail?, goal_id?, stakes?,
depends_on? })`, mapping `staged` deps through `created` (a staged dep missing from `created` is a bug —
throw `Error`). Finally set `saved_at = now()` and persist. On any thrown error from the port, the
stage already holds every id created so far (persisted per item), and the error propagates.

- [ ] **Step 1: Write the failing tests**

```ts
import type { DeclareGoal, OpenLane } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ImportStage } from './stage.js';
import { refusal, saveStage, type SavePort } from './save.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const base = (): ImportStage => ({
  version: 1,
  id: 's1',
  team: 'dawn',
  project: 'demo',
  created_at: NOW - 1000,
  source: { path: 'x.csv', sha256: 'ab', format: 'csv' },
  goals: [{ ref: 'goal:g', row: 2, id: 'g', title: 'G', depends_on: [] }],
  lanes: [
    { ref: 'lane:a', row: 3, title: 'A', goal_id: 'g', depends_on: [] },
    { ref: 'lane:b', row: 4, title: 'B', goal_id: 'g', depends_on: [{ kind: 'staged', ref: 'lane:a' }, { kind: 'existing', id: 'OLD' }], stakes: 'high' },
  ],
  linked_goals: [],
  diagnostics: [],
  created: {},
  saved_at: null,
});

function fakePort(failOnLane?: string) {
  let n = 0;
  const port: SavePort = {
    declareGoal: vi.fn(async (_t: string, body: DeclareGoal) => ({ id: body.id })),
    openLane: vi.fn(async (_t: string, body: OpenLane) => {
      if (body.title === failOnLane) throw new Error('daemon restarted');
      n += 1;
      return { lane: { id: `L${String(n)}` } };
    }),
  };
  return port;
}

describe('refusal', () => {
  it('refuses errors, saved, other team, expired — in that order', () => {
    expect(refusal({ ...base(), diagnostics: [{ level: 'error', row: 2, code: 'x', message: 'm' }] }, 'dawn', NOW)).toMatch(/1 error/);
    expect(refusal({ ...base(), saved_at: NOW - 5 }, 'dawn', NOW)).toMatch(/already saved/);
    expect(refusal(base(), 'dusk', NOW)).toMatch(/staged for team "dawn", this workspace is "dusk"/);
    expect(refusal({ ...base(), created_at: NOW - 25 * 3600_000 }, 'dawn', NOW)).toMatch(/older than 24 hours/);
    expect(refusal({ ...base(), diagnostics: [{ level: 'warning', row: 2, code: 'x', message: 'm' }] }, 'dawn', NOW)).toBeNull();
  });
});

describe('saveStage', () => {
  it('declares goals then opens lanes in order, mapping staged deps to real ids', async () => {
    const port = fakePort();
    const persisted: ImportStage[] = [];
    const res = await saveStage(base(), { team: 'dawn', port, persist: (s) => persisted.push(structuredClone(s)), now: () => NOW });
    expect(port.declareGoal).toHaveBeenCalledWith('dawn', { id: 'g', title: 'G' });
    expect(port.openLane).toHaveBeenNthCalledWith(1, 'dawn', { title: 'A', project: 'demo', goal_id: 'g' });
    expect(port.openLane).toHaveBeenNthCalledWith(2, 'dawn', { title: 'B', project: 'demo', goal_id: 'g', stakes: 'high', depends_on: ['L1', 'OLD'] });
    expect(res.lanes.map((l) => [l.ref, l.id, l.resumed])).toEqual([['lane:a', 'L1', false], ['lane:b', 'L2', false]]);
    expect(persisted.at(-1)!.saved_at).toBe(NOW);
    expect(persisted.length).toBe(4); // one per create + the final saved_at
  });

  it('resumes after a failure mid-lanes without creating anything twice', async () => {
    let stage = base();
    const first = fakePort('B');
    await expect(saveStage(stage, { team: 'dawn', port: first, persist: (s) => (stage = structuredClone(s)), now: () => NOW })).rejects.toThrow('daemon restarted');
    expect(stage.created).toEqual({ 'goal:g': 'g', 'lane:a': 'L1' });
    expect(stage.saved_at).toBeNull();

    const second: SavePort = { declareGoal: vi.fn(), openLane: vi.fn(async () => ({ lane: { id: 'L9' } })) };
    const res = await saveStage(stage, { team: 'dawn', port: second, persist: (s) => (stage = structuredClone(s)), now: () => NOW });
    expect(second.declareGoal).not.toHaveBeenCalled();
    expect(second.openLane).toHaveBeenCalledTimes(1);
    expect(second.openLane).toHaveBeenCalledWith('dawn', expect.objectContaining({ title: 'B', depends_on: ['L1', 'OLD'] }));
    expect(res.goals[0]!.resumed).toBe(true);
    expect(res.lanes.map((l) => l.resumed)).toEqual([true, false]);
    expect(stage.saved_at).toBe(NOW);
  });

  it('creates nothing when refused', async () => {
    const port = fakePort();
    await expect(saveStage(base(), { team: 'dusk', port, persist: () => {}, now: () => NOW })).rejects.toThrow(/dusk/);
    expect(port.declareGoal).not.toHaveBeenCalled();
    expect(port.openLane).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/save.test.ts`
Expected: FAIL — cannot resolve `./save.js`.

- [ ] **Step 3: Implement**

```ts
import type { DeclareGoal, OpenLane } from '@musterd/protocol';
import { CliError } from '../errors.js';
import type { LaneDep } from './check.js';
import { STAGE_TTL_MS, type ImportStage } from './stage.js';

/**
 * Step 2 of `musterd import` (spec 2026-10-10 §"Step 2"): goals, then lanes, in the order the stage
 * holds; each new id is persisted before the next call, so a re-run skips what exists and never
 * creates a row twice.
 */
export interface SavePort {
  declareGoal(team: string, body: DeclareGoal): Promise<{ id: string }>;
  openLane(team: string, body: OpenLane): Promise<{ lane: { id: string } }>;
}

export interface SaveResult {
  goals: { ref: string; id: string; resumed: boolean }[];
  lanes: { ref: string; id: string; title: string; resumed: boolean }[];
}

export function refusal(stage: ImportStage, team: string, now: number): string | null {
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  if (errors > 0) return `${String(errors)} error${errors === 1 ? '' : 's'} — fix the file and re-run \`musterd import <file>\``;
  if (stage.saved_at !== null) return `already saved ${new Date(stage.saved_at).toISOString()}`;
  if (stage.team !== team) return `staged for team "${stage.team}", this workspace is "${team}" — re-run \`musterd import <file>\` here`;
  if (now - stage.created_at > STAGE_TTL_MS) return 'older than 24 hours — re-run `musterd import <file>` to check it against the board again';
  return null;
}

export async function saveStage(
  input: ImportStage,
  opts: { team: string; port: SavePort; persist: (s: ImportStage) => void; now: () => number },
): Promise<SaveResult> {
  const why = refusal(input, opts.team, opts.now());
  if (why) throw new CliError(`import ${input.id} not saved: ${why}`, 2);
  const stage: ImportStage = { ...input, created: { ...input.created } };
  const result: SaveResult = { goals: [], lanes: [] };

  for (const g of stage.goals) {
    const have = stage.created[g.ref];
    if (have) {
      result.goals.push({ ref: g.ref, id: have, resumed: true });
      continue;
    }
    const body: DeclareGoal = { id: g.id, title: g.title };
    if (g.story) body.story = g.story;
    if (g.depends_on.length > 0) body.depends_on = g.depends_on;
    const goal = await opts.port.declareGoal(opts.team, body);
    stage.created[g.ref] = goal.id;
    opts.persist(stage);
    result.goals.push({ ref: g.ref, id: goal.id, resumed: false });
  }

  for (const l of stage.lanes) {
    const have = stage.created[l.ref];
    if (have) {
      result.lanes.push({ ref: l.ref, id: have, title: l.title, resumed: true });
      continue;
    }
    const body: OpenLane = { title: l.title, project: stage.project };
    if (l.detail) body.detail = l.detail;
    if (l.goal_id) body.goal_id = l.goal_id;
    if (l.stakes) body.stakes = l.stakes;
    if (l.depends_on.length > 0) body.depends_on = l.depends_on.map((d) => resolveDep(d, stage));
    const res = await opts.port.openLane(opts.team, body);
    stage.created[l.ref] = res.lane.id;
    opts.persist(stage);
    result.lanes.push({ ref: l.ref, id: res.lane.id, title: l.title, resumed: false });
  }

  stage.saved_at = opts.now();
  opts.persist(stage);
  return result;
}

function resolveDep(d: LaneDep, stage: ImportStage): string {
  if (d.kind === 'existing') return d.id;
  const id = stage.created[d.ref];
  if (!id) throw new Error(`import ${stage.id}: ${d.ref} was not created before a lane that depends on it`);
  return id;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/import/save.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Tree line** under `import/`:

```
    save.ts           // step 2: refusals (errors / saved / other team / >24h), then goals → lanes through a two-call port (HttpClient fits), persisting each new id before the next call so a re-run resumes, never duplicates
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/import/save.ts packages/cli/src/import/save.test.ts docs/architecture/04-cli.md
git commit -m "feat(cli): resumable import save (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 6: The `musterd import` command

**Files:**
- Create: `packages/cli/src/import/render.ts`
- Create: `packages/cli/src/commands/import.ts`
- Test: `packages/cli/src/commands/import.test.ts`
- Modify: `packages/cli/src/commandTable.ts` (after `huddle`/before `inbox`, alphabetical)
- Modify: `packages/cli/src/help/catalog.ts` (the Work & lanes group, after `seed`)
- Modify: `docs/architecture/04-cli.md` (tree: `import/render.ts`, `commands/import.ts`)

**Interfaces:**
- Consumes: Tasks 1–5; `resolve(flags)` from `./helpers.js` (returns `{ team, http, … }`);
  `findWorkspaceDir()` from `./helpers.js`; `resolveProject` from `@musterd/protocol/project`;
  `http.goals(team)`, `http.laneBoard(team, { history: true })`; `theme` from `../render/theme.js`.
- Produces: `export async function importCommand(parsed: Parsed): Promise<number>`;
  `render.ts` exports `renderPreview(stage: ImportStage): string`, `renderSaved(stage: ImportStage, r: SaveResult, liveUrl: string): string`,
  `renderList(stages: ImportStage[], now: number): string`.

Command behaviour:
- `musterd import <file>` — read file (missing file → `CliError('cannot read <file>', 2)`), sha256 it,
  `parseImportFile`, fetch `goals` + `laneBoard({history:true})`, `checkAgainstBoard`, `createStage`
  with row diagnostics followed by board diagnostics, print `renderPreview`. Exit **0** when the stage has
  no errors, **1** when it has errors (the stage is still written, so `import list` shows it).
- `musterd import save <id>` — `readStage`, `saveStage` with `port: http`,
  `persist: (s) => writeStage(ws, s)`, `now: Date.now`; print `renderSaved`. Refusal → exit 2.
- `musterd import list` — `renderList(listStages(ws), Date.now())`.
- No workspace (`findWorkspaceDir()` null) → `CliError('musterd import needs a musterd workspace — run musterd init here first', 2)`.
- The live URL is `${server}/live?team=${team}`, where `server` is the resolved HTTP server base
  (check `Resolved`/`http` for the field the other commands print; `grep -rn "live?team" packages/cli/src`
  and reuse that helper).

Preview layout (`renderPreview`), plain text, theme colours only for ✓/✗/⚠:

```
import 20261010-130509-a1f2 — 2 goals, 5 lanes from backlog.csv (team dawn, project demo)

◆ first-run  First run (new)
    ○ Import command  · high
    ○ Skill  · after: Import command
◆ launch (on the board — linked, not re-declared)
    ○ Write the post
no goal
    ○ Tidy the README

⚠ line 6: lane has no goal
✗ line 9: lane dependency "01M4FD" is not a lane key in this file or a lane on the board (use the full lane id)

✗ 1 error — fix the file and re-run `musterd import backlog.csv`
```

and when clean, the last line is `next: musterd import save 20261010-130509-a1f2`.

- [ ] **Step 1: Write the failing end-to-end tests** (in-memory server, the `seed.test.ts` harness:
copy its `beforeEach`/`afterEach`/`capture` verbatim, team `dawn`, agent seat `Ada`; additionally write
the CSV into `dir`).

```ts
// …harness from seed.test.ts (createServer, team create dawn, add Ada, claimAgentHttp, saveBinding)…
import { importCommand } from './import.js';
import { listStages } from '../import/stage.js';

const CSV =
  'kind,key,title,goal,depends_on,stakes\n' +
  'goal,first-run,First run,,,\n' +
  'lane,a,Import command,first-run,,high\n' +
  'lane,b,Skill,first-run,a,\n';

it('previews, stages, then saves goals and lanes', async () => {
  writeFileSync(join(dir, 'backlog.csv'), CSV);
  const preview = await capture(() => importCommand(parseArgs(['backlog.csv'])));
  expect(preview.code).toBe(0);
  expect(preview.out).toContain('1 goal, 2 lanes');
  const [stage] = listStages(dir);
  expect(preview.out).toContain(`next: musterd import save ${stage!.id}`);

  // nothing on the board yet
  const http = clientForAda(); // HttpClient as Ada, built the way seed.test.ts builds nick's
  expect((await http.laneBoard('dawn')).lanes).toEqual([]);

  const saved = await capture(() => importCommand(parseArgs(['save', stage!.id])));
  expect(saved.code).toBe(0);
  expect(saved.out).toMatch(/✓ 1 goal, 2 lanes/);
  const lanes = (await http.laneBoard('dawn')).lanes;
  const a = lanes.find((l) => l.title === 'Import command')!;
  const b = lanes.find((l) => l.title === 'Skill')!;
  expect(a).toMatchObject({ state: 'open', owner_seat: null, goal_id: 'first-run', stakes: 'high' });
  expect(b.depends_on).toEqual([a.id]);
  expect((await http.goals('dawn')).goals.map((g) => g.id)).toContain('first-run');
});

it('exits 1 on errors and refuses to save that stage', async () => {
  writeFileSync(join(dir, 'bad.csv'), 'kind,title,goal\nlane,X,missing-goal\n');
  const preview = await capture(() => importCommand(parseArgs(['bad.csv'])));
  expect(preview.code).toBe(1);
  expect(preview.out).toContain('1 error');
  const [stage] = listStages(dir);
  await expect(importCommand(parseArgs(['save', stage!.id]))).rejects.toThrow(/1 error/);
});

it('links an existing goal without re-declaring it', async () => {
  const http = clientForAda();
  await http.declareGoal('dawn', { id: 'first-run', title: 'Original title', story: 'Original story' });
  writeFileSync(join(dir, 'b.csv'), 'kind,key,title,goal\ngoal,first-run,New title,\nlane,,L,first-run\n');
  const preview = await capture(() => importCommand(parseArgs(['b.csv'])));
  expect(preview.out).toContain('linked, not re-declared');
  const [stage] = listStages(dir);
  await capture(() => importCommand(parseArgs(['save', stage!.id])));
  const goal = (await http.goals('dawn')).goals.find((g) => g.id === 'first-run')!;
  expect(goal.title).toBe('Original title');
});

it('lists staged imports', async () => {
  writeFileSync(join(dir, 'backlog.csv'), CSV);
  await capture(() => importCommand(parseArgs(['backlog.csv'])));
  const out = await capture(() => importCommand(parseArgs(['list'])));
  expect(out.out).toMatch(/backlog\.csv · 1 goal, 2 lanes · ready to save/);
});
```

`clientForAda()` is a small local helper in the test file:
`new HttpClient({ server: process.env['MUSTERD_SERVER']!, key: adaAuth.key, seat: 'Ada' })` — adapt the
fields to what `seed.test.ts`'s construction of a client needs (it builds nick's with `key` + `seat`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/cli exec vitest run src/commands/import.test.ts`
Expected: FAIL — cannot resolve `./import.js`.

- [ ] **Step 3: Implement `render.ts`**

```ts
import { theme } from '../render/theme.js';
import type { PlannedLane } from './check.js';
import type { Diagnostic } from './rows.js';
import type { SaveResult } from './save.js';
import { STAGE_TTL_MS, type ImportStage } from './stage.js';

const n = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function renderPreview(stage: ImportStage): string {
  const out: string[] = [];
  out.push(
    `${theme.accent(`import ${stage.id}`)} — ${n(stage.goals.length, 'goal')}, ${n(stage.lanes.length, 'lane')} ` +
      `from ${base(stage.source.path)} ${theme.meta(`(team ${stage.team}, project ${stage.project})`)}`,
    '',
  );
  const titleOf = new Map(stage.lanes.map((l) => [l.ref, l.title]));
  const laneLine = (l: PlannedLane) => {
    const bits = [l.stakes ? l.stakes : null, l.depends_on.length ? `after: ${l.depends_on.map((d) => (d.kind === 'staged' ? titleOf.get(d.ref) ?? d.ref : d.id)).join(', ')}` : null].filter(Boolean);
    return `    ○ ${l.title}${bits.length ? theme.meta(`  · ${bits.join(' · ')}`) : ''}`;
  };
  for (const g of stage.goals) {
    out.push(`◆ ${g.id}  ${g.title} ${theme.meta('(new)')}`);
    for (const l of stage.lanes.filter((x) => x.goal_id === g.id)) out.push(laneLine(l));
  }
  const planned = new Set(stage.goals.map((g) => g.id));
  const others = [...new Set(stage.lanes.map((l) => l.goal_id).filter((id): id is string => !!id && !planned.has(id)))];
  for (const id of others) {
    const linked = stage.linked_goals.includes(id);
    out.push(`◆ ${id} ${theme.meta(linked ? '(on the board — linked, not re-declared)' : '(on the board)')}`);
    for (const l of stage.lanes.filter((x) => x.goal_id === id)) out.push(laneLine(l));
  }
  const loose = stage.lanes.filter((l) => !l.goal_id);
  if (loose.length) {
    out.push(theme.meta('no goal'));
    for (const l of loose) out.push(laneLine(l));
  }
  if (stage.diagnostics.length) out.push('', ...stage.diagnostics.map(renderDiagnostic));
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  out.push(
    '',
    errors > 0
      ? `${theme.err('✗')} ${n(errors, 'error')} — fix the file and re-run \`musterd import ${base(stage.source.path)}\``
      : `next: musterd import save ${stage.id}`,
  );
  return out.join('\n');
}

function renderDiagnostic(d: Diagnostic): string {
  const mark = d.level === 'error' ? theme.err('✗') : theme.warn('⚠');
  return `${mark} ${d.row === null ? 'file' : `line ${String(d.row)}`}: ${d.message}`;
}

export function renderSaved(stage: ImportStage, r: SaveResult, liveUrl: string): string {
  const resumed = [...r.goals, ...r.lanes].filter((x) => x.resumed).length;
  const lines = [
    `${theme.ok('✓')} ${n(r.goals.length, 'goal')}, ${n(r.lanes.length, 'lane')} saved from import ${stage.id}` +
      (resumed ? theme.meta(` (${String(resumed)} already created by an earlier run)`) : ''),
    ...r.goals.map((g) => `  ◆ ${g.id}`),
    ...r.lanes.map((l) => `  ○ ${l.id}  ${l.title}`),
    '',
    `see them: ${liveUrl}  ·  musterd next`,
  ];
  if (stage.linked_goals.length) lines.splice(1, 0, theme.meta(`  linked to existing: ${stage.linked_goals.join(', ')}`));
  return lines.join('\n');
}

export function renderList(stages: ImportStage[], now: number): string {
  if (stages.length === 0) return theme.meta('no staged imports in this workspace — `musterd import <file>` stages one');
  return stages
    .map((s) => {
      const errors = s.diagnostics.filter((d) => d.level === 'error').length;
      const state =
        s.saved_at !== null ? 'saved'
        : errors > 0 ? `${n(errors, 'error')}`
        : now - s.created_at > STAGE_TTL_MS ? 'expired — re-run'
        : 'ready to save';
      return `${s.id}  ${base(s.source.path)} · ${n(s.goals.length, 'goal')}, ${n(s.lanes.length, 'lane')} · ${state}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Implement `commands/import.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveProject } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { checkAgainstBoard } from '../import/check.js';
import { renderList, renderPreview, renderSaved } from '../import/render.js';
import { formatFor, parseImportFile } from '../import/rows.js';
import { saveStage } from '../import/save.js';
import { createStage, listStages, readStage, writeStage } from '../import/stage.js';
import { findWorkspaceDir, resolve } from './helpers.js';

const USAGE =
  'usage:\n' +
  '  musterd import <file.csv|file.jsonl>   check against the board, preview, and stage (creates nothing)\n' +
  '  musterd import save <id>               create the staged goals and lanes (re-run resumes)\n' +
  '  musterd import list                    staged imports in this workspace';

/** `musterd import` (spec 2026-10-10 "bring work in"): two steps — preview+stage, then save. */
export async function importCommand(parsed: Parsed): Promise<number> {
  const [first, second] = parsed.positionals;
  if (!first) throw new CliError(USAGE, 2);
  const ws = findWorkspaceDir();
  if (!ws) throw new CliError('musterd import needs a musterd workspace — run `musterd init` here first', 2);

  if (first === 'list') {
    process.stdout.write(renderList(listStages(ws), Date.now()) + '\n');
    return 0;
  }

  const { team, http } = resolve(parsed.flags);

  if (first === 'save') {
    if (!second) throw new CliError(USAGE, 2);
    const stage = readStage(ws, second);
    const result = await saveStage(stage, { team, port: http, persist: (s) => writeStage(ws, s), now: Date.now });
    process.stdout.write(renderSaved(readStage(ws, stage.id), result, liveUrlFor(http, team)) + '\n');
    return 0;
  }

  const path = resolvePath(first);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`cannot read ${first}`, 2);
  }
  const format = formatFor(path);
  const { rows, diagnostics: rowDiagnostics } = parseImportFile(text, format);
  const [goals, board] = await Promise.all([http.goals(team), http.laneBoard(team, { history: true })]);
  const plan = checkAgainstBoard(rows, { goals: goals.goals, lanes: board.lanes });
  const stage = createStage(
    ws,
    {
      team,
      project: resolveProject({ explicit: flagStr(parsed.flags, 'project') }),
      created_at: Date.now(),
      source: { path, sha256: createHash('sha256').update(text).digest('hex'), format },
      goals: plan.goals,
      lanes: plan.lanes,
      linked_goals: plan.linkedGoals,
      diagnostics: [...rowDiagnostics, ...plan.diagnostics],
    },
    Date.now(),
  );
  process.stdout.write(renderPreview(stage) + '\n');
  return stage.diagnostics.some((d) => d.level === 'error') ? 1 : 0;
}
```

`liveUrlFor(http, team)`: before writing it, run `grep -rn "live?team" packages/cli/src` and reuse the
existing helper that builds the `/live?team=` link; if none exists, define it in this file as
``(http, team) => `${http.server}/live?team=${encodeURIComponent(team)}` `` using whatever public field
`HttpClient` exposes for its base URL (check the class; do not add a new public field without need).
`--project` overrides the derived project exactly as `lane open` does (same `resolveProject` call).

- [ ] **Step 5: Register the command and its help**

`commandTable.ts`, alphabetical:

```ts
  import: async () => (await import('./commands/import.js')).importCommand,
```

`help/catalog.ts`, after the `seed` entry:

```ts
  {
    name: 'import',
    signature: '<file.csv|file.jsonl>  |  save <id>  |  list',
    summary: 'bring existing work in: preview a file of goals and lanes, then save it',
    group: 'work',
    detail:
      'Two steps (spec 2026-10-10 "bring work in"). `import <file>` checks every row against the board,\n' +
      'prints what it would create, and stages it in .musterd/imports/ — it creates nothing.\n' +
      '`import save <id>` creates exactly the staged goals, then lanes, unclaimed; a re-run after a\n' +
      'failure resumes and never duplicates. A goal already on the board is linked, not re-declared.\n' +
      'Columns: kind (goal|lane), key, title, detail, story, goal, depends_on (;-separated), stakes, source_ref.\n' +
      'The musterd-import skill writes this file for you from the repo or GitHub issues.',
    examples: ['musterd import backlog.csv', 'musterd import save 20261010-130509-a1f2', 'musterd import list'],
  },
```

- [ ] **Step 6: Run the command tests and the table/catalog tests**

Run: `pnpm --filter @musterd/cli exec vitest run src/commands/import.test.ts src/commandTable.test.ts src/help/catalog.test.ts`
Expected: PASS.

- [ ] **Step 7: Tree lines** in `04-cli.md` — under `import/`:

```
    render.ts         // preview (goals → lanes, linked goals, no-goal lanes, diagnostics, the one next step), save result, list
```

and under `commands/`, after `huddle.ts`:

```
    import.ts         // `musterd import <file>` (check + preview + stage, exit 1 on errors) | `save <id>` (resumable) | `list` — spec 2026-10-10 "bring work in"; save goes through HttpClient.declareGoal/openLane, no protocol change
```

Run: `pnpm arch-trees:check` — Expected: ✓.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/import/render.ts packages/cli/src/commands/import.ts packages/cli/src/commands/import.test.ts packages/cli/src/commandTable.ts packages/cli/src/help/catalog.ts docs/architecture/04-cli.md
git commit -m "feat(cli): musterd import — preview and stage, then save (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 7: The `musterd-import` skill

**Files:**
- Modify: `packages/protocol/src/guidance.ts` (renderers, version 47, `SKILL_CLI_COMMANDS`)
- Modify: `packages/protocol/src/guidance.test.ts` (snapshot 47 + content tests)
- Modify: `packages/cli/src/onboard/harness.ts:185-209` (`importSkillPath?`)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts:1045`, `cursor.ts:316`, `grok.ts:408`
- Modify: `packages/cli/src/onboard/guidance.ts` (write, targets, file map, canonical map, remove dirs)
- Test: `packages/cli/src/onboard/guidance.test.ts`
- Modify: `docs/architecture/04-cli.md` only if a line describing `guidance.ts` or a harness lists its
  skill paths (grep `musterd-orient` in the doc and extend those lines the same way)

**Interfaces:**
- Produces (protocol): `export function renderImportSkill(): string`,
  `export function renderImportFrontmatter(): string`; `'import'` appended to `SKILL_CLI_COMMANDS`;
  `GUIDANCE_CONTENT_VERSION = 47`.
- Produces (cli): `HarnessGuidance.importSkillPath?: string`;
  `export const CANONICAL_IMPORT_PATH = '.musterd/skill/import.md'`.
- Paths: Claude Code `.claude/skills/musterd-import/SKILL.md`; Cursor `.cursor/rules/musterd-import.mdc`;
  Grok `.grok/skills/musterd-import/SKILL.md`; Codex and opencode read the canonical file (as they do for
  orient, ADR 333).

- [ ] **Step 1: Write the failing protocol tests** (append to `guidance.test.ts`; import the two new
renderers at the top):

```ts
describe('musterd-import skill (spec 2026-10-10 "bring work in")', () => {
  const skill = renderImportSkill();

  it('makes the save a human checkpoint', () => {
    expect(skill).toContain('`musterd import save <id>` only after the human says yes');
    expect(skill).toMatch(/never save an import you previewed yourself without that yes/);
  });

  it('names both sources, the cap and the fallback when gh is missing', () => {
    expect(skill).toContain('gh issue list --state open');
    expect(skill).toMatch(/about 5 goals and 30 lanes/);
    expect(skill).toMatch(/If `gh` is missing or not signed in, say so and continue with the repo scan/);
  });

  it('names the file columns', () => {
    for (const col of ['kind', 'key', 'title', 'detail', 'story', 'goal', 'depends_on', 'stakes', 'source_ref']) {
      expect(skill).toContain(`\`${col}\``);
    }
  });

  it('has frontmatter named musterd-import', () => {
    expect(renderImportFrontmatter()).toMatch(/^---\nname: musterd-import\ndescription: /);
  });
});
```

Add `renderImportSkill(), renderImportFrontmatter()` to the end of the `rendered` array in the
version-bump snapshot test and to the `surface` array in "the wall" test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/protocol exec vitest run src/guidance.test.ts`
Expected: FAIL — `renderImportSkill` is not exported.

- [ ] **Step 3: Implement the renderers** in `guidance.ts`, after `renderOrientFrontmatter`:

```ts
/**
 * The `musterd-import` skill (spec 2026-10-10 "bring work in", lane 01M4FDBSN8): the agent half of
 * `musterd import`. It writes the import file from the repo or GitHub issues; the CLI checks, previews,
 * stages and saves. The save is the human's checkpoint.
 */
export function renderImportSkill(): string {
  return [
    '# Bring existing work in',
    '',
    "Turn a team's existing work into goals and lanes on the board, in two steps the human can see.",
    'Use it on a new team, or when the human asks to bring a repo, a backlog or a plan in.',
    '',
    '1. **Ask what to bring in:** this repo, its GitHub issues, something the human pastes, or new',
    '   work to plan. Ask once; do not start reading before you know.',
    '2. **Gather it.**',
    '   - **This repo:** the README, ROADMAP and TODO files, plan and spec docs, a `TODO`/`FIXME`',
    '     search grouped into themes (never one lane per comment), unmerged branches, and recent',
    '     commits for work in progress. Themes become goals; concrete pieces of work become lanes.',
    '   - **GitHub issues:** `gh issue list --state open --limit 200 --json',
    '     number,title,body,labels,milestone,url`. Milestones, or else the main labels, become goals;',
    '     each issue becomes a lane with `source_ref` `github#<number>` and the URL in `detail`.',
    '     If `gh` is missing or not signed in, say so and continue with the repo scan.',
    '   - **Pasted text:** one lane per item the human listed; ask before inventing goals for it.',
    '3. **Keep the first import small:** about 5 goals and 30 lanes. Tell the human what you left out',
    '   and why, so they can bring it in later.',
    '4. **Write the file** to `.musterd/imports/draft-<time>.csv`. Columns: `kind` (goal or lane),',
    '   `key` (required for a goal: lowercase-with-dashes, it becomes the goal id; optional for a',
    '   lane, so other lanes can depend on it), `title`, `detail` (lanes: say where you found it),',
    '   `story` (goals: one plain line, at most 140 characters), `goal` (a goal key from the file or',
    '   an existing goal id), `depends_on` (keys or full lane ids, separated by `;`), `stakes` (low,',
    '   normal or high), `source_ref`. Leave owners, scope and risk out: imported lanes open',
    '   unclaimed, and whoever claims one decides those.',
    '5. **Preview:** run `musterd import <file>` and show the human the whole preview. Fix every ✗',
    '   and re-run until it is clean; explain each ⚠ (an existing goal is linked, not re-declared;',
    '   a likely duplicate may already be on the board).',
    '6. **Save:** run `musterd import save <id>` only after the human says yes to that preview.',
    '   The two steps are the human\'s checkpoint: never save an import you previewed yourself',
    '   without that yes. If the save stops partway, run the same command again; it resumes.',
    '7. **Afterwards:** point the human at the board (`musterd next`, or the /live link the save',
    '   printed). Do not claim the imported lanes unless the human asks you to.',
    '',
  ].join('\n');
}

/** Frontmatter for {@link renderImportSkill} on a harness that gates skills on a description. */
export function renderImportFrontmatter(): string {
  return [
    '---',
    'name: musterd-import',
    'description: Bring existing work onto the musterd board as goals and lanes: scan this repo or ' +
      'its GitHub issues, write an import file, preview it with `musterd import`, and save only after ' +
      'the human says yes. Use on a new team or when asked to bring a backlog or plan in.',
    '---',
  ].join('\n');
}
```

Set `export const GUIDANCE_CONTENT_VERSION = 47;` and append `'import'` to `SKILL_CLI_COMMANDS`.

- [ ] **Step 4: Run, read the new hash, record it**

Run: `pnpm --filter @musterd/protocol exec vitest run src/guidance.test.ts`
Expected: the snapshot test FAILS with `expected '<new hash>' to be undefined`/mismatch. Add
`47: '<new hash>', // + musterd-import skill unit (spec 2026-10-10 "bring work in", lane 01M4FDBSN8)` to
`SNAPSHOTS`, re-run, Expected: PASS. Run `pnpm guidance:check` — Expected: ✓ (`import` is in the
catalog since Task 6).

- [ ] **Step 5: Write the failing CLI guidance test** (append to
`packages/cli/src/onboard/guidance.test.ts`; follow how that file builds a temp dir and harness list for
the orient skill — grep `orientSkillPath` there and mirror the nearest test):

```ts
it('writes the musterd-import skill canonically and per harness, and removes it on uninstall', () => {
  const res = writeGuidance(dir, [claudeCodeHarness, cursorHarness], { team: 'dawn' });
  expect(res.files).toEqual(expect.arrayContaining([
    '.musterd/skill/import.md',
    '.claude/skills/musterd-import/SKILL.md',
    '.cursor/rules/musterd-import.mdc',
  ]));
  expect(readFileSync(join(dir, '.claude/skills/musterd-import/SKILL.md'), 'utf8')).toMatch(/^---\nname: musterd-import/);
  expect(guidanceTargets([claudeCodeHarness])).toContain('.claude/skills/musterd-import/SKILL.md');
  removeGuidance(dir, [claudeCodeHarness, cursorHarness]);
  expect(existsSync(join(dir, '.claude/skills/musterd-import'))).toBe(false);
});
```

(`claudeCodeHarness`/`cursorHarness`: use the same imports or fixtures the existing orient tests use.)

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/guidance.test.ts` — Expected: FAIL.

- [ ] **Step 6: Implement the CLI side**

`harness.ts`, in `HarnessGuidance` after `orientSkillPath`:

```ts
  /** The `musterd-import` skill (spec 2026-10-10 "bring work in"), beside orient on the same harnesses. */
  importSkillPath?: string;
```

`claudeCode.ts` / `cursor.ts` / `grok.ts`, next to each `orientSkillPath`:

```ts
    importSkillPath: '.claude/skills/musterd-import/SKILL.md',   // claudeCode.ts
    importSkillPath: '.cursor/rules/musterd-import.mdc',          // cursor.ts
    importSkillPath: '.grok/skills/musterd-import/SKILL.md',      // grok.ts
```

`onboard/guidance.ts`:

```ts
export const CANONICAL_IMPORT_PATH = '.musterd/skill/import.md';

function importSkillFile(flavor: 'claude-code' | 'cursor' | 'canonical'): string {
  if (flavor === 'canonical') return renderImportSkill();
  if (flavor === 'cursor') {
    return [
      '---',
      'description: Bring existing work onto the musterd board as goals and lanes: scan this repo or ' +
        'its GitHub issues, write an import file, preview it with `musterd import`, and save only ' +
        'after the human says yes.',
      'alwaysApply: false',
      '---',
      '',
      renderImportSkill(),
    ].join('\n');
  }
  return `${renderImportFrontmatter()}\n\n${renderImportSkill()}`;
}
```

and, mirroring each orient line exactly:
- `writeGuidance`: after the canonical orient write,
  `writeOne(dir, CANONICAL_IMPORT_PATH, importSkillFile('canonical'), force, written, skipped);` and in the
  per-harness loop `if (g.importSkillPath) writeOne(dir, g.importSkillPath, importSkillFile(g.frontmatter), force, written, skipped);`
- `guidanceTargets`: seed the set with `CANONICAL_IMPORT_PATH`; `if (g.importSkillPath) paths.add(g.importSkillPath);`
- `guidanceFileMap`: `if (g.importSkillPath) out[g.importSkillPath] = stamped(importSkillFile(g.frontmatter));`
- `canonicalGuidanceMap`: `[CANONICAL_IMPORT_PATH]: stamped(importSkillFile('canonical')),`
- `removeGuidance`: add `'.claude/skills/musterd-import'` to the tidy-dirs list.

Import `renderImportSkill`, `renderImportFrontmatter` from `@musterd/protocol` alongside the orient
renderers.

- [ ] **Step 7: Run the guidance tests and the doctor test**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/guidance.test.ts src/onboard/doctor.test.ts`
Expected: PASS. If `doctor.test.ts` pins an exact expected-file list, add the import paths to it — that
list is the doctor's expectation, and it must match what `writeGuidance` writes (ADR 171).

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/guidance.ts packages/protocol/src/guidance.test.ts packages/cli/src/onboard docs/architecture/04-cli.md
git commit -m "feat(guidance): musterd-import skill, installed beside musterd-orient (lane 01M4FDBSN8)

GUIDANCE_CONTENT_VERSION 46 → 47 (ADR 085).

Co-authored-by: dolly <dolly@revive.musterd>"
```

---

### Task 8: README, gates, PR

**Files:**
- Modify: `README.md` (Quickstart, after the `musterd init` paragraph)

- [ ] **Step 1: Add the last quickstart step** after the paragraph that ends "…the instant your agent
connects.":

```markdown
Then bring your work in: ask your agent to **"bring this repo's work into musterd"**. Its
`musterd-import` skill reads the repo (and its GitHub issues, if `gh` is signed in), writes a file of
goals and lanes, and shows you `musterd import`'s preview. Nothing is created until you say yes and it
runs `musterd import save`. You can also fill in a CSV yourself — see `musterd help import`.
```

- [ ] **Step 2: Fast gates**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all ✓. Fix `import/order` lint findings in the new files as reported.

- [ ] **Step 3: Commit, push, PR with auto-merge**

```bash
git add README.md
git commit -m "docs(readme): quickstart ends with bringing your work in (lane 01M4FDBSN8)

Co-authored-by: dolly <dolly@revive.musterd>"
git fetch origin main && git rebase origin/main
git push -u origin HEAD
gh pr create --title "feat: musterd import — bring existing work in (lane 01M4FDBSN8)" --body "Lane \`01M4FDBSN8JKWV6GJQ7C3VB888\`.

Phase 1 of docs/superpowers/specs/2026-10-10-bring-work-in-design.md: \`musterd import <file>\` checks a CSV/JSONL of goals and lanes against the board, previews and stages it; \`musterd import save <id>\` creates goals then lanes, resumably. The \`musterd-import\` skill (installed by init beside musterd-orient) writes the file from a repo scan or GitHub issues. No protocol change; guidance version 47.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 4: Acceptance run (after merge and the daemon's autorefresh)**

On a real repo with open GitHub issues: a fresh team (`musterd init` in a scratch clone, isolated with
`MUSTERD_CONFIG`/`MUSTERD_DB`/`MUSTERD_PORT` per AGENTS.md "Running the CLI from source"), ask the agent
to bring the work in, approve the preview, and confirm lanes for the real issues appear on the board in
one session. Record the wall time and what the preview showed in the lane's submit note, then
`lane_submit` with `{pr, sha, authorized_by: 'nick'}` and follow its reply (ADR 235).
