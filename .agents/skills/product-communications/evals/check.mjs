#!/usr/bin/env node
// Deterministic checks for the product-communications evals (ADR 579 decision 2).
//
//   node .agents/skills/product-communications/evals/check.mjs <workspace>
//
// <workspace>/<eval name>/<config>/output.md is one run's output, where <config> is
// with_skill or without_skill. Writes checks.json beside each output and prints a
// summary table. No dependencies; the glossary comes from docs/glossary/terms.ts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '..');
const repoRoot = resolve(skillRoot, '../../..');

// The same tripwires SKILL.md and references/prose.md name.
const CONTRAST = [
  /, not /gi,
  /\bnot a\b/gi,
  /\bit'?s not\b/gi,
  /\bisn'?t\b/gi,
  /\brather than\b/gi,
  /\binstead of\b/gi,
  /\bnot just\b/gi,
  /\bnot only\b/gi,
];
const HYPE = [
  'revolutionary',
  'magic',
  'supercharge',
  '10x',
  'game-changing',
  'cutting-edge',
  'world-class',
  'seamless',
  'innovative',
  'thrilled',
  'excited to announce',
];
const DATED = [
  'challenge',
  'dependable',
  'echoed',
  'foster',
  'leverage',
  'multifaceted',
  'prioritize',
  'quietly',
  'steady',
  'universally',
  'crucial',
  'enhance',
  'garner',
  'intricate',
  'meticulous',
  'pivotal',
  'showcase',
  'tapestry',
  'testament',
  'underscore',
  'vibrant',
  'delve',
];
const BANNED = ['kit', 'profile', 'template', 'worktree'];

function rx(source) {
  let flags = 'g';
  let body = source;
  for (;;) {
    const m = /^\(\?([im]+)\)/.exec(body);
    if (!m) break;
    flags += m[1];
    body = body.slice(m[0].length);
  }
  return new RegExp(body, [...new Set(flags)].join(''));
}

