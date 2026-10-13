# /live loads fast — what was measured, what each lane bought, what is left

**Date:** 2026-10-13
**Seat:** miley
**Status:** records what shipped 2026-10-12 → 2026-10-13 under goal `live-loads-fast`; §5 proposes the
bar that lets the goal ship and the lanes still needed. The bar is proposed, not approved.
**Lane:** `01M4V74C8G`

## 1. What this is for

The goal `live-loads-fast` reads: *opening /live shows the team straight away instead of empty panels
for 5–10 seconds.* Eight lanes shipped against it in two days, four on the page and four on the
daemon, each from a measurement. The measurements live in `docs/perf/web-live-baseline.md` entries
and in commit bodies; the goal itself has no record that says what "fast" is, so nobody can say when
it is done, and the one lane still open (`01M4RNCZVB`) has no bar to be judged against. This spec is
that record. It adds no behaviour. Where a number here and the baseline log disagree, the log is right
and this document has a bug.

## 2. What was wrong (measured 2026-10-12, revive, the hub)

nick: /live took 5–10 s to show anyone. One reload, instrumented:

- every script was in by **140 ms**; the page painted at **248 ms** with no long tasks;
- the first data request did not leave until **1.1–1.4 s** — `/live` was served the homepage shell,
  which booted the home page (office still, three Twitch preconnects, site CSS) before the router
  switched to /live and fetched its chunk;
- each daemon read then took **3–4.4 s** on a saturated daemon (80% CPU, load 13), and until the
  reads landed the panels said "0 working", "no open questions" and "nothing loaded" — wrong, not
  empty;
- on the daemon, `POST /residency/wake-leases` took **5–5.6 s every ~5.1 min** and was 84% of the
  Air's handler time; on the hub `claimWakeLeases` held the SQLite transaction **1–2.2 s** per poll,
  and every other statement waited behind it; a cold `/report` took **16–26 s** on the Air's data.

So "5–10 s" was three things stacked: a wrong page shell, a page that showed nothing until the
slowest read answered, and a daemon that answered slowly because unrelated periodic work held its
one SQLite queue.

## 3. What each lane bought

