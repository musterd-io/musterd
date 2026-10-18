#!/usr/bin/env node
/**
 * Cold-start ladder (lane 01M562HNQF47JM32EAVVHZMTAA, goal live-loads-fast): build several refs of the
 * stdio MCP adapter and launch them round-robin on one machine, recording wall time and the
 * adapter's own CPU time from process start to its `tools/list` reply, with the daemon's /health
 * answering at once and again after a delay.
 *
 *   node scripts/mcp/ladder.mjs <repo> <runs> <label>=<ref> [<label>=<ref> ...]
 *
 * Prints one JSON document. `check-startup.mjs` compares HEAD to ONE base on CPU time for a CI gate;
 * this compares a SEQUENCE of refs on wall and CPU, which is how the cuts of #2435/#2458/#2474 are
 * read against each other. Two differences from it, both on purpose: no NODE_COMPILE_CACHE is set
 * (the adapter's own cache, ADR 577, is part of what is measured), and a second condition delays
 * /health by 300 ms, because the adapter no longer waits on it before serving initialize (#2474)
 * and an instant stub hides that.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
const repo = process.argv[2];
const runs = Number(process.argv[3] ?? 25);
const refs = process.argv.slice(4).map((s) => s.split('=')); // label=ref
const { handshake } = await import(join(repo, 'scripts/mcp/handshake.mjs'));
const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-ladder-')));
const entryRel = join('packages', 'mcp', 'dist', 'index.js');
const sides = [];
for (const [label, ref] of refs) {
  const dir = join(scratch, label);
  sh('git', ['worktree', 'add', '--detach', '--quiet', dir, ref], repo);
  sh(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@musterd/mcp...'],
    dir,
  );
  sh('pnpm', ['--filter', '@musterd/mcp...', 'build'], dir);
  sides.push({
    label,
    ref,
    sha: sh('git', ['rev-parse', '--short', 'HEAD'], dir).trim(),
    dir,
    entry: join(dir, entryRel),
  });
  console.error('built', label, sides.at(-1).sha);
}
let delay = 0;
const server = createServer((req, res) => {
  const reply = () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, build: 'ladder' }));
  };
  if (req.method === 'GET' && req.url?.startsWith('/health')) setTimeout(reply, delay);
  else {
    res.statusCode = 404;
    res.end('{}');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n) => Math.round(n * 10) / 10;
function opts(side, tag) {
  const home = join(scratch, `${side.label}-${tag}-home`);
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
      MUSTERD_TEAM: 'ladder',
      MUSTERD_SERVER: `http://127.0.0.1:${port}`,
      MUSTERD_LAUNCH_SURFACE: 'claude-code',
    },
  };
}
const cpu = cpus();
const out = {
  machine: `${cpu.length} CPU (${cpu[0]?.model}), ${(totalmem() / 2 ** 30).toFixed(1)} GiB, node ${process.version}, ${process.platform}/${process.arch}`,
  runs,
  conditions: {},
};
for (const [tag, d] of [
  ['health0', 0],
  ['health300', 300],
]) {
  delay = d;
  const acc = Object.fromEntries(
    sides.map((s) => [
      s.label,
      { wall: [], cpu: [], first_wall: null, first_cpu: null, tools: null, bytes: null },
    ]),
  );
  const o = Object.fromEntries(sides.map((s) => [s.label, opts(s, tag)]));
  for (const s of sides) {
    const r = await handshake(s.entry, o[s.label]);
    acc[s.label].first_wall = r.spawn_to_tools_list_ms;
    acc[s.label].first_cpu = r.cpu_ms;
    acc[s.label].tools = r.tools;
    acc[s.label].bytes = r.tools_list_bytes;
  }
  for (let i = 0; i < runs; i++) {
    const order = i % 2 ? [...sides].reverse() : sides;
    for (const s of order) {
      const r = await handshake(s.entry, o[s.label]);
      acc[s.label].wall.push(r.spawn_to_tools_list_ms);
      acc[s.label].cpu.push(r.cpu_ms);
    }
  }
  out.conditions[tag] = {
    health_delay_ms: d,
    sides: sides.map((s) => ({
      label: s.label,
      ref: s.ref,
      sha: s.sha,
      first_wall_ms: acc[s.label].first_wall,
      first_cpu_ms: acc[s.label].first_cpu,
      tools: acc[s.label].tools,
      tools_list_bytes: acc[s.label].bytes,
      wall_median_ms: r1(median(acc[s.label].wall)),
      wall_min: Math.min(...acc[s.label].wall),
      wall_max: Math.max(...acc[s.label].wall),
      cpu_median_ms: r1(median(acc[s.label].cpu)),
      cpu_min: Math.min(...acc[s.label].cpu),
      cpu_max: Math.max(...acc[s.label].cpu),
    })),
  };
}
server.close();
for (const s of sides) {
  try {
    sh('git', ['worktree', 'remove', '--force', s.dir], repo);
  } catch {
    rmSync(s.dir, { recursive: true, force: true });
  }
}
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
