#!/usr/bin/env node
/**
 * Run one command on a throwaway Fly machine next to Neon (cloud increment 1D, lanes 01M3Z429Q3 and
 * 01M3Z44C56), so heavy measurement never loads the shared laptop (~12 seats live on it). The image
 * is scripts/perf/loadbench.Dockerfile, the repo built at this commit, run in the
 * `musterd-loadbench` app:
 *
 *   1. build    remote builder, tagged with the commit, then wait for the tag to reach the
 *               registry (the push lands after flyctl returns, which deploy.mjs found the hard way);
 *   2. secrets  optionally stage NAME=VALUE lines from a local mode-600 file as Fly secrets on the
 *               bench app, through stdin, never printed (`--secrets-from <file>`);
 *   3. run      create a one-shot machine in iad through the Machines API with the command, stream
 *               its log while it runs (`fly logs --no-tail` afterwards returns only the most recent
 *               ~100 lines — the first 20 files of a 68-file pass were lost that way on 2026-10-02),
 *               wait for it to stop, and read its exit code (Fly omits a zero code);
 *   4. clean    destroy the machine. Run it again to rerun; nothing persists between runs.
 *
 *   node scripts/cloud/bench-run.mjs --secrets-from ~/.musterd/cloud/neon.env -- \
 *     node scripts/cloud/neon-pass.mjs --per-file
 *
 * Env: BENCH_APP (musterd-loadbench), BENCH_SIZE (performance-2x), BENCH_MEMORY_MB (4096),
 * BENCH_REGION (iad), BENCH_WAIT_MIN (180). Exits with the command's exit code.
 *
 * BENCH_HUB_APP=<fly app> also tails THAT app's log for the whole run and keeps EVERY line of it in
 * BENCH_HUB_LOG (default ~/.musterd/cloud/bench/out/hub-<label>-<time>.log), echoing only the
 * socket lines (`ws_close`, `ws_cleanup_failed`, `ws_heartbeat_reaped`) to the console. Run 36
 * could not say who closed 23 viewer sockets because `fly logs --no-tail` had rolled past the burst
 * windows by the time anyone looked (lane 01M4VAWG30); the hub's line now carries the close code,
 * and this keeps it. Run 42 then kept ONLY those lines and so could not name its one `GET /inbox`
 * 502 or rebuild the per-route server table (lane 01M4YYPARB) — the file now holds the whole log,
 * `http_request` lines included; grep it afterwards.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const APP = process.env.BENCH_APP ?? 'musterd-loadbench';
const SIZE = process.env.BENCH_SIZE ?? 'performance-2x';
const MEMORY_MB = Number(process.env.BENCH_MEMORY_MB ?? 4096);
const REGION = process.env.BENCH_REGION ?? 'iad';
const WAIT_MIN = Number(process.env.BENCH_WAIT_MIN ?? 180);
const HUB_APP = process.env.BENCH_HUB_APP ?? null;
const HUB_LINE = /ws_close|ws_cleanup_failed|ws_heartbeat_reaped/;
const CONFIG = 'scripts/perf/loadbench.fly.toml';
const REGISTRY = 'https://registry.fly.io/v2';

function run(cmd, args, { capture = false, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    stdio: capture || input ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const tail = capture ? `\n${(r.stderr || '').trim().split('\n').slice(-5).join('\n')}` : '';
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … exited ${r.status}${tail}`);
  }
  return r.stdout ?? '';
}

function parseArgs(argv) {
  const dash = argv.indexOf('--');
  if (dash < 0 || dash === argv.length - 1) {
    throw new Error('usage: bench-run.mjs [--secrets-from <file>] -- <command…>');
  }
  const opts = argv.slice(0, dash);
  const i = opts.indexOf('--secrets-from');
  return { secretsFrom: i >= 0 ? opts[i + 1] : null, cmd: argv.slice(dash + 1) };
}

/** NAME=VALUE lines from a mode-600 file, quotes stripped, as `fly secrets import` reads them. */
function secretLines(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim());
    if (m) out.push([m[1], m[2] ?? m[3] ?? m[4]]);
  }
  if (!out.length) throw new Error(`${path} holds no NAME=VALUE lines`);
  return out;
}

