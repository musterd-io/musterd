# /broadcast smooth capture — Implementation Plan (increment 1 in full; 2–4 after its stop rule)

> Implement in your own seat (AGENTS.md hard rule 8). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether recording the screen (Xvfb + `x11grab`) frees at least a core over today's
CDP screencast at 1080p30 on Fly `performance-4x`. Plan increments 2–4 only once that answer is in.

**Architecture:** A self-driving bench run. The bench image starts the synthetic fixture and runs two
arms back to back against it: the real `musterd broadcast` screencast pipeline, and an ad-hoc Xvfb +
headful Chromium + `ffmpeg -f x11grab` pipeline. The same in-page probe and process sampler run in
both arms. Results go to stdout, so `fly logs` reads them and nobody has to `fly ssh` into the box.

**Tech Stack:** Node 22 (no new dependencies), Chromium and ffmpeg from Debian bookworm, Xvfb, Fly
Machines.

**Spec:** [`docs/superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md`](../specs/2026-10-13-broadcast-smooth-capture-design.md)

## Global Constraints

- The bar (spec §"The bar"): ≥ 30 draws/s sustained over 60 s, a p95 draw-to-draw gap under 40 ms, a
  flat encoder queue, and some idle CPU, all on Fly `performance-4x`.
- No production code in increment 1. Only `scripts/perf/**` and `docs/perf/broadcast-baseline.md`
  change.
