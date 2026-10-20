#!/usr/bin/env node
/**
 * The live-loads-fast bar (docs/superpowers/specs/2026-10-13-live-loads-fast-design.md §5), measured on
 * the page's own markers rather than paint events: a paint metric cannot tell a skeleton from a team card.
 *
 *   warm  — this browser holds a /live snapshot: ms from navigation to the first real team card
 *   cold  — no snapshot: ms from navigation to the first skeleton (`.lc-skel`)
 *   answer — ms from navigation to the daemon's answer replacing them: a real card on screen, no
 *            skeleton left, and the meter present and no longer reading `refreshing…` (a meter that has
 *            not rendered yet does not count as answered)
 *
 * Usage:
 *   node scripts/perf/live-paint-bar.mjs <live url> (--signin-url-file <file> | --identity-file <file>)
 *     [--runs 5] [--json out.json] [--shots <dir>]
 *
 * --signin-url-file holds a one-shot sign-in URL from `musterd live --print --no-open`, run by a human in
 * their own Workspace (a nonce, dead after one use or 60 s). --identity-file is `{as, token}` JSON — the
 * shape `scripts/a11y/fixture-team.sh` writes — set as this browser's remembered member. Either is read
 * and used, never printed. --shots saves a screenshot of any run that saw no marker at all. Warm runs reload with the snapshot the sign-in visit left;
 * each cold run first clears this team's `musterd.live.v1:*` snapshot from a non-app page on the same
 * origin, so the app cannot write it back between the clear and the navigation.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const signinFile = flag('signin-url-file');
const identityFile = flag('identity-file');
const SHOTS = flag('shots');
if (!url || (!signinFile && !identityFile)) {
  console.error(
    'usage: live-paint-bar.mjs <live url> (--signin-url-file <file> | --identity-file <file>) [--runs 5] [--json out.json] [--shots <dir>]',
  );
  process.exit(2);
}
const RUNS = Number(flag('runs') ?? 5);
const JSON_OUT = flag('json');
const TIMEOUT_MS = 20_000;

const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'live-paint-bar-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
process.on('exit', () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best-effort: Chrome may still be flushing its profile as we exit
  }
});

let targets;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}
const page = targets?.find((t) => t.type === 'page');
if (!page) throw new Error('Chrome DevTools endpoint never came up');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
// Markers from document start: each records the first performance.now() its condition held.
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__bar = { card: null, skel: null, answer: null };
    (() => {
      const check = () => {
        const b = window.__bar, t = performance.now();
        const card = document.querySelector('.lc-team-card:not(.lc-team-card--skel)');
        const skel = document.querySelector('.lc-skel');
        const meter = document.querySelector('.lc-meter__span');
        if (card && b.card === null) b.card = t;
        if (skel && b.skel === null) b.skel = t;
        if (card && !skel && meter && meter.textContent !== 'refreshing…' && b.answer === null) b.answer = t;
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
    })();
  `,
});

const navigate = async (to) => {
  await send('Page.navigate', { url: to });
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const b = await evaluate('window.__bar && window.__bar.answer !== null ? window.__bar : null');
    if (b) return b;
    await sleep(100);
  }
  return (await evaluate('window.__bar')) ?? { card: null, skel: null, answer: null };
};

// Measure on the sign-in link's own origin: `localhost` and `127.0.0.1` are different origins to the
// browser, so a session redeemed on one is not there on the other (the first hub run, 2026-10-20).
const signinUrl = signinFile ? new URL(readFileSync(signinFile, 'utf8').trim()) : null;
const target = new URL(url);
if (signinUrl) target.host = signinUrl.host;
const measured = target.toString();
const origin = target.origin;
const team = target.searchParams.get('team') ?? '';
let shot = 0;
const capture = async (label) => {
  if (!SHOTS) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(
    join(SHOTS, `${String(++shot).padStart(2, '0')}-${label}.png`),
    Buffer.from(data, 'base64'),
  );
};

// Sign in once; the visit also leaves this browser's snapshot for the warm runs.
if (identityFile) {
  const id = JSON.parse(readFileSync(identityFile, 'utf8'));
  await send('Page.navigate', { url: `${origin}/health` });
  await sleep(500);
  await evaluate(
    `localStorage.setItem(${JSON.stringify(`musterd.member.v1.${team}`)}, ${JSON.stringify(JSON.stringify({ as: id.as, token: id.token }))})`,
  );
  await navigate(measured);
} else {
  await navigate(signinUrl.toString());
}
await sleep(5_000);
const signedIn = await evaluate(
  "!!document.querySelector('.lc-team') && !document.querySelector('input[type=password]')",
);
if (!signedIn) {
  await capture('signin-failed');
  console.error(
    '✗ not signed in after the sign-in visit — the page has no team column' +
      (SHOTS ? ` (see ${SHOTS})` : ''),
  );
  process.exit(1);
}

const warm = [];
for (let i = 0; i < RUNS; i++) {
  warm.push(await navigate(measured));
  if (warm.at(-1).card === null && warm.at(-1).skel === null) await capture(`warm-${i + 1}-empty`);
  await sleep(3_000); // let the page write its fresh snapshot
}
const cold = [];
for (let i = 0; i < RUNS; i++) {
  await send('Page.navigate', { url: `${origin}/health` });
  await sleep(500);
  await evaluate(
    `Object.keys(localStorage).filter((k) => k.startsWith('musterd.live.v1:${team}:')).forEach((k) => localStorage.removeItem(k))`,
  );
  cold.push(await navigate(measured));
  if (cold.at(-1).card === null && cold.at(-1).skel === null) await capture(`cold-${i + 1}-empty`);
}

const median = (xs) => {
  const v = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.floor((v.length - 1) / 2)]) : null;
};
const fmt = (xs) => xs.map((x) => (x === null ? '—' : Math.round(x))).join(', ');
const result = {
  url: measured,
  at: new Date().toISOString(),
  runs: RUNS,
  warm_card_ms: { median: median(warm.map((b) => b.card)), runs: warm.map((b) => b.card) },
  cold_skeleton_ms: { median: median(cold.map((b) => b.skel)), runs: cold.map((b) => b.skel) },
  answer_ms_warm: { median: median(warm.map((b) => b.answer)), runs: warm.map((b) => b.answer) },
  answer_ms_cold: { median: median(cold.map((b) => b.answer)), runs: cold.map((b) => b.answer) },
};
console.log(`== ${measured} @ ${result.at} (${RUNS} runs each) ==`);
console.log(
  `warm  · first team card   median ${result.warm_card_ms.median} ms  [${fmt(result.warm_card_ms.runs)}]   bar ≤ 1000`,
);
console.log(
  `cold  · first skeleton    median ${result.cold_skeleton_ms.median} ms  [${fmt(result.cold_skeleton_ms.runs)}]   bar ≤ 500`,
);
console.log(
  `answer (warm visits)      median ${result.answer_ms_warm.median} ms  [${fmt(result.answer_ms_warm.runs)}]   bar ≤ 3000`,
);
console.log(
  `answer (cold visits)      median ${result.answer_ms_cold.median} ms  [${fmt(result.answer_ms_cold.runs)}]   bar ≤ 3000`,
);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
process.exit(0);
