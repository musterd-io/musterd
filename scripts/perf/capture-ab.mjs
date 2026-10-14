#!/usr/bin/env node
/**
 * Capture A/B: today's CDP screencast pipeline against Xvfb + `ffmpeg -f x11grab`, on one box, against
 * the synthetic bench fixture. Increment 1 of docs/superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md
 * (plan: docs/superpowers/plans/2026-10-13-broadcast-smooth-capture.md). Measurement only — the x11 arm
 * is an ad-hoc invocation, not a capture mode.
 *
 *   node scripts/perf/capture-ab.mjs [--secs 60] [--server http://127.0.0.1:4877] [--team bench]
 *
 * Arms run S, X, S, so the box's warm-up does not favour whichever arm goes second. Each arm prints one
 * `CAPTURE_AB {json}` line to stdout, which is what `fly logs` is read for, so nobody has to ssh in.
 *
 * Both arms share one in-page probe: a rAF loop that timestamps every change of `__office.stats().draws`,
 * so "draws/s" and the draw-to-draw gap (p50/p95) mean the same thing in both. CPU is the delta of
 * utime+stime from /proc over each process tree during the measured window. `ps`'s %cpu is a lifetime
 * average, which would fold launch cost into the arm.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const SECS = Number(flag('secs', '60'));
const SERVER = flag('server', 'http://127.0.0.1:4877');
const TEAM = flag('team', 'bench');
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/chromium';
const WARMUP_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP, the connectCdp pattern from broadcast.ts ────────────────────────────────────────────────
async function cdpPage(port) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('/broadcast'));
    } catch {
      // the debug port is not up yet; retry
    }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error(`no /broadcast page target on :${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
    pending.delete(m.id);
  };
  const evaluate = (expression) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, (m) => res(m.result?.result?.value));
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      );
    });
  return { evaluate, close: () => ws.close() };
}

const PROBE = `(() => {
  if (!window.__office) return 'no-office';
  window.__gaps = [];
  let d = __office.stats().draws, t = performance.now();
  (function f() {
    const s = __office.stats().draws;
    if (s !== d) { const n = performance.now(); __gaps.push(n - t); t = n; d = s; }
    requestAnimationFrame(f);
  })();
  return 'ok';
})()`;

async function waitForRoom(page) {
  for (let i = 0; i < 120; i++) {
    const n = await page.evaluate('window.__office?.floorSamples?.().length ?? -1');
    if (n > 0) return n;
    await sleep(500);
  }
  return 0;
}

// ── CPU over a process tree, from /proc ──────────────────────────────────────────────────────────
const HZ = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100;
function tree(root) {
  const kids = new Map();
  for (const line of execFileSync('ps', ['-eo', 'pid=,ppid=']).toString().trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [];
  const walk = (p) => (out.push(p), (kids.get(p) ?? []).forEach(walk));
  walk(root);
  return out;
}
function ticks(pids) {
  let t = 0;
  for (const p of pids) {
    try {
      const f = readFileSync(`/proc/${p}/stat`, 'utf8');
      const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
      t += Number(rest[11]) + Number(rest[12]); // utime, stime
    } catch {
      // a process that exited mid-window contributes what it had
    }
  }
  return t;
}
function boxIdle() {
  const [, ...v] = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/);
  const n = v.map(Number);
  return { idle: n[3] + n[4], total: n.reduce((a, b) => a + b, 0) };
}
/** Measure one window: CPU % of a core per named root (tree resolved at window start), and box idle %. */
async function measure(page, roots) {
  const trees = Object.fromEntries(
    Object.entries(roots).map(([k, pid]) => [k, pid ? tree(pid) : []]),
  );
  await page.evaluate(PROBE);
  const d0 = await page.evaluate('__office.stats().draws');
  const c0 = Object.fromEntries(Object.entries(trees).map(([k, p]) => [k, ticks(p)]));
  const b0 = boxIdle();
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const secs = (Date.now() - t0) / 1000;
  const d1 = await page.evaluate('__office.stats().draws');
  const gaps = (await page.evaluate('JSON.stringify(window.__gaps)')) ?? '[]';
  const b1 = boxIdle();
  const cpu = {};
  for (const [k, p] of Object.entries(trees))
    cpu[k] = round((100 * (ticks(p) - c0[k])) / HZ / secs);
  cpu.pipeline = round(Object.values(cpu).reduce((a, b) => a + b, 0));
  cpu.idlePct = round((100 * (b1.idle - b0.idle)) / (b1.total - b0.total));
  const g = JSON.parse(gaps).sort((a, b) => a - b);
  const q = (p) => (g.length ? round(g[Math.min(g.length - 1, Math.floor(p * g.length))]) : null);
  return {
    drawsPerSec: round((d1 - d0) / secs),
    gapP50Ms: q(0.5),
    gapP95Ms: q(0.95),
    cpu,
    secs: round(secs),
  };
}
const round = (x) => Math.round(x * 10) / 10;

function waitExit(proc) {
  return new Promise((res) => (proc.exitCode !== null ? res() : proc.once('exit', res)));
}
function kill(proc) {
  if (proc && proc.exitCode === null) proc.kill('SIGTERM');
}