- No new runtime dependency.
- The fixture is synthetic and never a copy of the live DB (`broadcast-bench-fixture.sh`'s header).
- No Twitch key on the box. Both arms write to a file sink.
- Stop rule: if the x11 arm frees less than one core (a pipeline CPU drop of < 100 percentage points
  against the screencast arm at the same draw rate or better), stop and rethink before increment 2.

## Review Focus

1. **An empty room reads as a fast room.** If seats are offline, the scene draws bare furniture and
   both arms look cheap. The run must assert posed actors (`__office.floorSamples().length > 0`) before
   sampling, and abort otherwise (the wiki trap in `canvas-raster-vs-js.md`).
2. **A parked room reads as zero draws.** The fixture's act driver must be beating. The probe reports
   draws/s, and a draws/s under 5 aborts the arm as invalid rather than recording it.
3. **Browser chrome in the frame.** Headful Chromium can paint an infobar or a restore bubble into the
   x11 capture. Step 6 checks the x11 arm's first frame by eye.
4. **CPU attribution across Xvfb.** In the x11 arm, Xvfb does real work (the XShm copy and its own
   rendering). It is counted in that arm's pipeline total, or the arm looks cheaper than it is.
5. **Arm order bias.** The second arm runs on a warmer box. The arms run S, X, S, and the S result is
   the mean of its two runs.

---

### Task 1: The two-arm bench script

**Files:**
- Create: `scripts/perf/capture-ab.mjs`
- Modify: `scripts/perf/broadcast-bench.Dockerfile` (adds `xvfb`, plus a self-driving `CMD`)
- Create: `scripts/perf/capture-ab.sh` (entrypoint: fixture up, run arms, keep idling)

**Interfaces:**
- Consumes: `packages/cli/dist/commands/broadcast-perf.js` exports `cpuOfTree(pid)` and `cpuTotal()`
  (already used by `broadcast.ts`); the page's `window.__office.stats()` and
  `window.__office.floorSamples()`.
- Produces: one stdout line per arm, `CAPTURE_AB {json}`, with keys `arm`, `drawsPerSec`, `gapP95Ms`,
  `gapP50Ms`, `cpu: {chrome, ffmpeg, xvfb, pipeline, idlePct}` and `secs`. A markdown table row is
  printed after all arms.

- [ ] **Step 1: Read the CPU helpers' real signatures** before calling them:
  `grep -n "export function" packages/cli/src/commands/broadcast-perf.ts`. Use exactly what is
  exported. If `cpuOfTree` takes a sampling window rather than a pid, adapt the call in step 2 to that
  signature.
- [ ] **Step 2: Write `capture-ab.mjs`.** Its parts:
  - `probe(port)`: over CDP (the `/json/list` + WebSocket pattern from `broadcast-baseline`'s
    `connectCdp`), inject
    `window.__gaps=[];let d=__office.stats().draws,t=performance.now();(function f(){const s=__office.stats().draws;if(s!==d){const n=performance.now();__gaps.push(n-t);t=n;d=s}requestAnimationFrame(f)})()`,
    then after `secs` read `__gaps` and the draw delta. The p95 and p50 are computed in Node.
  - `armScreencast()`: spawn `node packages/cli/dist/bin.js broadcast --team bench --server $SERVER --fps 30 --duration $SECS --out /tmp/s.mp4`,
    find its Chromium's `--remote-debugging-port` from `ps -eo args`, and run `probe` against it.
  - `armX11()`: spawn `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp`. Then spawn
    `chromium --no-sandbox --disable-dev-shm-usage --no-first-run --user-data-dir=<tmp> --kiosk --window-size=1920,1080 --window-position=0,0 --force-device-scale-factor=1 --remote-debugging-port=9333 "$SERVER/broadcast?team=bench&fps=30"`
    with `DISPLAY=:99`. Wait for `floorSamples().length > 0`. Spawn
    `ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :99 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -preset veryfast -b:v 4500k -maxrate 4500k -bufsize 9000k -g 60 -pix_fmt yuv420p -c:a aac -shortest -t $SECS /tmp/x.mp4`,
    then `probe(9333)`. Save one frame for the eye check:
    `ffmpeg -ss 30 -i /tmp/x.mp4 -frames:v 1 /tmp/x-frame.png`, and print its base64 size only. The
    frame is read from the box in step 6.
  - The sampler: every 1 s during an arm, `cpuOfTree` for the Chromium root, ffmpeg and Xvfb, plus
    whole-box idle from `/proc/stat`. The arm reports means.
  - Guards: abort an arm with `CAPTURE_AB {"arm":…,"invalid":"<reason>"}` if
    `floorSamples().length === 0` at the start or draws/s < 5.
  - Order: S, X, S. Print the three `CAPTURE_AB` lines and the table rows.
- [ ] **Step 3: Write `capture-ab.sh`:** `scripts/perf/broadcast-bench-fixture.sh up`, wait until
  `/teams/bench/members` shows the seats present, run `node scripts/perf/capture-ab.mjs --secs 60`,
  then `sleep infinity`.
- [ ] **Step 4: Update the Dockerfile:** add `xvfb` and `xauth` to the apt line, and set
  `CMD ["bash", "scripts/perf/capture-ab.sh"]`. Keep the header's "measurement rig" note, and add one
  line saying the default run is the capture A/B.
- [ ] **Step 5: Run the local fast gates:** `pnpm lint && pnpm format:check`. Expected: pass. Commit.

### Task 2: Run it on Fly and record the rows

- [ ] **Step 6: Deploy and read.**
  `fly deploy -c scripts/perf/broadcast-bench.fly.toml --remote-only` (it creates app
  `musterd-bench`). Then `fly logs -a musterd-bench --no-tail | grep CAPTURE_AB`, repeated until three
  lines arrive (about 5 minutes). Read the x11 frame with
  `fly ssh sftp get /tmp/x-frame.png -a musterd-bench`. If ssh is not permitted, ask nick to run that
  one command, or skip the eye check and note that in the doc.
- [ ] **Step 7: Destroy the box:** `fly apps destroy musterd-bench --yes`, then confirm with
  `fly apps list | grep musterd-bench`, which should print nothing.
- [ ] **Step 8: Record.** Add a dated section to `docs/perf/broadcast-baseline.md` with both rows, the
  gap p50/p95, the stop-rule verdict, and the falsifier. Commit, open the PR (`Lane \`01M4VS17JX…\``
  on line 1), and arm auto-merge.
- [ ] **Step 9: Decide.** If the stop rule passes, write the increment 2 plan (append it here) and
  claim `01M4VS1F2V`. If it fails, tell nick what was measured and stop.

## Increments → lanes

| Increment | Lane | Planned |
| --- | --- | --- |
| 1 — measure x11grab vs screencast | `01M4VS17JXV4G9AVFPB7W7A6ZW` | here, in full |
| 2 — `--capture x11` | `01M4VS1F2V95QF8KX4YAZKJCEJ` | after increment 1's stop rule |
| 3 — dirty-rect repaint | `01M4VS1SJQP5362ZHPRCX9F9RK` | after increment 1's numbers |
| 4 — measure against the bar; flip ADR | `01M4VS22F19WBSG5Y82Z4MYW69` | after 2 and 3 |
