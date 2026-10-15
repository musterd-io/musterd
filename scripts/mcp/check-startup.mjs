#!/usr/bin/env node
/**
 * CI gate on the stdio adapter's startup cost (lane 01M4VNTQFW, goal mcp-fast-path).
 *
 *   pnpm mcp:startup:check                    — fail (exit 1) when this build regressed past budget
 *   pnpm mcp:startup:check --base HEAD^1      — the ref to compare against (CI passes HEAD^1)
 *   pnpm mcp:startup:check --base-entry <js>  — compare against an already-built bundle instead
 *   pnpm mcp:startup:check --measure          — print the numbers, never fail
 *   pnpm mcp:startup:check --runs 25
 *
 * Measures the adapter's own CPU time from process start to its `tools/list` reply
 * (`handshake.mjs`) for THIS build (packages/mcp/dist/index.js — run `pnpm build` first) and for
 * the base ref's build, on the same machine, launches interleaved, and fails when this build's
 * median exceeds the base's by more than `startupCpuRegressionPct` in
 * docs/perf/mcp-startup-budget.json.
 *
 * Relative, not absolute: the first absolute budget (230 ms, seeded on one CI runner) went red on
 * the next run of the SAME bundle, because ubuntu-latest's pool mixes CPU generations — 203 ms on
 * an EPYC 9V45, 323 ms on an EPYC 7763 (PR #2621). Both sides of a comparison run on one machine,
 * so the hardware cancels. CPU time, not wall time: wall swings 2–4x on a shared runner (ADR 574).
 * The cost of relative: a slow creep a few percent per PR passes each PR; each step is bounded.
 *
 * Each side is launched once to warm Node's compile cache, as every launch after a harness's first
 * is, then N more times; order alternates per round so drift on the machine lands on both sides.
 *
 * The adapter's only daemon round trip before it serves is `bind()` → GET /health, so a stub that
 * answers /health stands in for the daemon; no real daemon, team, or seat is involved. Each side
 * gets a scratch HOME, config, cwd and compile cache, and no MUSTERD_*, OTEL_* or NODE_OPTIONS from
 * the caller's shell, so a laptop run cannot touch the live daemon or a real binding.
 *
 * The base build is a detached scratch checkout of the ref with only @musterd/mcp and its
 * workspace deps installed and built, removed afterwards.
 *
 * Raising the budget needs a new `justification`, same rule as context-budgets.json; here it is
 * enforced: a budget higher than the base ref's with the base's justification unchanged fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handshake, scrub } from './handshake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const ENTRY_REL = join('packages', 'mcp', 'dist', 'index.js');
const entry = join(repoRoot, ENTRY_REL);
const budgetRel = 'docs/perf/mcp-startup-budget.json';
const ITEM = 'startupCpuRegressionPct';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const measureOnly = argv.includes('--measure');
const runs = flag('--runs') === undefined ? 15 : Number(flag('--runs'));
if (!Number.isInteger(runs) || runs < 1) {
  console.error('mcp:startup:check: --runs takes a positive integer');
  process.exit(2);
}

const git = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();

function baseRef() {
  const named = flag('--base');
  if (named) return git(['rev-parse', '--verify', `${named}^{commit}`]);
  return git(['merge-base', 'HEAD', 'origin/main']);
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
function raiseWithoutJustification(base) {
  let baseItem;
  try {
    baseItem = JSON.parse(git(['show', `${base}:${budgetRel}`])).items?.[ITEM];
  } catch {
    return null;
  }
  if (!baseItem || item.budget <= baseItem.budget) return null;
  if (item.justification.trim() === String(baseItem.justification).trim()) {
    return `${ITEM} raised ${baseItem.budget} -> ${item.budget} against ${base.slice(0, 10)} with its justification unchanged. Replace the justification: what was measured, why it can't be trimmed, what would bring it back down.`;
  }
  return null;
}

/** Build the base ref's bundle in a detached scratch checkout; returns its entry and a cleanup. */
function buildBase(ref, dir) {
  const run = (cmd, args, cwd) => {
    try {
      execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      throw new Error(`base build: \`${cmd} ${args.join(' ')}\` failed:\n${out.slice(-1500)}`);
    }
  };
  run('git', ['worktree', 'add', '--detach', '--quiet', dir, ref], repoRoot);
  const cleanup = () => {
    try {
      git(['worktree', 'remove', '--force', dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    const filter = '@musterd/mcp...';
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--filter', filter], dir);
    run('pnpm', ['--filter', filter, 'build'], dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { entry: join(dir, ENTRY_REL), cleanup };
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
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen(server));
  });
}

function isolatedSide(scratch, name, port) {
  const home = join(scratch, name);
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MUSTERD_|OTEL_)/.test(k) || k === 'NODE_COMPILE_CACHE' || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return {
    cwd,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      MUSTERD_CONFIG: join(home, 'config.json'),
      MUSTERD_TEAM: 'mcp-startup-check',
      MUSTERD_SERVER: `http://127.0.0.1:${port}`,
      MUSTERD_LAUNCH_SURFACE: 'claude-code',
      NODE_COMPILE_CACHE: join(home, 'compile-cache'),
    },
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n) => Math.round(n * 10) / 10;
const describe = (label, xs) =>
  `${label}: cpu median ${r1(median(xs))} ms (min ${Math.min(...xs)}, max ${Math.max(...xs)})`;

const cpu = cpus();
console.log(
  `runner: ${cpu.length} CPU (${cpu[0]?.model ?? 'unknown'}), ${(totalmem() / 2 ** 30).toFixed(1)} GiB, node ${process.version}, ${process.platform}/${process.arch}`,
);

// Real path: the launcher runs only when `import.meta.url` equals `file://` + argv[1], and macOS's
// tmpdir is behind a symlink (/var -> /private/var), so a symlinked entry would exit without serving.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-mcp-startup-')));
const head = [];
const base = [];
let base_ref = null;
let cleanupBase = () => {};
let failure;
const server = await stubDaemon();
try {
  let baseEntry;
  if (flag('--base-entry')) {
    baseEntry = resolve(flag('--base-entry'));
    console.log(`base: ${baseEntry} (given)`);
  } else {
    base_ref = baseRef();
    const started = performance.now();
    const built = buildBase(base_ref, join(scratch, 'base-checkout'));
    baseEntry = built.entry;
    cleanupBase = built.cleanup;
    console.log(
      `base: ${base_ref.slice(0, 10)} built in ${Math.round((performance.now() - started) / 1000)} s`,
    );
  }
  const port = server.address().port;
  const sides = {
    head: { entry, ...isolatedSide(scratch, 'head', port), out: head },
    base: { entry: baseEntry, ...isolatedSide(scratch, 'base', port), out: base },
  };
  // Warm-up: fills each side's compile cache the way a harness's first launch does. Not counted.
  for (const side of Object.values(sides)) await handshake(side.entry, side);
  for (let i = 0; i < runs; i++) {
    const order = i % 2 ? [sides.base, sides.head] : [sides.head, sides.base];
    for (const side of order) side.out.push((await handshake(side.entry, side)).cpu_ms);
  }
} catch (err) {
  failure = err;
} finally {
  server.close();
  cleanupBase();
  rmSync(scratch, { recursive: true, force: true });
}
if (failure) {
  console.error(
    `mcp:startup:check: ${scrub(failure instanceof Error ? failure.message : String(failure))}`,
  );
  process.exit(1);
}

const pct = r1((median(head) / median(base) - 1) * 100);
console.log(describe(`head x${runs}`, head));
console.log(describe(`base x${runs}`, base));
console.log(`head cpu per run: ${head.join(' ')}`);
console.log(`base cpu per run: ${base.join(' ')}`);
console.log(
  `head vs base: ${pct >= 0 ? '+' : ''}${pct}% (budget ${ITEM} +${item.budget}%, ${budgetRel})`,
);

if (measureOnly) process.exit(0);

const unjustified = base_ref ? raiseWithoutJustification(base_ref) : null;
if (unjustified) {
  console.error(`✗ ${unjustified}`);
  process.exit(1);
}
if (pct > item.budget) {
  console.error(
    `✗ adapter startup CPU is ${pct}% over the base build's on this machine (budget +${item.budget}%). Find what the startup graph gained (\`node scripts/mcp/bench.mjs\` by hand, ADR 574/577), trim it, or raise the budget WITH a new justification (currently: "${item.justification}").`,
  );
  process.exit(1);
}
console.log(`✓ adapter startup CPU within +${item.budget}% of the base build`);
