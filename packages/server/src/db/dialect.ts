/**
 * SQLite-flavoured SQL text → Postgres text, once per distinct statement (ADR 479 §4). This file is
 * budgeted: under DIALECT_SOURCE_LINE_BUDGET lines, or the two-backend decision is revisited. Rules
 * cover exactly what the Q4 inventory found (docs/perf/pglite-spike.md); anything SQLite-only that
 * the inventory found zero of throws, so a new use fails in the PGlite run rather than in Cloud.
 */
export const DIALECT_SOURCE_LINE_BUDGET = 300;

export class DialectError extends Error {
  constructor(construct: string, sql: string) {
    super(
      `SQLite-only construct "${construct}" has no Postgres rewrite here: ${sql.slice(0, 120)}`,
    );
    this.name = 'DialectError';
  }
}

const REFUSED: Array<[string, RegExp]> = [
  ['INSERT OR REPLACE', /\bINSERT\s+OR\s+REPLACE\b/i],
  ['datetime(', /\bdatetime\s*\(/i],
  ['strftime', /\bstrftime\s*\(/i],
  ['unixepoch', /\bunixepoch\b/i],
  ['GLOB', /\bGLOB\b/],
  ['iif(', /\biif\s*\(/i],
  ['COLLATE NOCASE', /\bCOLLATE\s+NOCASE\b/i],
  ['last_insert_rowid', /\blast_insert_rowid\s*\(/i],
];

const cache = new Map<string, string>();

export function toPostgres(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  const out = translate(sql);
  cache.set(sql, out);
  return out;
}

/** Split into [code, literal, code, literal, …] so rewrites never touch string literals. */
function outsideLiterals(sql: string, fn: (code: string) => string): string {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');
}

function jsonPath(path: string): { op: '->>' | '#>>'; rhs: string } {
  const keys = path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  return keys.length <= 1
    ? { op: '->>', rhs: `'${keys[0] ?? ''}'` }
    : { op: '#>>', rhs: `'{${keys.join(',')}}'` };
}

// `= 1` / `<> 0` against a JSON value is how the store asks "is this flag set" — and the flag may
// be stored as JSON true/false as well as 1/0. Compared as jsonb so both spellings qualify; an
// ordering comparison (<, >=, …) still casts the text to numeric.
const FLAG_LITERAL: Record<string, string> = {
  '1': "('1'::jsonb, 'true'::jsonb)",
  '0': "('0'::jsonb, 'false'::jsonb)",
};

// json_extract(col, '$.path') [op numeric-literal] — the literal decides the cast.
const JSON_X =
  /json_extract\(\s*([A-Za-z_][\w.]*)\s*,\s*'(\$[^']*)'\s*\)(\s*(=|<>|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)(?![\w.]))?/g;

/**
 * SQLite's two-argument scalar MAX/MIN are Postgres GREATEST/LEAST; the one-argument aggregates
 * stay. Arguments are found by balanced parentheses — a nested call or a rewritten json_extract is
 * one argument — skipping string literals, and rewritten innermost first.
 */
function scalarMaxMin(sql: string): string {
  const re = /\b(MAX|MIN)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const open = m.index + m[0].length - 1;
    const args: string[] = [];
    let depth = 0;
    let start = open + 1;
    let i = open;
    for (; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'") {
        i = sql.indexOf("'", i + 1);
        if (i < 0) return sql;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
      else if (c === ',' && depth === 1) {
        args.push(sql.slice(start, i));
        start = i + 1;
      }
    }
    if (i >= sql.length) return sql;
    args.push(sql.slice(start, i));
    if (args.length !== 2) continue;
    const inner = args.map((a) => scalarMaxMin(a.trim())).join(', ');
    const fn = m[1] === 'MAX' ? 'GREATEST' : 'LEAST';
    sql = `${sql.slice(0, m.index)}${fn}(${inner})${sql.slice(i + 1)}`;
    re.lastIndex = m.index + fn.length + 1;
  }
  return sql;
}

function translate(sql: string): string {
  for (const [name, re] of REFUSED) if (re.test(sql)) throw new DialectError(name, sql);

  let out = sql.replace(
    JSON_X,
    (_m, col: string, path: string, cmp: string | undefined, op?: string, num?: string) => {
      const { op: jop, rhs } = jsonPath(path);
      const expr = `(${col}::jsonb ${jop} ${rhs})`;
      if (!cmp) return expr;
      const flag = FLAG_LITERAL[num!];
      if (flag && (op === '=' || op === '<>' || op === '!=')) {
        const jsonOp = jop === '->>' ? '->' : '#>';
        return `((${col}::jsonb ${jsonOp} ${rhs}) ${op === '=' ? 'IN' : 'NOT IN'} ${flag})`;
      }
      return `(${expr}::numeric ${op} ${num})`;
    },
  );

  out = outsideLiterals(out, (code) =>
    code
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO')
      .replace(/\bLIKE\b/g, 'ILIKE')
      // SQLite's instr has a Postgres name of its own.
      .replace(/\binstr\(/g, 'strpos(')
      // SQLite INTEGER is 64-bit; Postgres INTEGER is 32 and an epoch-millis cast overflows it. The
      // DDL rule (INTEGER → BIGINT) applied to expressions — found by residency.test on PGlite (1B).
      .replace(/\bAS\s+INTEGER\b/gi, 'AS BIGINT')
      // SQLite's null-safe `x IS ?` / `x IS NOT ?` against a bound value is Postgres's
      // `IS [NOT] DISTINCT FROM` (Postgres allows IS only before NULL/TRUE/FALSE) — GET /messages.
      .replace(/\bIS\s+NOT\s+\?/g, 'IS DISTINCT FROM ?')
      .replace(/\bIS\s+\?/g, 'IS NOT DISTINCT FROM ?'),
  );
  out = scalarMaxMin(out);

  if (out.includes('INSERT OR IGNORE INTO')) {
    out = out.replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO');
    const m = /\s+RETURNING\b[\s\S]*$/.exec(out);
    out = m
      ? `${out.slice(0, m.index)} ON CONFLICT DO NOTHING${m[0]}`
      : `${out} ON CONFLICT DO NOTHING`;
  }

  let n = 0;
  return outsideLiterals(out, (code) => code.replace(/\?/g, () => `$${++n}`));
}
