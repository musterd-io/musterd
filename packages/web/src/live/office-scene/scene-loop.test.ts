import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lane 01M2JYBGMQ, finding 1 (delta, re-read by izzo, confirmed here against the running source).
 *
 * There are two doors out of "this room stopped being watched": the tab going hidden
 * (`visibilitychange`) and the panel collapsing (`setSuspended`). Coming back through EITHER one
 * asks the same question — is anything actually happening, and therefore does the rAF loop resume
 * or does the slow drift heartbeat? #1430 answered it in two places, and they disagreed:
 * `onVisibility` resumed the breath, `setSuspended(false)` painted one resting frame and left the
 * room frozen. Collapse a quiet office, re-expand it, and the breathing was gone for the rest of
 * the session — invisible in review, because the first expand looks right (drift is armed on init).
 *
 * WHY THESE ARE SOURCE ASSERTIONS AND NOT A ROUND TRIP. `mountOffice` is the DOM half of the scene
 * and this package's tests run under `environment: 'node'` — there is no canvas, no rAF and no
 * document to mount into, and nothing in the repo stands one up. The round trip delta asked for
 * (suspend true → false on a quiet room, assert the heartbeat is armed) is the test worth having
 * and it is NOT what these are; they hold the STRUCTURE that makes the bug unrepresentable —
 * one home for the decision — rather than the behaviour. That gap is real and stated, not covered over.
 */
const index = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