// ── Arm S: the real `musterd broadcast` screencast pipeline ─────────────────────────────────────
async function armScreencast(label) {
  const out = join(mkdtempSync(join(tmpdir(), 'cab-s-')), 's.mp4');
  const cli = spawn(
    'node',
    [
      'packages/cli/dist/bin.js',
      'broadcast',
      '--team',
      TEAM,
      '--server',
      SERVER,
      '--fps',
      '30',
      '--duration',
      String(SECS + 40),
      '--out',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  try {
    // Its Chromium picks a random debug port; read it back from the process table.
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      const ps = execFileSync('ps', ['-eo', 'args=']).toString();
      port = /--remote-debugging-port=(\d+)/.exec(ps)?.[1];
      if (!port) await sleep(300);
    }
    if (!port) return { arm: label, invalid: 'no chromium debug port' };
    const page = await cdpPage(port);
    if (!(await waitForRoom(page))) return { arm: label, invalid: 'empty room (no posed actors)' };
    await sleep(WARMUP_MS);
    const ffmpegPid = Number(execFileSync('pgrep', ['-n', 'ffmpeg']).toString().trim());
    const chromePid = Number(
      execFileSync('pgrep', ['-o', '-f', `remote-debugging-port=${port}`])
        .toString()
        .trim(),
    );
    const r = await measure(page, { chrome: chromePid, ffmpeg: ffmpegPid, cli: cli.pid });
    // the CLI tree contains chrome and ffmpeg; report it as its own residue, not double-counted
    r.cpu.cli = round(r.cpu.cli - r.cpu.chrome - r.cpu.ffmpeg);
    r.cpu.pipeline = round(r.cpu.chrome + r.cpu.ffmpeg + r.cpu.cli);
    page.close();
    return { arm: label, ...r };
  } finally {
    kill(cli);
    await waitExit(cli);
  }
}

// ── Arm X: Xvfb + headful Chromium + ffmpeg x11grab ──────────────────────────────────────────────
async function armX11(label) {
  const DISPLAY = ':99';
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  await sleep(1500);
  const profile = mkdtempSync(join(tmpdir(), 'cab-x-profile-'));
  const chrome = spawn(
    CHROME,
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      '--kiosk',
      '--window-size=1920,1080',
      '--window-position=0,0',
      '--force-device-scale-factor=1',
      '--remote-debugging-port=9333',
      '--disable-infobars',
      '--noerrdialogs',
      `${SERVER}/broadcast?team=${TEAM}&fps=30`,
    ],
    { env: { ...process.env, DISPLAY }, stdio: 'ignore' },
  );
  const out = join(mkdtempSync(join(tmpdir(), 'cab-x-')), 'x.mp4');
  let ffmpeg;
  try {
    const page = await cdpPage(9333);
    if (!(await waitForRoom(page))) return { arm: label, invalid: 'empty room (no posed actors)' };
    ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'x11grab',
        '-framerate',
        '30',
        '-video_size',
        '1920x1080',
        '-i',
        DISPLAY,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=stereo',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        '4500k',
        '-maxrate',
        '4500k',
        '-bufsize',
        '9000k',
        '-g',
        '60',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-t',
        String(SECS + 20),
        '-y',
        out,
      ],
      { env: { ...process.env, DISPLAY }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    await sleep(WARMUP_MS);
    const r = await measure(page, { chrome: chrome.pid, ffmpeg: ffmpeg.pid, xvfb: xvfb.pid });
    page.close();
    kill(ffmpeg);
    await waitExit(ffmpeg);
    // One frame for the eye check (browser chrome in frame?) — printed as base64 so `fly logs` carries it.
    try {
      const png = join(tmpdir(), 'cab-x-frame.jpg');
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '5',
        '-i',
        out,
        '-frames:v',
        '1',
        '-vf',
        'scale=480:-1',
        png,
      ]);
      console.log(`CAPTURE_AB_FRAME ${readFileSync(png).toString('base64')}`);
    } catch {
      // the eye-check frame is optional; the numbers stand without it
    }
    return { arm: label, ...r };
  } finally {
    kill(ffmpeg);
    kill(chrome);
    kill(xvfb);
    await Promise.all([ffmpeg, chrome, xvfb].filter(Boolean).map(waitExit));
  }
}

const results = [];
for (const [fn, label] of [
  [armScreencast, 'screencast#1'],
  [armX11, 'x11grab'],
  [armScreencast, 'screencast#2'],
]) {
  const r = await fn(label).catch((e) => ({ arm: label, invalid: String(e?.message ?? e) }));
  console.log(`CAPTURE_AB ${JSON.stringify(r)}`);
  results.push(r);
  await sleep(5000);
}
console.log(
  '| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  if (r.invalid) console.log(`| ${r.arm} | invalid: ${r.invalid} |`);
  else {
    const c = r.cpu;
    console.log(
      `| ${r.arm} | ${r.drawsPerSec} | ${r.gapP50Ms} | ${r.gapP95Ms} | ${c.chrome} | ${c.ffmpeg} | ${c.xvfb ?? '—'} | ${c.cli ?? '—'} | ${c.pipeline} | ${c.idlePct} |`,
    );
  }
}
console.log('CAPTURE_AB_DONE');