async function waitForTag(token, tag) {
  const headers = {
    authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
    accept:
      'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  };
  for (let waited = 0; waited <= 300; waited += 5) {
    const res = await fetch(`${REGISTRY}/${APP}/manifests/${tag}`, { method: 'HEAD', headers });
    if (res.ok) return;
    if (res.status !== 404) throw new Error(`registry answered ${res.status} for ${APP}:${tag}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${APP}:${tag} never appeared in the registry (waited 300 s)`);
}

async function createMachine(token, image, cmd) {
  const res = await fetch(`https://api.machines.dev/v1/apps/${APP}/machines`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      region: REGION,
      config: {
        image,
        init: { cmd },
        restart: { policy: 'no' },
        guest: {
          cpu_kind: 'performance',
          cpus: Number(SIZE.split('-').pop()?.replace('x', '')) || 2,
          memory_mb: MEMORY_MB,
        },
        metadata: { purpose: 'bench' },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    throw new Error(`creating the bench machine → ${res.status} ${body.error ?? ''}`.trim());
  }
  return body.id;
}

/** Tail the hub app's log for the run: every line to the file, socket lines also to the console. */
function tailHub(label) {
  if (!HUB_APP) return null;
  const path =
    process.env.BENCH_HUB_LOG ??
    `${homedir()}/.musterd/cloud/bench/out/hub-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const file = createWriteStream(path, { flags: 'a' });
  const child = spawn('fly', ['logs', '--app', HUB_APP], { stdio: ['ignore', 'pipe', 'inherit'] });
  let rest = '';
  child.stdout.on('data', (chunk) => {
    rest += chunk.toString('utf8');
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      file.write(`${line}\n`);
      if (HUB_LINE.test(line)) console.log(`[hub] ${line}`);
    }
  });
  console.log(`hub log (${HUB_APP}, every line; socket lines echoed) → ${path}`);
  return { kill: () => child.kill(), end: () => file.end() };
}

function machine(id) {
  const all = JSON.parse(
    run('fly', ['machines', 'list', '--app', APP, '--json'], { capture: true }),
  );
  return all.find((m) => m.id === id);
}

try {
  const { secretsFrom, cmd } = parseArgs(process.argv.slice(2));
  const sha = run('git', ['rev-parse', '--short=12', 'HEAD'], { capture: true }).trim();
  if (run('git', ['status', '--porcelain'], { capture: true }).trim() !== '') {
    throw new Error('the working tree is dirty; the bench runs a commit, not uncommitted edits');
  }
  const label = `git-${sha}`;
  const image = `registry.fly.io/${APP}:${label}`;
  const token = run('fly', ['auth', 'token'], { capture: true }).trim();

  console.log(`── 1. build ${image}`);
  run('fly', [
    'deploy',
    '--config',
    CONFIG,
    '--app',
    APP,
    '--remote-only',
    '--build-only',
    '--push',
    '--image-label',
    label,
  ]);
  await waitForTag(token, label);

  if (secretsFrom) {
    const lines = secretLines(secretsFrom);
    run('fly', ['secrets', 'import', '--app', APP, '--stage'], {
      input: lines.map(([k, v]) => `${k}=${v}`).join('\n'),
    });
    console.log(`── 2. staged on ${APP}: ${lines.map(([k]) => k).join(', ')}`);
  }

  console.log(`── 3. run on ${SIZE} in ${REGION}: ${cmd.join(' ')}`);
  const id = await createMachine(token, image, cmd);
  console.log(`bench machine ${id}`);
  const tail = spawn('fly', ['logs', '--app', APP, '--machine', id], { stdio: 'inherit' });
  const hub = tailHub(label);
  let code = null;
  try {
    const deadline = Date.now() + WAIT_MIN * 60_000;
    let misses = 0;
    for (;;) {
      // One failed poll is not a dead machine: a transient Machines API `EOF` on 2026-10-13 threw
      // here and the `finally` destroyed run 36 one minute in (lane 01M4V72T1V). Ride out a few.
      let m;
      try {
        m = machine(id);
        misses = 0;
      } catch (e) {
        if (++misses > 5) throw e;
        console.log(
          `   (poll ${misses}/5 failed: ${e instanceof Error ? e.message.split('\n')[0] : e})`,
        );
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      if (m?.state === 'stopped' || m?.state === 'failed') {
        const exit = (m.events ?? []).find((ev) => ev?.type === 'exit');
        code = exit ? (exit.request?.exit_event?.exit_code ?? 0) : null;
        break;
      }
      if (Date.now() > deadline)
        throw new Error(`bench machine still ${m?.state} after ${WAIT_MIN} min`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
    // The log stream lags the machine by a few seconds; let the last lines land before it goes.
    await new Promise((r) => setTimeout(r, 8_000));
  } finally {
    tail.kill();
    hub?.kill();
    hub?.end();
    run('fly', ['machine', 'destroy', id, '--app', APP, '--force'], { capture: true });
    console.log(`── 4. destroyed ${id}`);
  }
  console.log(`exit ${code ?? 'unknown (the machine never ran)'}`);
  process.exit(code ?? 1);
} catch (e) {
  console.error(`bench failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
