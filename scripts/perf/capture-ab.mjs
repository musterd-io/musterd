#!/usr/bin/env node
/**
 * Capture A/B: the CDP screencast pipeline against Xvfb + `ffmpeg -f x11grab`, on one box, against
 * the synthetic bench fixture. Written for increment 1 of
 * docs/superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md, when the x11 arm was an ad-hoc
 * invocation; increment 4 (lane 01M4VS22F1) adds the real `musterd broadcast --capture x11` mode as its
 * own arm, and runs the ad-hoc arm with and without dirty-rect repaint (`&dirty=0`, ADR 625).
 *
 *   node scripts/perf/capture-ab.mjs [--secs 60] [--fps 30] [--arms screencast,x11-cli#1] \
 *     [--server http://127.0.0.1:4877] [--team bench]
 *
 * Arms run screencast, x11-cli, x11-adhoc, x11-adhoc dirty=0, x11-cli, so the x11 CLI mode is read at
 * both ends of the box's warm-up. Each arm prints one `CAPTURE_AB {json}` line to stdout, which is what
 * `fly logs` is read for, so nobody has to ssh in.
 *
 * Every arm shares one in-page probe: a rAF loop that timestamps every change of `__office.stats().draws`,
 * so "draws/s" and the draw-to-draw gap (p50/p95) mean the same thing in both. CPU is the delta of
 * utime+stime from /proc over each process tree during the measured window. `ps`'s %cpu is a lifetime
 * average, which would fold launch cost into the arm.
 *
 * Lever 3 (lane 01M55MAQ9M) adds two readings to the CLI arms: CPU per Chrome thread over the same
 * window (`threads`), and, after it, a 5 s trace of the renderer main thread (`main`: busy %, the
 * rAF callbacks' share and per-frame cost), which says whether that thread is what caps the draws.
 * The ad-hoc arm takes `~<variant>` (Chromium flags, a page rate apart from the encode rate) and
 * fingerprints every raw grabbed frame (`source`), which counts the repeats a viewer actually gets.
 *
 * The GPU host run (lane 01M55MAQ9M) adds a `gpu` variant token and `CAPTURE_AB_DISPLAY`: set, the
 * ad-hoc arm grabs that already-running X server (an Xorg on the NVIDIA driver) instead of starting
 * Xvfb, which has no GPU to composite with. Each ad-hoc arm records what Chrome says it composited
 * with (`gpu`), so a silent fall back to software reads as such.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const SECS = Number(flag('secs', '60'));
// The encode and page rate for every arm. 30 is the spec's bar; 24 is the sub-bar rung (lane 01M55N47KJ).
const FPS = Number(flag('fps', '30'));
// A comma list of arm labels to run, in order; default is the full increment 4 set. `label@20` runs
// that arm at 20 fps instead of --fps, so two rungs can share one box (lane 01M55N47KJ).
const ONLY = flag('arms', '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);
const SERVER = flag('server', 'http://127.0.0.1:4877');
const TEAM = flag('team', 'bench');
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/chromium';
// An X server that is already up (e.g. `:0`, Xorg on the NVIDIA driver); unset, each ad-hoc arm
// starts its own Xvfb.
const EXT_DISPLAY = process.env.CAPTURE_AB_DISPLAY;
const WARMUP_MS = 8000;
// The page's observer (ADR 594): since ADR 580 /broadcast cannot mint one over loopback, so
// capture-ab.sh mints it as the fixture's human admin. Arm S's `musterd broadcast` reads the same env.
const SEAT = JSON.parse(process.env.MUSTERD_BROADCAST_SEAT ?? 'null');
if (!SEAT) throw new Error('MUSTERD_BROADCAST_SEAT is unset — run via scripts/perf/capture-ab.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP, the connectCdp pattern from broadcast.ts ────────────────────────────────────────────────
async function cdpPage(port, urlPart = '/broadcast') {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes(urlPart));
    } catch {
      // the debug port is not up yet; retry
    }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error(`no ${urlPart} page target on :${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method) for (const fn of listeners.get(m.method) ?? []) fn(m.params);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
    pending.delete(m.id);
  };
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, (m) =>
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result),
      );
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  return { send, evaluate, on, close: () => ws.close() };
}

// What Chrome composited and rasterised with, from the browser target's SystemInfo (the page target
// has no such domain): `enabled` vs `disabled_software` is whether the GPU did the work at all.
async function gpuInfo(port) {
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const m = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
  });
  ws.close();
  if (m.error) throw new Error(`SystemInfo.getInfo: ${m.error.message}`);
  const { featureStatus = {}, auxAttributes = {} } = m.result.gpu;
  return {
    compositing: featureStatus.gpu_compositing,
    raster: featureStatus.rasterization,
    renderer: auxAttributes.glRenderer,
  };
}

const PROBE = `(() => {
  if (!window.__office) return 'no-office';
  window.__gaps = [];
  window.__ticks = [];
  let d = __office.stats().draws, t = performance.now(), last = t;
  (function f() {
    const n = performance.now();
    __ticks.push(n - last); last = n;
    const s = __office.stats().draws;
    if (s !== d) { __gaps.push(n - t); t = n; d = s; }
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
// ── Lever 3's question: is the main thread the wall? (lane 01M55MAQ9M) ────────────────────────────
// An OffscreenCanvas worker moves the room's drawing off the renderer's main thread. That only buys
// draws if the main thread is what caps them; if Chrome's compositor or raster threads are saturated
// instead, the worker moves the work and the cap stays. Two readings answer it.

/** utime+stime per thread across a process tree, keyed `<process type>/<thread name>`. */
function threadTicks(pids) {
  const out = {};
  for (const p of pids) {
    let type = 'browser';
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8');
      type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? (cmd.includes('chrom') ? 'browser' : 'other');
    } catch {
      continue;
    }
    let tids = [];
    try {
      tids = readdirSync(`/proc/${p}/task`);
    } catch {
      continue;
    }
    for (const t of tids) {
      try {
        const f = readFileSync(`/proc/${p}/task/${t}/stat`, 'utf8');
        const name = f.slice(f.indexOf('(') + 1, f.lastIndexOf(')'));
        const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
        const k = `${type}/${name}`;
        out[k] = (out[k] ?? 0) + Number(rest[11]) + Number(rest[12]);
      } catch {
        // a thread that exited mid-window contributes what it had
      }
    }
  }
  return out;
}