| Lane | What | Measured |
| --- | --- | --- |
| `01M4RNDKHX` (#2387) | `/live` is served its own prerendered page, not the root shell: a directory with an `index.html` is served that page | the ~1.1–1.4 s before the first data request, gone; `/broadcast` and `/board` get the same |
| `01M4RNDW6Z` (#2376) | `SeatDetail` and `LogDrawer` leave the eager graph: `lazy()` on a card's first expand and while the drawer is open | /live initial JS 141,696 → 140,229 B; main had sat 4 B under the ceiling and a chunk hash alone turned PRs red |
| `01M4RNBNFM` (#2385) | the page paints this browser's last snapshot at once (`liveCache.ts`: roster, newest 120 envelopes, open lanes, ~119 KB in localStorage) marked `refreshing…`; a first visit draws skeletons | team, asks strip and meter on screen at **~0.6 s**; the daemon's answer replaced them at 6.1 s. Live CSS 20.9 → 21.1 KB, at its ceiling |
| `01M4S0ZAG8` (#2401, #2416, #2423) | the wake poll reads each member once and seeks audit by target (v92); a slow request line names its socket and the SQLite transaction that held the queue | 2,051 member reads per poll → ~30; the diagnostics that found the next two |
| `01M4S7GW7P` (#2440) | cold `/report`: a v93 index and two query rewrites | `deriveReport` 22.5 s → 4.1 s on the Air's 23.7k messages |
| `01M4SDYXKC` (#2452, ADR 576) | `claimWakeLeases` works out leases outside any transaction, rechecks and writes in a short one; a partial unique index keeps one live lease per seat on Postgres too | the 1–2.2 s hold per poll, gone; ADR 131 §4's never-start-twice guarantee kept by the index |
| `01M4S4FGTK` (#2418) | chrome cut: the headline ticker retired on /live and /broadcast, denser team cards, the holds banner only in force | less to paint on first paint; one fewer windowed list |
| `01M4S7YD4X` (#2436) | palette: nameplates back to full ink, the lane/handoff family blue | not a load change; under the goal because it shipped in the same pass |

Budgets after all eight, on `a901aae1` (2026-10-13): /live initial JS **138.0 KB** of 141.2, total
JS **301.8 KB** of 302.7, live CSS **21.0 KB** of 21.1.

## 4. The model

Three clocks, and the goal is about the first two:

1. **Time to first honest paint.** From navigation to the team column showing cards. Warm (this
   browser has a snapshot): the snapshot, marked `refreshing…`. Cold: skeletons. Both are honest
   because neither asserts a count the daemon has not given.
2. **Time to the daemon's answer.** From navigation to the snapshot or skeletons being replaced by
   live data. This is the daemon's read latency plus the page's request fan-out, and it is what the
   four server lanes moved.
3. **Bytes.** The perf budgets. They bound how much the page can grow; they are not the goal.

What the snapshot cannot do: it cannot make the daemon's answer arrive sooner, and a saturated daemon
still answers in seconds. The two clocks are improved by different lanes and must be measured apart.

## 5. The bar, and what is still to build

Proposed bar for shipping the goal, measured with `scripts/perf/live-baseline.mjs` against the hub
(method at the top of `web-live-baseline.md`), five reloads, the median:

- warm visit: the team column shows cards **≤ 1.0 s** after navigation (measured 0.6 s);
- cold visit: skeletons **≤ 0.5 s** after navigation;
- the daemon's answer replaces them **≤ 3.0 s** after navigation when the daemon is under its
  ordinary load (the hub's weekday afternoon), and the lanes fetch is no longer the slowest read.

The third line is where the goal is not yet met: the lanes read carries every lane ever (227 KB on
revive) when the page needs open lanes plus the viewer's tour lane.

| # | Lane | What | Done when |
| --- | --- | --- | --- |
| 1 | `01M4RNCZVB` | the lanes fetch carries open lanes and the viewer's tour lane, not every lane ever; the board overlay and the Now card's done counts fetch the rest on use | the /live lanes response on revive is under 40 KB; the Now card's "d of n done" and the wall board's done column still agree with `/board` |
| 2 | opened at increment 1's close | the bar above measured on the hub and recorded as a dated note in `web-live-baseline.md`; the goal outcome written from it | five-reload medians for the three lines, with the daemon's load noted; the goal ships if all three hold, or this section says which did not and why |

Increment 2 is a measurement lane, not a build; it exists so the goal closes on a number rather than on
a feeling. If increment 1 lands and the third line still fails, the next lane is on the daemon's read
path, not the page, and belongs under `live-loads-fast` with its own measurement first.

## 6. Non-goals

- Moving `totalJsGzipBytes` by splitting: lazy-loading cannot (ADR 183), and entry-chunk splitting was
  measured and rejected (the entry is framework runtime).
- A server-push of board data to the page: the snapshot plus a fast read is enough for the bar; a
  live push is lane `01M3TAMZQH`, parked.
- Faster daemon reads under saturation beyond what the four lanes did: a saturated daemon is a
  capacity question, and the `ci-cost`/`cloud` goals own the machine.

## 7. Falsifiers

- The first-paint claim: open /live warm, reload; the team column shows cards before the daemon's
  `/teams/<team>` response completes. If not, `liveCache.ts` is not being read on mount.
- The 1.4 s claim: `curl -s localhost:4849/live?team=revive | head -c 300` shows the /live page, not
  the root shell's homepage preloads. If it shows the homepage, #2387 regressed.
- The 227 KB claim: the /live lanes response on revive, from the browser's network panel, before
  increment 1. After it, under 40 KB.
