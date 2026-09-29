// Counts SQLite-only SQL constructs and better-sqlite3 call sites under a source root. Spike-only
// (ADR 475 increment 0): the number is the size of the store conversion, whichever backend wins.
//   node scripts/perf/pglite-dialect-inventory.mjs [packages/server/src]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Order matters only for the report. `ON CONFLICT` and `RETURNING` are Postgres-valid and are
 * counted so the page can say how much of the SQL is already portable. */
export const CONSTRUCTS = [
  'json_extract',
  'json_each',
  'PRAGMA',
  '.pragma(',
  'INSERT OR IGNORE',
  'INSERT OR REPLACE',
  'AUTOINCREMENT',
  'INTEGER PRIMARY KEY',
  'strftime',
  'datetime(',
  'unixepoch',
  'GLOB',
  'iif(',
  'COLLATE NOCASE',
  'last_insert_rowid',
  'ON CONFLICT',
  'RETURNING',
  '.prepare(',
  '.exec(',
  '.transaction(',
  '.changes',
];

const PORTABLE = new Set(['ON CONFLICT', 'RETURNING']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

function countOccurrences(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** @returns {{ byConstruct: Record<string, number>, byFile: Record<string, number>, files: number }} */
export function inventory(rootDir) {
  /** @type {Record<string, number>} */
  const byConstruct = Object.fromEntries(CONSTRUCTS.map((c) => [c, 0]));
  /** @type {Record<string, number>} */
  const byFile = {};
  let files = 0;
  for (const file of walk(rootDir)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('better-sqlite3') && !CONSTRUCTS.some((c) => text.includes(c))) continue;
    files++;
    let fileTotal = 0;
    for (const c of CONSTRUCTS) {
      const n = countOccurrences(text, c);
      byConstruct[c] += n;
      if (!PORTABLE.has(c)) fileTotal += n;
    }
    byFile[relative(rootDir, file)] = fileTotal;
  }
  return { byConstruct, byFile, files };
}

export function renderMarkdown(r) {
  const rows = CONSTRUCTS.map(
    (c) =>
      `| \`${c}\` | ${r.byConstruct[c]} | ${PORTABLE.has(c) ? 'portable' : 'SQLite-only or driver API'} |`,
  );
  const top = Object.entries(r.byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([f, n]) => `| \`${f}\` | ${n} |`);
  return [
    `Files touching better-sqlite3 or a listed construct: **${r.files}**`,
    '',
    '| construct | count | class |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '| file (top 15 by non-portable hits) | hits |',
    '| --- | --- |',
    ...top,
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('pglite-dialect-inventory.mjs')) {
  const root = process.argv[2] ?? 'packages/server/src';
  console.log(renderMarkdown(inventory(root)));
}