/** Prose only: drop fenced code, inline code, HTML/SVG tags and comments. */
function proseOf(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function count(text, word) {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*`, 'gi');
  return (text.match(re) ?? []).length;
}

/** Numbers as written, normalised: "1,704" → "1704"; dates and versions kept whole. */
function numbersOf(text) {
  // Only free-standing numbers: an ID such as GHSA-86w9 or a hash is not a figure.
  const found = text.match(/(?<![\w-])\d[\d,]*(?:\.\d+)*(?![\w-])/g) ?? [];
  return new Set(found.map((n) => n.replace(/,(?=\d{3}\b)/g, '').replace(/[.,]$/, '')));
}

async function notColumn() {
  try {
    const mod = await import(join(repoRoot, 'docs/glossary/terms.ts'));
    return mod.GLOSSARY.flatMap((t) => t.not.map((n) => n.replace(/\s*\(.*\)$/, '')));
  } catch {
    return [];
  }
}

function universal(text, notWords) {
  const prose = proseOf(text);
  const words = prose.split(/\s+/).filter(Boolean).length;
  const contrast = CONTRAST.reduce((n, re) => n + (prose.match(re) ?? []).length, 0);
  const hype = HYPE.filter((w) => count(prose, w) > 0);
  const dated = DATED.filter((w) => count(prose, w) > 0);
  const banned = BANNED.filter((w) => new RegExp(`\\b${w}s?\\b`, 'i').test(prose));
  const paragraphs = prose.split(/\n\s*\n/);
  const maxDashes = Math.max(0, ...paragraphs.map((p) => (p.match(/—|–| -- /g) ?? []).length));
  const notHits = notWords.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(prose));
  const tells = contrast + hype.length + dated.length + Math.max(0, maxDashes - 1);
  return {
    words,
    contrast,
    hype,
    dated,
    banned,
    maxDashesPerParagraph: maxDashes,
    notColumn: notHits,
    tellsPer100Words: words ? +((100 * tells) / words).toFixed(2) : 0,
  };
}

function specific(evalCase, text) {
  const c = evalCase.checks ?? {};
  const results = [];
  const add = (name, passed, evidence) => results.push({ text: name, passed, evidence });
  for (const k of c.keeps ?? [])
    add(`keeps "${k}"`, text.includes(k), text.includes(k) ? 'found' : 'missing');
  for (const a of c.absent ?? []) {
    const hit = text.match(rx(a));
    add(`absent /${a}/`, !hit, hit ? `found: ${hit.slice(0, 3).join(' | ')}` : 'none');
  }
  if (c.present_any) {
    const hit = c.present_any.find((p) => rx(p).test(text));
    add(
      `any of ${c.present_any.length} patterns`,
      Boolean(hit),
      hit ? `matched /${hit}/` : 'none matched',
    );
  }
  for (const p of c.present_all ?? []) {
    const ok = rx(p).test(text);
    add(`present /${p}/`, ok, ok ? 'found' : 'missing');
  }
  if (c.no_new_numbers_from) {
    const source = readFileSync(join(skillRoot, c.no_new_numbers_from), 'utf8') + evalCase.prompt;
    const allowed = numbersOf(source);
    const fresh = [...numbersOf(proseOf(text))].filter((n) => !allowed.has(n) && Number(n) > 12);
    add(
      'no numbers beyond the source',
      fresh.length === 0,
      fresh.length ? `new: ${fresh.join(', ')}` : 'none',
    );
  }
  if (c.max_words) {
    // The answer is what sits above the first `---` line; notes for a reviewer below it do not count.
    const answer = text.split(/^---\s*$/m)[0];
    const n = proseOf(answer).split(/\s+/).filter(Boolean).length;
    add(`at most ${c.max_words} words`, n <= c.max_words, `${n} words`);
  }
  return results;
}

const workspace = process.argv[2];
if (!workspace || !existsSync(workspace)) {
  console.error('usage: node check.mjs <workspace>   (see evals/README.md)');
  process.exit(2);
}
const { evals } = JSON.parse(readFileSync(join(here, 'evals.json'), 'utf8'));
const notWords = await notColumn();
const rows = [];
for (const e of evals) {
  const dir = join(workspace, e.name);
  if (!existsSync(dir)) continue;
  for (const config of readdirSync(dir).sort()) {
    const out = join(dir, config, 'output.md');
    if (!existsSync(out)) continue;
    const text = readFileSync(out, 'utf8');
    const checks = specific(e, text);
    const u = universal(text, notWords);
    writeFileSync(
      join(dir, config, 'checks.json'),
      JSON.stringify({ checks, universal: u }, null, 2) + '\n',
    );
    const passed = checks.filter((r) => r.passed).length;
    rows.push({ id: e.id, name: e.name, config, passed, total: checks.length, ...u });
  }
}
console.log('| eval | config | checks | tells/100w | contrast | hype | dated | banned |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.id} ${r.name} | ${r.config} | ${r.passed}/${r.total} | ${r.tellsPer100Words} | ${r.contrast} | ` +
      `${r.hype.join(' ') || 0} | ${r.dated.join(' ') || 0} | ${r.banned.join(' ') || 0} |`,
  );
}
for (const config of [...new Set(rows.map((r) => r.config))]) {
  const rs = rows.filter((r) => r.config === config);
  const p = rs.reduce((n, r) => n + r.passed, 0);
  const t = rs.reduce((n, r) => n + r.total, 0);
  const tells = rs.reduce((n, r) => n + r.tellsPer100Words, 0) / rs.length;
  console.log(
    `${config}: ${p}/${t} checks passed; mean tells per 100 words ${tells.toFixed(2)} (${rs.length} runs)`,
  );
}
writeFileSync(join(workspace, 'checks-summary.json'), JSON.stringify(rows, null, 2) + '\n');
