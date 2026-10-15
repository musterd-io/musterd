#!/usr/bin/env node
/**
 * Cold start of the stdio adapter every external harness launches.
 *
 *   node scripts/mcp/bench.mjs --surface claude-code
 *   node scripts/mcp/bench.mjs --surface codex --entry "$HOME/.musterd/runtime/packages/mcp/dist/index.js"
 *
 * Prints one JSON line: module-import time, then spawn → legacy `initialize`, then spawn →
 * `tools/list`, and the adapter's own CPU time up to that reply (`handshake.mjs`). Speaks the wire
 * current harnesses speak (`initialize`), never a tool call, so it does not claim a seat. The native
 * musterd host has no stdio entry; this bench is not for it. `check-startup.mjs` is the CI gate.
 *
 * stdout is the JSON line. Diagnostics go to stderr. A credential-shaped token is redacted.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { handshake, scrub } from './handshake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoEntry = join(here, '../../packages/mcp/dist/index.js');
const runtimeEntry = join(homedir(), '.musterd/runtime/packages/mcp/dist/index.js');

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function entryPath() {
  const fromFlag = flag('--entry');
  if (fromFlag) return resolve(fromFlag);
  if (process.env.MUSTERD_MCP) return resolve(process.env.MUSTERD_MCP);
  if (existsSync(runtimeEntry)) return runtimeEntry;
  if (existsSync(repoEntry)) return repoEntry;
  throw new Error('no adapter entry — pass --entry or set MUSTERD_MCP');
}

function surfaceName() {
  return flag('--surface') || process.env.MUSTERD_LAUNCH_SURFACE || '';
}

function run(cmd, args, opts) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: opts.stdio });
    const out = { stdout: '', stderr: '', code: null };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error('timed out'));
    }, opts.timeoutMs ?? 20_000);
    child.stdout?.on('data', (d) => {
      out.stdout += d;
    });
    child.stderr?.on('data', (d) => {
      out.stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      out.code = code;
      resolveRun(out);
    });
  });
}

async function importMs(entry) {
  const href = pathToFileURL(entry).href;
  const started = performance.now();
  const out = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const t = performance.now(); await import(${JSON.stringify(href)}); console.log((performance.now() - t).toFixed(1));`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 20_000 },
  );
  const wall = performance.now() - started;
  const line = out.stdout.trim().split('\n').filter(Boolean).at(-1);
  const parsed = line ? Number(line) : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`import failed: ${scrub(out.stderr).slice(-400) || out.stdout.slice(-200)}`);
  }
  return { import_ms: parsed, import_wall_ms: Math.round(wall * 10) / 10 };
}

function bootEnv(surface) {
  const env = { ...process.env };
  delete env.MUSTERD_SURFACE;
  if (surface) env.MUSTERD_LAUNCH_SURFACE = surface;
  if (!env.MUSTERD_LAUNCH_SURFACE) {
    throw new Error('pass --surface <harness> (claude-code, cursor, codex, opencode, grok)');
  }
  return env;
}

const entry = entryPath();
const surface = surfaceName();
try {
  const imported = await importMs(entry);
  const listed = await handshake(entry, { env: bootEnv(surface) });
  process.stdout.write(
    `${JSON.stringify({
      entry,
      ...imported,
      ...listed,
    })}\n`,
  );
} catch (err) {
  process.stderr.write(
    `musterd mcp bench: ${scrub(err instanceof Error ? err.message : String(err))}\n`,
  );
  process.exit(1);
}
