#!/usr/bin/env node
/**
 * CI gate on the stdio adapter's startup cost (lane 01M4VNTQFW, goal mcp-fast-path).
 *
 *   pnpm mcp:startup:check             — fail (exit 1) when the median is over budget
 *   pnpm mcp:startup:check --measure   — print the numbers, never fail (to seed or re-read a budget)
 *   pnpm mcp:startup:check --runs 25
 *
 * Launches the BUILT bundle (packages/mcp/dist/index.js — run `pnpm build` first) once to warm
 * Node's compile cache, as every launch after a harness's first is, then N more times, and budgets
 * the median of the adapter's own CPU time from process start to its `tools/list` reply
 * (`handshake.mjs`). CPU time, not wall time: wall swings 2–4x on a shared runner (ADR 574).
 *
 * The adapter's only daemon round trip before it serves is `bind()` → GET /health, so a stub that
 * answers /health stands in for the daemon; no real daemon, team, or seat is involved. Each run gets
 * a scratch HOME, config, cwd and compile cache, and no MUSTERD_* or OTEL_* variable from the
 * caller's shell, so a laptop run cannot touch the live daemon or a real binding.
 *
 * The budget lives in docs/perf/mcp-startup-budget.json. Raising it needs a new `justification`,
 * same rule as context-budgets.json; here it is enforced: a budget higher than the one on the base
 * ref (MCP_BUDGET_BASE, default origin/main) with the base's justification unchanged fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handshake, scrub } from './handshake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const entry = join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
const budgetRel = 'docs/perf/mcp-startup-budget.json';
const ITEM = 'startupCpuMedianMs';

const argv = process.argv.slice(2);
const measureOnly = argv.includes('--measure');
const runsAt = argv.indexOf('--runs');
const runs = runsAt >= 0 ? Number(argv[runsAt + 1]) : 15;
if (!Number.isInteger(runs) || runs < 1) {
  console.error('mcp:startup:check: --runs takes a positive integer');
  process.exit(2);
}

if (!existsSync(entry)) {
  console.error(
    `mcp:startup:check: ${entry} not found — run \`pnpm build\` first (dist/ is gitignored).`,
  );
  process.exit(1);
}

const budgets = JSON.parse(readFileSync(join(repoRoot, budgetRel), 'utf8'));
const item = budgets.items?.[ITEM];
if (!item || typeof item.budget !== 'number' || !item.justification) {
  console.error(`mcp:startup:check: ${budgetRel} needs items.${ITEM} {budget, justification}`);
  process.exit(1);
}

/** A raise must say why: the base ref's justification may not survive a higher budget. */
function raiseWithoutJustification() {
  const base = process.env.MCP_BUDGET_BASE || 'origin/main';
  let baseItem;
  try {
    const text = execFileSync('git', ['show', `${base}:${budgetRel}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    baseItem = JSON.parse(text).items?.[ITEM];
  } catch {
    console.log(`base ${base}: no budget file to compare against — raise check skipped`);
    return null;
  }
  if (!baseItem || item.budget <= baseItem.budget) return null;
  if (item.justification.trim() === String(baseItem.justification).trim()) {
    return `${ITEM} raised ${baseItem.budget} -> ${item.budget} ms against ${base} with its justification unchanged. Replace the justification: what was measured, why it can't be trimmed, what would bring it back down.`;
  }
  return null;
}

function stubDaemon() {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url?.startsWith('/health')) {
      res.end(JSON.stringify({ ok: true, build: 'mcp-startup-check' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function isolatedEnv(scratch, port) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MUSTERD_|OTEL_)/.test(k) || k === 'NODE_COMPILE_CACHE' || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: scratch,
    USERPROFILE: scratch,
    MUSTERD_CONFIG: join(scratch, 'config.json'),
    MUSTERD_TEAM: 'mcp-startup-check',
    MUSTERD_SERVER: `http://127.0.0.1:${port}`,
    MUSTERD_LAUNCH_SURFACE: 'claude-code',
    NODE_COMPILE_CACHE: join(scratch, 'compile-cache'),
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const scratch = mkdtempSync(join(tmpdir(), 'musterd-mcp-startup-'));
const cwd = join(scratch, 'work');
mkdirSync(cwd);
const server = await stubDaemon();
const env = isolatedEnv(scratch, server.address().port);

const cpu = cpus();
console.log(
  `runner: ${cpu.length} CPU (${cpu[0]?.model ?? 'unknown'}), ${(totalmem() / 2 ** 30).toFixed(1)} GiB, node ${process.version}, ${process.platform}/${process.arch}`,
);

const samples = [];
let failure;
try {
  // Warm-up: fills the compile cache the way a harness's first launch does. Reported, not counted.
  const cold = await handshake(entry, { env, cwd });
  console.log(
    `cold (cache empty, not counted): cpu ${cold.cpu_ms} ms, wall ${cold.spawn_to_tools_list_ms} ms`,
  );
  for (let i = 0; i < runs; i++) samples.push(await handshake(entry, { env, cwd }));
} catch (err) {
  failure = err;
} finally {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) {
  console.error(
    `mcp:startup:check: ${scrub(failure instanceof Error ? failure.message : String(failure))}`,
  );
  process.exit(1);
}

const cpuMs = samples.map((s) => s.cpu_ms);
const med = Math.round(median(cpuMs) * 10) / 10;
const wallMed = Math.round(median(samples.map((s) => s.spawn_to_tools_list_ms)) * 10) / 10;
console.log(
  `warm x${runs}: cpu median ${med} ms (min ${Math.min(...cpuMs)}, max ${Math.max(...cpuMs)}), wall median ${wallMed} ms (not budgeted), ${samples[0].tools} tools`,
);
console.log(`cpu per run: ${cpuMs.join(' ')}`);
console.log(`budget: ${ITEM} ${item.budget} ms (${budgetRel})`);

if (measureOnly) process.exit(0);

const unjustified = raiseWithoutJustification();
if (unjustified) {
  console.error(`✗ ${unjustified}`);
  process.exit(1);
}
if (med > item.budget) {
  console.error(
    `✗ adapter startup CPU median ${med} ms exceeds budget ${item.budget} ms (+${Math.round((med - item.budget) * 10) / 10}). Find what the startup graph gained (\`node scripts/mcp/bench.mjs\` by hand, ADR 574/577), trim it, or raise the budget WITH a new justification (currently: "${item.justification}").`,
  );
  process.exit(1);
}
console.log(`✓ adapter startup CPU median ${med} ms within ${item.budget} ms`);