const TRACE_MS = 5000;
// Inclusive time per event name on the renderer main thread (nested names overlap, so these do not
// sum): the room's own drawing is FireAnimationFrame; the rest is what a worker would leave behind.
const MAIN_NAMES = [
  'FireAnimationFrame',
  'FunctionCall',
  'TimerFire',
  'EventDispatch',
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'Layerize',
  'Commit',
  'MinorGC',
  'MajorGC',
  'V8.GC_SCAVENGER',
  'ParseHTML',
];

/** Trace TRACE_MS after the measured window (so tracing cost never touches its numbers) and split
 * the renderer main thread: busy %, the rAF callbacks' share, and their per-frame cost. */
async function mainThreadSplit(page) {
  const events = [];
  page.on('Tracing.dataCollected', (p) => events.push(...p.value));
  const done = new Promise((res) => page.on('Tracing.tracingComplete', res));
  await page.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'toplevel',
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'v8',
      ],
    },
  });
  await sleep(TRACE_MS);
  await page.send('Tracing.end');
  await done;
  const names = new Map();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
  // The page's main thread is the CrRendererMain that ran animation frames.
  const rafBy = new Map();
  for (const e of events)
    if (e.name === 'FireAnimationFrame' && names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain')
      rafBy.set(`${e.pid}:${e.tid}`, (rafBy.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
  const main = [...rafBy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return { invalid: 'no CrRendererMain with animation frames in the trace' };
  const on = events.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && e.dur);
  const ts = on.map((e) => e.ts);
  const span = (Math.max(...ts) - Math.min(...ts)) / 1000 || TRACE_MS;
  // Busy = the union of top-level tasks, so a nested task is not counted twice.
  const top = on
    .filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')
    .sort((a, b) => a.ts - b.ts);
  let busy = 0;
  let end = -Infinity;
  for (const e of top) {
    const s0 = Math.max(e.ts, end);
    const e1 = e.ts + e.dur;
    if (e1 > s0) busy += e1 - s0;
    end = Math.max(end, e1);
  }
  const inclusive = {};
  for (const n of MAIN_NAMES) {
    const d = on.filter((e) => e.name === n).reduce((a, e) => a + e.dur, 0);
    if (d) inclusive[n] = round((100 * d) / 1000 / span);
  }
  const raf = on
    .filter((e) => e.name === 'FireAnimationFrame')
    .map((e) => e.dur / 1000)
    .sort((a, b) => a - b);
  const q = (p) => round(raf[Math.min(raf.length - 1, Math.floor(p * raf.length))]);
  return {
    spanMs: round(span),
    busyPct: round((100 * busy) / 1000 / span),
    inclusivePct: inclusive,
    rafPerSec: round((1000 * raf.length) / span),
    rafMsP50: q(0.5),
    rafMsP95: q(0.95),
  };
}

/** What a viewer gets: of the frames x11grab took off the display, how many repeat the one before.
 * x11grab samples on its own clock, so whenever the screen has not changed since the last sample the
 * encoder is handed the same frame twice, however many frames the page says it drew. */
function sourceRepeats(md5File, fps) {
  try {
    const hashes = readFileSync(md5File, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',').pop().trim());
    let repeats = 0;
    for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) repeats++;
    return {
      frames: hashes.length,
      distinctPerSec: round(((hashes.length - repeats) * fps) / hashes.length),
      repeatPct: round((100 * repeats) / hashes.length),
    };
  } catch (e) {
    return { invalid: String(e?.message ?? e).slice(0, 120) };
  }
}

