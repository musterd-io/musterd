#!/usr/bin/env node
// Deterministic checks for the commerce skill's evals.
//
//   node .agents/skills/commerce/evals/check.mjs <answers-dir>
//
// <answers-dir> holds one file per case and arm: `<case-name>.<arm>.md` (arm is any label, for
// example A or B). Each case's `checks.present_all` patterns must all match, and its
// `checks.absent_all` patterns must all miss. A leading `(?i)` makes a pattern case-insensitive.
// Prints one line per answer and exits 1 if any answer fails. Grading by expectation is separate.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { evals } = JSON.parse(readFileSync(join(here, 'evals.json'), 'utf8'));
const dir = process.argv[2];
if (!dir) {
  console.error('usage: check.mjs <answers-dir>');
  process.exit(2);
}

function re(p) {
  return p.startsWith('(?i)') ? new RegExp(p.slice(4), 'i') : new RegExp(p);
}

let failed = 0;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()) {
  const [name, arm] = file.replace(/\.md$/, '').split('.');
  const c = evals.find((e) => e.name === name);
  if (!c) continue;
  const text = readFileSync(join(dir, file), 'utf8');
  const missing = (c.checks.present_all ?? []).filter((p) => !re(p).test(text));
  const present = (c.checks.absent_all ?? []).filter((p) => re(p).test(text));
  const ok = missing.length === 0 && present.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? 'pass' : 'FAIL'} ${name} [${arm}]` +
      (missing.length ? ` missing: ${missing.join(' | ')}` : '') +
      (present.length ? ` forbidden: ${present.join(' | ')}` : ''),
  );
}
process.exit(failed ? 1 : 0);
