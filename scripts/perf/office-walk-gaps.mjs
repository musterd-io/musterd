#!/usr/bin/env node
/**
 * Office walk gaps (ADR 686): how long does the room go with nobody on their feet?
 *
 * Samples `window.__office.floorSamples()` every 500 ms. A figure is walking in a sample when it moved
 * more than 1.5 floor units since the previous one. Reports walk starts per minute, the share of time
 * someone is walking, and the still stretches between walks (median, p90, longest). The bar is the
 * longest still stretch: at most 90 s in a 10-minute run on any room with at least one idle member.
 *
 * Fixture: `/office-preview?quiet` (the ambient scheduler live, no looping choreography), sized with
 * `n=` and given idle members with `idle=<names>` or `idle=all`. Run it against `pnpm dev`.
 *
 * Usage:
 *   node scripts/perf/office-walk-gaps.mjs 'http://localhost:5174/office-preview?quiet&n=14&idle=all' [minutes]
 */
import { openChromePage } from '../a11y/chrome.mjs';

const [url, minutes = '20'] = process.argv.slice(2);
const { send, exit } = await openChromePage({ tool: 'office-walk-gaps', windowSize: '1440,900' });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 8000));
const evalv = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
let prev = new Map(),
  stillSince = Date.now(),
  longest = 0,
  walkingMs = 0,
  starts = 0,
  moving = new Set();
const gaps = [];
const end = Date.now() + Number(minutes) * 60_000;
let figures = 0;
let last = Date.now();
while (Date.now() < end) {
  const s = (await evalv('window.__office?.floorSamples?.() ?? null')) ?? [];
  figures = Math.max(figures, s.length);
  const now = Date.now();
  const nowMoving = new Set();
  for (const p of s) {
    const q = prev.get(p.name);
    if (q && Math.hypot(p.lx - q.lx, p.ly - q.ly) > 1.5) nowMoving.add(p.name);
    prev.set(p.name, p);
  }
  for (const n of nowMoving) if (!moving.has(n)) starts++;
  if (nowMoving.size) {
    if (!moving.size) {
      const g = now - stillSince;
      gaps.push(g);
      longest = Math.max(longest, g);
    }
    walkingMs += now - last;
  } else if (moving.size) stillSince = now;
  moving = nowMoving;
  last = now;
  await new Promise((r) => setTimeout(r, 500));
}
if (!moving.size) {
  const g = Date.now() - stillSince;
  gaps.push(g);
  longest = Math.max(longest, g);
}
const log = (await evalv('window.__office?.ambientLog?.() ?? []')) ?? [];
gaps.sort((a, b) => a - b);
const q = (f) => Math.round((gaps[Math.floor((gaps.length - 1) * f)] ?? 0) / 1000);
console.log(
  JSON.stringify({
    url,
    minutes: Number(minutes),
    figures,
    walk_starts_per_min: +(starts / Number(minutes)).toFixed(2),
    share_of_time_someone_walking: +(walkingMs / (Number(minutes) * 60_000)).toFixed(3),
    still_gap_s: {
      median: q(0.5),
      p90: q(0.9),
      longest: Math.round(longest / 1000),
      n: gaps.length,
    },
    ambient_kinds: log
      .filter((e) => e.played)
      .reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {}),
  }),
);
await exit(0);