/** Measure one window: CPU % of a core per named root (tree resolved at window start), and box idle %. */
async function measure(page, roots) {
  const trees = Object.fromEntries(
    Object.entries(roots).map(([k, pid]) => [k, pid ? tree(pid) : []]),
  );
  await page.evaluate(PROBE);
  const d0 = await page.evaluate('__office.stats().draws');
  const c0 = Object.fromEntries(Object.entries(trees).map(([k, p]) => [k, ticks(p)]));
  const th0 = threadTicks(trees.chrome ?? []);
  const b0 = boxIdle();
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const secs = (Date.now() - t0) / 1000;
  const d1 = await page.evaluate('__office.stats().draws');
  const gaps = (await page.evaluate('JSON.stringify(window.__gaps)')) ?? '[]';
  const tickList = JSON.parse((await page.evaluate('JSON.stringify(window.__ticks)')) ?? '[]')
    .slice(1)
    .sort((a, b) => a - b);
  const b1 = boxIdle();
  const th1 = threadTicks(trees.chrome ?? []);
  const threads = Object.fromEntries(
    Object.entries(th1)
      .map(([k, v]) => [k, round((100 * (v - (th0[k] ?? 0))) / HZ / secs)])
      .filter(([, v]) => v >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
  );
  const cpu = {};
  for (const [k, p] of Object.entries(trees))
    cpu[k] = round((100 * (ticks(p) - c0[k])) / HZ / secs);
  cpu.pipeline = round(Object.values(cpu).reduce((a, b) => a + b, 0));
  cpu.idlePct = round((100 * (b1.idle - b0.idle)) / (b1.total - b0.total));
  const g = JSON.parse(gaps).sort((a, b) => a - b);
  const q = (p) => (g.length ? round(g[Math.min(g.length - 1, Math.floor(p * g.length))]) : null);
  const tq = (p) =>
    tickList.length
      ? round(tickList[Math.min(tickList.length - 1, Math.floor(p * tickList.length))])
      : null;
  return {
    drawsPerSec: round((d1 - d0) / secs),
    gapP50Ms: q(0.5),
    gapP95Ms: q(0.95),
    // The bar's tail, as a share: gaps a viewer sees as a held frame (> 40 ms).
    gapsOver40Pct: g.length ? round((100 * g.filter((x) => x > 40).length) / g.length) : null,
    // The rAF cadence the page is given (Chrome's BeginFrames), which the draw coalescer beats against.
    rafHz: round(tickList.length / secs),
    tickP50Ms: tq(0.5),
    tickP95Ms: tq(0.95),
    cpu,
    threads,
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

// ── Arms S and X: the real `musterd broadcast` pipeline, screencast or `--capture x11` ──────────────
async function armCli(label, capture = 'screencast', fps = FPS) {
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
      String(fps),
      '--duration',
      String(SECS + 40),
      '--out',
      out,
      ...(capture === 'x11' ? ['--capture', 'x11'] : []),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // Forwarded as it arrives, and read for the draw floor's one-shot report — the bar wants it silent.
  let floorFired = false;
  cli.stderr.on('data', (d) => {
    process.stderr.write(d);
    if (/under the \d+\/s floor/.test(String(d))) floorFired = true;
  });
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
    const xvfbPid =
      capture === 'x11' ? Number(execFileSync('pgrep', ['-n', 'Xvfb']).toString().trim()) : 0;
    const r = await measure(page, {
      chrome: chromePid,
      ffmpeg: ffmpegPid,
      ...(xvfbPid ? { xvfb: xvfbPid } : {}),
      cli: cli.pid,
    });
    // the CLI tree contains chrome, ffmpeg and (x11) Xvfb; report it as its own residue, not
    // double-counted
    r.cpu.cli = round(r.cpu.cli - r.cpu.chrome - r.cpu.ffmpeg - (r.cpu.xvfb ?? 0));
    r.cpu.pipeline = round(r.cpu.chrome + r.cpu.ffmpeg + (r.cpu.xvfb ?? 0) + r.cpu.cli);
    r.main = await mainThreadSplit(page).catch((e) => ({ invalid: String(e?.message ?? e) }));
    page.close();
    return { arm: label, ...r, floorFired };
  } finally {
    kill(cli);
    await waitExit(cli);
  }
}

// ── Arm XA: the ad-hoc Xvfb + headful Chromium + ffmpeg x11grab of increment 1 ──────────────────
// `query` is appended to the page URL: `&dirty=0` is ADR 625's A/B arm.
//
// `x11-adhoc~<variant>` (lane 01M55MAQ9M) runs it with extra Chromium flags and/or a page draw rate
// apart from the encode rate, to test whether the tail comes from the BeginFrame cadence the
// compositor gives the page rather than from the page's own drawing.
// A variant is `+`-joined tokens: `base` (none), `novsync` (the two flags below), `pageNN` (the page
// draws at NN while ffmpeg still encodes at --fps), `nvenc` (encode on the GPU), `gpu` (composite on the GPU, the flags the
// 2026-10-13 L4 trial found working).
function parseVariant(v) {
  const out = { flags: [], pageFps: undefined, encoder: ['libx264', '-preset', 'veryfast'] };
  for (const t of v.split('+')) {
    if (t === 'base') continue;
    else if (t === 'novsync') out.flags.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
    // NVENC, the GPU's own encoder, instead of `libx264`, which is a full core or more at 1080p30.
    else if (t === 'nvenc') out.encoder = ['h264_nvenc', '-preset', 'p4', '-tune', 'll'];
    else if (t === 'gpu')
      out.flags.push(
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--use-angle=gl-egl',
      );
    else if (/^page\d+$/.test(t)) out.pageFps = Number(t.slice(4));
    else throw new Error(`unknown variant token ${t}`);
  }
  return out;
}
async function armX11(label, query = '', fps = FPS) {
  const variant = parseVariant(/~(.+?)(?:@|#|$)/.exec(label)?.[1] ?? 'base');
  const extraFlags = variant.flags;
  const pageFps = variant.pageFps ?? fps;
  const DISPLAY = EXT_DISPLAY ?? ':99';
  const xvfb = EXT_DISPLAY
    ? undefined
    : spawn('Xvfb', [DISPLAY, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
        stdio: 'ignore',
      });
  // The X server's CPU is part of the pipeline either way.
  const xPid = xvfb?.pid ?? Number(execFileSync('pgrep', ['-o', 'Xorg']).toString().trim());
  if (xvfb) await sleep(1500);
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
      ...extraFlags,
      // Blank first: the seat is injected over CDP before /broadcast loads (ADR 594), never in argv.
      'about:blank',
    ],
    { env: { ...process.env, DISPLAY }, stdio: 'ignore' },
  );
  const out = join(mkdtempSync(join(tmpdir(), 'cab-x-')), 'x.mp4');
  let ffmpeg;
  try {
    const page = await cdpPage(9333, 'about:blank');
    // As broadcast.ts does: without Page.enable the injected script never ran (seat:false, 2026-10-14).
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__musterdBroadcastSeat = ${JSON.stringify(SEAT)};`,
    });
    await page.send('Page.navigate', {
      url: `${SERVER}/broadcast?team=${TEAM}&fps=${pageFps}${query}`,
    });
    if (!(await waitForRoom(page))) {
      // Say what the page saw, so an empty room is a reading rather than a guess.
      const seen = await page.evaluate(
        'JSON.stringify({ href: location.href, seat: !!window.__musterdBroadcastSeat, ' +
          'ready: window.__broadcastReady === true, vis: document.visibilityState, ' +
          'text: document.body?.innerText?.slice(0, 160) })',
      );
      return { arm: label, invalid: `empty room (no posed actors) ${seen}` };
    }
    ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'x11grab',
        '-framerate',
        String(fps),
        '-video_size',
        '1920x1080',
        '-i',
        DISPLAY,
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=44100:cl=stereo',
        '-c:v',
        ...variant.encoder,
        '-b:v',
        '4500k',
        '-maxrate',
        '4500k',
        '-bufsize',
        '9000k',
        '-g',
        String(fps * 2),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-t',
        String(SECS + 20),
        '-y',
        out,
        // A second output: a fingerprint of every raw grabbed frame, before the encoder, so a repeat
        // is exact. Scaled down first, which is cheap and still changes when any pixel block does.
        '-map',
        '0:v',
        '-vf',
        'scale=192:108:flags=area',
        '-t',
        String(SECS + 20),
        '-f',
        'framemd5',
        '-y',
        out.replace(/\.mp4$/, '.md5'),
      ],
      { env: { ...process.env, DISPLAY }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    await sleep(WARMUP_MS);
    const r = await measure(page, { chrome: chrome.pid, ffmpeg: ffmpeg.pid, xvfb: xPid });
    r.gpu = await gpuInfo(9333).catch((e) => ({ invalid: String(e?.message ?? e) }));
    r.main = await mainThreadSplit(page).catch((e) => ({ invalid: String(e?.message ?? e) }));
    page.close();
    kill(ffmpeg);
    await waitExit(ffmpeg);
    r.source = sourceRepeats(out.replace(/\.mp4$/, '.md5'), fps);
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
// S first and X-cli last, so neither CLI arm only ever sees a warm or a cold box.
const ARMS = [
  [armCli, 'screencast', 'screencast'],
  [armCli, 'x11-cli#1', 'x11'],
  [armX11, 'x11-adhoc', ''],
  [armX11, 'x11-adhoc dirty=0', '&dirty=0'],
  [armCli, 'x11-cli#2', 'x11'],
  [armCli, 'x11-cli#3', 'x11'],
  [armCli, 'x11-cli#4', 'x11'],
];
const plan = ONLY.length
  ? ONLY.map((want) => {
      const [base, at] = want.split('@');
      const arm =
        ARMS.find(([, l]) => l === base) ?? ARMS.find(([, l]) => l === base.replace(/~.*$/, ''));
      if (!arm) throw new Error(`unknown arm ${base}`);
      return [arm[0], at ? `${base}@${at}` : base, arm[2], at ? Number(at) : FPS];
    })
  : ARMS.slice(0, 5).map(([fn, l, a]) => [fn, l, a, FPS]);
for (const [fn, label, arg, fps] of plan) {
  const r = await fn(label, arg, fps).catch((e) => ({
    arm: label,
    invalid: String(e?.message ?? e),
  }));
  console.log(`CAPTURE_AB ${JSON.stringify(r)}`);
  results.push(r);
  await sleep(5000);
}
console.log(`CAPTURE_AB_FPS ${FPS}`);
console.log(
  '| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % | floor |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  if (r.invalid) console.log(`| ${r.arm} | invalid: ${r.invalid} |`);
  else {
    const c = r.cpu;
    console.log(
      `| ${r.arm} | ${r.drawsPerSec} | ${r.gapP50Ms} | ${r.gapP95Ms} | ${c.chrome} | ${c.ffmpeg} | ${c.xvfb ?? '—'} | ${c.cli ?? '—'} | ${c.pipeline} | ${c.idlePct} | ${r.floorFired === undefined ? '—' : r.floorFired ? 'fired' : 'silent'} |`,
    );
  }
}
console.log('CAPTURE_AB_DONE');
