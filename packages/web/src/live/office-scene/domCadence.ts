/**
 * Broadcast only: the page's DOM animations advance at the office's draw cadence instead of the
 * display's 60Hz.
 *
 * Why. The stream box has no GPU, so Chrome composites in software, and the compositor produces a
 * frame whenever anything on the page is damaged. The office canvas draws at the capture fps (15),
 * but the ambient DOM props over it — steam wisps, dust motes, bulb twinkles, the fan, the asks
 * banner's breathe — are CSS animations, and 55 of them running forever kept the compositor
 * composing a 1920×1080 frame 60 times a second over a canvas that changed 15 times a second.
 * Measured 2026-10-13 on a software-composited headless Chrome against the live room: pausing them
 * took the GPU process from ~100% of a core to 33% and the renderer from 65% to 44%, with the canvas
 * still drawing 15.8/s (docs/perf/broadcast-baseline.md). On the box the Viz threads were ~180%.
 *
 * How. Every animation the page is running is paused once and from then on its `currentTime` is
 * advanced by the wall time each drawn frame covers, right before the canvas draws. The props keep
 * moving at exactly the rate the stream can show, and the compositor gets one damage per draw. An
 * animation somebody else paused is left alone; a finished one is skipped.
 */

/** The slice of `Animation` this needs — narrow so a test can hand in plain objects. */
export interface SteppableAnimation {
  readonly playState: AnimationPlayState;
  currentTime: CSSNumberish | null;
  pause(): void;
}

/**
 * Step `anims` by `dtMs`. `held` remembers which animations this cadence paused (and therefore owns);
 * pass the same set every draw. Returns how many animations were advanced.
 */
export function stepDomAnimations(
  anims: readonly SteppableAnimation[],
  dtMs: number,
  held: WeakSet<object>,
): number {
  let stepped = 0;
  for (const a of anims) {
    const state = a.playState;
    if (state === 'finished' || state === 'idle') continue;
    if (!held.has(a)) {
      // Only take over what is actually running; a paused animation is someone else's hold.
      if (state !== 'running') continue;
      a.pause();
      held.add(a);
    }
    const at = typeof a.currentTime === 'number' ? a.currentTime : 0;
    a.currentTime = at + dtMs;
    stepped++;
  }
  return stepped;
}

/**
 * Broadcast only: the props step on every `every`th DRAWN frame, not every one. Each step forces a
 * style recalc and a software repaint of ~120 animated elements over a 1920×1080 frame, and on the
 * capture box that repaint cost ~8 draws/s: with the props frozen the office drew 26–29/s, stepping
 * them every frame 17–20/s (2026-10-27, machine 822710a73, lane 01M5ZV5PA6). At 30 fps capture,
 * `every` 3 moves steam, motes and twinkles at ~10 fps — the same wall-clock distance, in fewer,
 * larger steps — and the compositor gets a third of the damage.
 *
 * Returns the wall time to step the props by on a frame that steps, or null on one that skips; the
 * skipped frames' time is owed to the next step, so nothing drifts.
 */
export function domPropCadence(every: number): (frameMs: number) => number | null {
  const n = Math.max(1, Math.floor(every));
  let owed = 0;
  let i = 0;
  return (frameMs) => {
    owed += frameMs;
    if (++i < n) return null;
    i = 0;
    const dt = owed;
    owed = 0;
    return dt;
  };
}
