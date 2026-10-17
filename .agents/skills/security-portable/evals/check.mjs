#!/usr/bin/env node
// Run a case's deterministic text checks against an answer file.
// Usage: node check.mjs <case-id> <answer-file>
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const id = Number(process.argv[2]);
const answerPath = process.argv[3];
if (!Number.isInteger(id) || !answerPath) {
  console.error('usage: node check.mjs <case-id> <answer-file>');
  process.exit(2);
}

const { evals } = JSON.parse(readFileSync(join(here, 'evals.json'), 'utf8'));
const testCase = evals.find((item) => item.id === id);
if (!testCase) {
  console.error(`no evaluation case with id ${id}`);
  process.exit(2);
}
const answer = readFileSync(resolve(answerPath), 'utf8');
const matches = (pattern) => {
  const insensitive = pattern.startsWith('(?i)');
  return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? 'i' : '').test(answer);
};
const groups = [];
for (const pattern of testCase.checks?.keeps ?? [])
  groups.push({ kind: 'keeps', patterns: [pattern], pass: matches(pattern) });
for (const pattern of testCase.checks?.absent ?? [])
  groups.push({ kind: 'absent', patterns: [pattern], pass: !matches(pattern) });
const any = testCase.checks?.present_any ?? [];
if (any.length) groups.push({ kind: 'present_any', patterns: any, pass: any.some(matches) });
const all = testCase.checks?.present_all ?? [];
if (all.length) groups.push({ kind: 'present_all', patterns: all, pass: all.every(matches) });
const result = {
  case: id,
  passed: groups.filter((group) => group.pass).length,
  total: groups.length,
  groups,
};
console.log(JSON.stringify(result, null, 2));
if (result.passed !== result.total) process.exitCode = 1;
