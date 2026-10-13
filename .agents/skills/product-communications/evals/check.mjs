#!/usr/bin/env node
// Deterministic checks for the product-communications evals. The checker itself is the
// building-a-role-skill method's shared script; this keeps the command evals/README.md documents.
//
//   node .agents/skills/product-communications/evals/check.mjs <workspace>
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(skillDir, '..', 'building-a-role-skill', 'scripts', 'check-evals.mjs');
const run = spawnSync(process.execPath, [shared, skillDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