/** The body of a named function in the scene source — `function f()` or `const f = () =>` — brace-matched. */
function body(name: string): string {
  const at =
    [`function ${name}(`, `const ${name} = (`]
      .map((decl) => index.indexOf(decl))
      .find((i) => i > -1) ?? -1;
  expect(at, `no function ${name} in index.ts`).toBeGreaterThan(-1);
  const open = index.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < index.length; i++) {
    if (index[i] === '{') depth++;
    else if (index[i] === '}' && --depth === 0) return index.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('coming back to a room that stopped being watched', () => {
  it('both doors ask one function, so they cannot answer differently', () => {
    expect(index).toMatch(/function reengage\(\)/);
    // The tab-visibility door.
    expect(body('onVisibility')).toContain('reengage()');
    // …and the collapse door, which is the one that was wrong.
    const suspend = index.slice(index.indexOf('setSuspended:'), index.indexOf('pokeGesture:'));
    expect(suspend).toContain('reengage()');
  });

  it('neither door decides for itself — only reengage picks loop-or-drift', () => {
    const suspend = index.slice(index.indexOf('setSuspended:'), index.indexOf('pokeGesture:'));
    for (const [door, src] of [
      ['onVisibility', body('onVisibility')],
      ['setSuspended', suspend],
    ] as const) {
      expect(src, `${door} arms the loop itself`).not.toMatch(/\bensureLoop\(\)/);
      expect(src, `${door} arms the heartbeat itself`).not.toMatch(/\bensureDrift\(\)/);
    }
  });

  it('reengage is the only place the two are chosen between', () => {
    // stopDrift stays where it is — a door may still STOP things on the way out; what it may not do
    // is decide what starts on the way back in.
    expect(body('reengage')).toMatch(/ensureLoop\(\)/);
    expect(body('reengage')).toMatch(/ensureDrift\(\)/);
  });

  it('"is this room alive?" has one home too — the predicate that drifts if copied', () => {
    expect(index).toMatch(/const alive = \(\)/);
    expect(body('reengage')).toContain('alive()');
    // The three-part liveness test must not be re-spelled anywhere else.
    const spelled = [...index.matchAll(/living\(\)\s*\|\|\s*actors\.active\(\)/g)];
    expect(spelled.length, 'the liveness predicate is written out more than once').toBe(1);
  });
});

describe('nameplates are laid out, not just pinned (lane 01M3GPH5KB)', () => {
  it('positionLabels places every plate through layoutPlates, from sizes it did not force a layout for', () => {
    const pos = body('positionLabels');
    expect(pos).toContain('layoutPlates(');
    // Reading offsetWidth per frame would force a synchronous layout 20–60 times a second.
    expect(pos).not.toMatch(/offset(Width|Height)|getBoundingClientRect/);
    expect(index).toMatch(/new ResizeObserver\(/);
  });
});

/**
 * The Welcome Wagon's plumbing (lane 01M3F81DD9). Its decisions are unit-tested in welcomeRoom.test.ts;
 * these hold the four joints index.ts owns, as source structure for the same reason as above.
 */
describe('the Welcome Wagon is plumbed in', () => {
  it('update() feeds the roster to the welcome BEFORE the actors seat it', () => {
    const update = body('update');
    const feed = update.indexOf('welcomeRoom.onRoster(');
    const seat = update.indexOf('actors.setHomes(');
    expect(feed, 'update() never feeds the welcome').toBeGreaterThan(-1);
    // expectFirstArrival must land before setHomes builds the check-in walk, or the box never shows.
    expect(feed).toBeLessThan(seat);
  });

  it('the frame loop steps it, and its activity keeps the loop alive', () => {
    expect(body('tick')).toContain('welcomeRoom.step(');
    expect(index).toMatch(/const alive = \(\) =>[^;]*welcomeRoom\.active\(\)/);
  });

  it('a parked room still starts a queued welcome and folds away the counter — on a timer that only runs while needed', () => {
    const arm = body('armWagonTimer');
    expect(arm).toMatch(/setInterval\(/);
    expect(arm, 'the timer must stop itself once the welcome is over').toMatch(
      /clearInterval\(wagonTimer\)/,
    );
    expect(body('update')).toContain('armWagonTimer()');
    const at = index.indexOf('dispose: () =>');
    expect(at, 'no dispose in the handle').toBeGreaterThan(-1);
    expect(index.slice(at, index.indexOf('\n    },', at))).toContain('clearInterval(wagonTimer)');
  });

  it('reduced motion: the welcome is stepped off the frame loop, and never blocks the resting repaint', () => {
    // Final review, Critical: under reduced motion the rAF loop never runs, so a welcome stepped only
    // from `tick` never drained, `active()` stayed true, and update() took ensureLoop() (a no-op) instead
    // of paintResting() on every roster change — the canvas froze after the first arrival.
    expect(body('armWagonTimer')).toMatch(/if \(reduced\)[\s\S]*?welcomeRoom\.step\(/);
    expect(body('update')).toMatch(/!reduced && welcomeRoom\.active\(\)/);
  });

  it('the plain door cue stands down when the welcome rang the door', () => {
    expect(body('update')).toMatch(/takeDoorPulses\(\)[\s\S]*?welcomedAtDoor/);
  });
});

describe('the welcome reads where people ARE, not the baked frame (lane 01M3F81DD9)', () => {
  it('its confetti and wave ports locate the newcomer from the live pose', () => {
    // `heads` is refreshed by bake(), which ran when the newcomer was at the door — so a burst or a
    // wave anchored on it lands at the entrance (found on the office-preview harness, 2026-09-26).
    expect(index).toMatch(/function liveHead\(/);
    const at = index.indexOf('const welcomeRoom = createWelcomeRoom(');
    const ports = index.slice(at, index.indexOf('{ reduced, still: STILL }', at));
    expect(ports).toMatch(/confetti: [^\n]*liveHead\(/);
    expect(ports).toMatch(/wave: [\s\S]*?liveHead\(/);
  });
});

describe('the team column is linked to the room (ADR 464, lane 1)', () => {
  it('the handle exposes setLinked, and it only toggles a plate class — no canvas redraw', () => {
    expect(index).toMatch(/setLinked: \(name: string \| null\) =>/);
    const at = index.indexOf('setLinked: (name');
    const fn = index.slice(at, index.indexOf('\n    },', at));
    expect(fn).toContain("classList.toggle('is-linked'");
    expect(fn).not.toMatch(/draw|bake|renderScene/);
  });

  it('a plate reports hover back through options.onPlateHover', () => {
    expect(index).toMatch(/options\.onPlateHover\?\.\(/);
  });

  it('the plate carries the short model name beside the provider logo', () => {
    expect(index).toMatch(/lc-gl-label__model/);
    expect(index).toMatch(/displayModel\(node\.model\)/);
  });
});
