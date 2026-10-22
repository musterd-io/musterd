#!/usr/bin/env node
// Deterministic checks for the ios-engineer evals; delegates to the shared
// building-a-role-skill checker (see comms/evals/check.mjs for the pattern).
//   node .agents/skills/ios-engineer/evals/check.mjs <workspace>
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(skillDir, '..', 'building-a-role-skill', 'scripts', 'check-evals.mjs');
const run = spawnSync(process.execPath, [shared, skillDir, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
