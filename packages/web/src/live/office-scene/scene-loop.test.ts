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
    expect(index).toMatch(/setLinked: \(names: string \| readonly string\[\] \| null\) =>/);
    const at = index.indexOf('setLinked: (names');
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

  it('the plate shows the first role beside the name, and the expanded detail lists them all when there are several (lanes 01M5FXZF49, 01M5FY2XFX)', () => {
    expect(index).toContain('const held = node.service ? [] : seatRoles(node.roles, node.role);');
    expect(index).toContain('const job = held[0] ?? null;');
    // The tag: the role's glyph (lane 01M5G33VH8), then the name in its own span for the capital.
    expect(index).toContain("jobEl.innerHTML = roleGlyph(job) ?? '';");
    const face = index.slice(index.indexOf('plate.appendChild(who);'), index.indexOf('if (name === you)'));
    expect(face).toContain("jobEl.className = 'lc-gl-label__job'");
    expect(index).toContain("plateDetailParts({ surface: node.surface, role: held.length > 1 ? held.join(' · ') : null })");
  });

  it('a job swipes in only when it changes while the room is open, never on first build or under reduced motion', () => {
    expect(index).toContain('plateJobs.set(name, { job, at: lastJob ? jobNow : -Infinity });');
    expect(index).toMatch(/if \(!reduced && !STILL && since < JOB_SWIPE_MS\) \{\s*jobEl\.classList\.add\('is-new'\)/);
    expect(index).toContain('plateJobs.delete(name);');
  });
});

describe('a human status line on the plate (ADR 721)', () => {
  it('the plate carries the colour footer with the hourglass, only for a member who has one', () => {
    const at = index.indexOf('if (node.statusLine) {');
    expect(at).toBeGreaterThan(-1);
    const block = index.slice(at, index.indexOf('el.appendChild(plate);', at));
    expect(block).toContain("plate.classList.add('has-status')");
    expect(block).toContain("status.className = 'lc-gl-label__status'");
    expect(block).toContain('status.innerHTML = HOURGLASS_SVG');
    expect(block).toContain('words.textContent = node.statusLine.text');
  });

  it('it is not in the compact fold, so a folded plate still shows it', () => {
    const live = readFileSync(new URL('../Live.css', import.meta.url), 'utf8');
    const fold = live.slice(live.indexOf('.lc-gl-label.is-compact:not(.is-spot)'), live.indexOf('.lc-gl-label.is-spot'));
    expect(fold).not.toContain('lc-gl-label__status');
  });
});

describe('folded plates and the roll call (lane 01M5G7A9H1)', () => {
  it('an idle or away member folds, unless they own a blocked lane', () => {
    expect(index).toMatch(
      /'is-compact',\s*\(node\.posture === 'active' \|\| node\.posture === 'away'\) && node\.blocked !== true/,
    );
  });

  it('the roll call runs on the stream only, skips a hidden tab, and stops on dispose', () => {
    expect(index).toContain('interactiveLabels || STILL ? null : setInterval(rollCall, ROLLCALL_EVERY_MS)');
    expect(index).toMatch(/const rollCall = \(\): void => \{\s*if \(document\.hidden\) return;/);
    expect(index).toContain('if (rollTimer) clearInterval(rollTimer);');
  });

  it('an open plate in the wave is laid out at its folded size, so no neighbour moves', () => {
    expect(index).toContain('const size = rollSize.get(name) ?? plateSize.get(name);');
  });

  it("chat's spotlight (ADR 740) opens one plate with the same hold, ignores a stranger, and clears on dispose", () => {
    const fn = index.slice(index.indexOf('const spotlight = '), index.indexOf('// Track the real PST sun'));
    expect(fn).toContain('if (name === undefined || !el) return false;');
    expect(fn).toContain('if (size) rollSize.set(name, size);');
    expect(fn).toContain("labels.get(spotlit.n)?.classList.remove('is-spot');");
    expect(fn).toContain('}, SPOTLIGHT_MS),');
    expect(index).toContain('if (spotlit) clearTimeout(spotlit.t);');
  });
});

describe('the in-room ask moment (ADR 464, lane 3)', () => {
  it('a new open ask raises the hand and rests a card; backfill and reduced motion get the card only', () => {
    const fn = index.slice(
      index.indexOf('function syncAsks('),
      index.indexOf('function positionAskCards('),
    );
    expect(fn).toContain("el.className = 'lc-gl-ask'");
    expect(fn).toMatch(
      /if \(asksSeeded && !reduced && !STILL\) \{[\s\S]*?welcomeWave\(ask\.from\)/,
    );
    expect(fn).toContain("pushCue(ask.from, '#f4cf52', '?')");
  });

  it('a settled ask wears its mark and clears on a timer that dispose stops', () => {
    const fn = index.slice(
      index.indexOf('function syncAsks('),
      index.indexOf('function positionAskCards('),
    );
    expect(fn).toContain("classList.add('is-settled')");
    expect(fn).toContain('askSettleTimers.set(ask.id, t)');
    const at = index.indexOf('dispose: () =>');
    expect(index.slice(at, index.indexOf('\n    },', at))).toContain('askSettleTimers.clear()');
  });

  it("the cards follow the plates every frame, at the human's plate or the asker's", () => {
    expect(index).toMatch(/repositionSpeeches\(headMap\);\s*positionAskCards\(/);
    const fn = index.slice(
      index.indexOf('function positionAskCards('),
      index.indexOf('function positionLabels('),
    );
    expect(fn).toContain('ask.to && placed.get(ask.to) ? ask.to : ask.from');
  });
});

describe('motion means something (ADR 464, lane 4)', () => {
  it('the ambient scheduler draws from the pure pool, and a working member gets no errand', () => {
    const fn = body('fireAmbient');
    expect(fn).toContain('ambientPool(placements, nodes)');
    expect(fn).toMatch(
      /playAmbientBeat\(\s*decision\.who,\s*slot,\s*pool\.errands\?\.includes\(decision\.who\)/,
    );
    const beat = body('playAmbientBeat');
    expect(beat).toMatch(
      /\.\.\.\(mayErrand[\s\S]*?coffeeStroll\(who, slot\)[\s\S]*?errandPhone[\s\S]*?errandFridge/,
    );
    expect(beat).toContain('if (water && mayErrand)');
  });

  it('a purposeful walk wears its verb, from headline.ts, only while the act walk is in flight', () => {
    expect(index).toContain("setWalkTag(ev.from, walkTag('help', null))");
    expect(index).toContain("setWalkTag(ev.from, walkTag('handoff', ev.to))");
    expect(index).toContain("setWalkTag(ev.from, walkTag('steer', ev.to))");
    // Per frame, not per bake: a tag that arrived or left on a bake re-centred the plate between
    // the sweep's measure and its shutter (found by the contrast gate on /office-preview).
    const sync = body('syncWalkTags');
    expect(sync).toMatch(/actors\.actWalkingFor\(name\)[\s\S]*?'lc-gl-label__walk'/);
    expect(sync).toContain('walkTags.delete(name)');
    expect(body('positionLabels')).toContain('syncWalkTags()');
  });
});

describe('claiming a lane walks to the board (nick, 2026-10-09)', () => {
  it('sends the claimer through actors.claim with the lane’s seed, and tags the walk', () => {
    const at = index.indexOf("case 'walk-claim':");
    expect(at).toBeGreaterThan(-1);
    const body = index.slice(at, index.indexOf('break;', at));
    expect(body).toContain('actors.claim(ev.who, laneSeed(ev.lane))');
    expect(body).toContain("walkTag('claim'");
  });

  it('paints the wall from wallBoardNow(), so a card in someone’s hand leaves its slot empty', () => {
    expect(index).not.toMatch(/recep,\s*wallBoard,/);
    expect(index).toMatch(/recep,\s*wallBoardNow\(\),/);
  });
});

describe('the deliver walk is carried by the lane owner (lane 01M4V774MK)', () => {
  it('remembers owners from claim and pin walks, and carries as that owner', () => {
    const claim = index.slice(index.indexOf("case 'walk-claim':"), index.indexOf("case 'walk-pin':"));
    expect(claim).toContain('laneOwners.note(ev.lane, ev.who)');
    const pin = index.slice(index.indexOf("case 'walk-pin':"), index.indexOf("case 'walk-deliver':"));
    expect(pin).toContain('laneOwners.note(ev.lane, ev.who)');
    const at = index.indexOf("case 'walk-deliver':");
    const body = index.slice(at, index.indexOf("case 'megaphone':", at));
    expect(body).toContain('laneOwners.carrier(ev.lane, ev.from)');
    expect(body).toContain('actors.deliver(carrier, ev.to');
    // The claim notes its owner only live: a replayed claim is older than the board (lane 01M50TZDDM).
    expect(claim).toContain('if (!replaying) laneOwners.note(ev.lane, ev.who)');
    // The board seeds the owners only when it is a new board, not on every roster tick.
    expect(index).toContain('next.laneOwners !== seededOwners');
    expect(body).not.toContain('actors.deliver(ev.from');
  });
});

describe('the accept flourish at the board (spec 2026-10-13 L3)', () => {
  it('flourishes a done pin an acceptor made, once, when the card lands — and never during a replay', () => {
    const at = index.indexOf("case 'walk-pin':");
    const body = index.slice(at, index.indexOf("case 'walk-deliver':", at));
    // Only a submit names the owner; a done pin by anyone else is an acceptance.
    expect(body).toContain("laneOwners.closedByOther(ev.lane, ev.who)");
    // …and a replayed submit is older than the board, so it never notes one (lane 01M50TZDDM).
    expect(body).toContain("if (ev.state === 'awaiting_acceptance' && !replaying) laneOwners.note(ev.lane, ev.who)");
    // The walk's flourish waits for the card to land; the fallback flourishes at once, live only.
    expect(body).toContain('acceptedPins.add(seed)');
    expect(body).toContain('accepted && tempo === 1');
    const fn = index.slice(index.indexOf('function flourishFreshPins'), index.indexOf('function nearestNeighbors'));
    expect(fn).toContain('if (prevPinned.has(p.seed)) continue;');
    expect(fn).toContain("p.state === 'done' && acceptedPins.delete(p.seed) && tempo === 1");
    expect(index).toMatch(/actors\.step\(dt \* tempo\);\s*flourishFreshPins\(\);/);
  });
});

describe('micro-polish (spec 2026-10-13 L5)', () => {
  it('a card that lands swings on its tape: the landing time reaches the wall as an age', () => {
    const fn = index.slice(index.indexOf('function flourishFreshPins'), index.indexOf('function nearestNeighbors'));
    expect(fn).toContain('pinLanded.set(p.seed, clock)');
    expect(index).toContain('age: clock - landed');
  });

  it('every nameplate sits a hair off true, stable per name and within a degree', () => {
    expect(index).toMatch(/rotate\(\$\{plateTilt\(name\)\}deg\)/);
    const fn = index.slice(index.indexOf('function plateTilt'), index.indexOf('function pushDoorCue'));
    expect(fn).toContain('laneSeed(name)');
    // (seed % 17 - 8) * 0.1 spans -0.8 .. +0.8
    expect(fn).toContain('% 17) - 8) * 0.1');
  });
});

describe('the dog tags along to the cooler (spec 2026-10-13 L2)', () => {
  it('a water errand is a seeded stroll that sometimes brings the dog, and never costs the member their errand', () => {
    const fn = index.slice(index.indexOf('function waterStroll'), index.indexOf('function quiet()'));
    expect(fn).toContain('if (!actors.errandWater(who)) return false;');
    expect(fn).toContain("roll(teamName, slot, 'pet-follow-water') < 0.4");
    expect(fn).toContain('petFollow(pet, COOLER_STAND');
    expect(fn).toContain("slotRng(teamName, slot, 'pet-follow-water-walk')");
    expect(fn).toContain('return true;');
    expect(index).toContain('beats.push([8, () => waterStroll(who, slot)])');
  });
});

describe('a speech bubble hangs from its speaker\'s nameplate, above and aligned with it', () => {
  it('records each plate\'s centre and top after layout, and anchors the bubble there', () => {
    const place = index.slice(index.indexOf('function positionLabels'), index.indexOf('The light-trace'));
    expect(place).toContain('plateTops.set(name, { x: at.x, y: at.y - size.h })');
    const repo = index.slice(index.indexOf('function repositionSpeeches'), index.indexOf('function clearSpeech'));
    expect(repo).toContain('plateTops.get(name)');
    expect(repo).toContain('plate.y - SPEECH_PLATE_GAP + SPEECH_LIFT');
    // no plate yet: the head anchor, as before
    expect(repo).toContain(': head');
  });
});

describe('a bubble slides off the wall board instead of covering it (lane 01M4VMFE3A)', () => {
  it('positionSpeech shifts the bubble by bubbleShiftOffBoard and never hides it', () => {
    const fn = index.slice(index.indexOf('function positionSpeech'), index.indexOf('function clearSpeech'));
    expect(fn).toContain('bubbleShiftOffBoard(head, { w: outer.offsetWidth, h: outer.offsetHeight }, SPEECH_LIFT, board)');
    expect(fn).toContain('translate(${head.x + dx}px, ${head.y - SPEECH_LIFT}px)');
    // the earlier cut faded the bubble out for the whole landing and the sentence was lost
    expect(fn).not.toContain('opacity');
    expect(fn).not.toContain('pointerEvents');
    // the board anchor is read once per pass, and only when a bubble is up
    expect(fn).toContain('const board = speeches.size ? boardAnchor(fit) : undefined;');
  });
});

describe('a human plate and the viewer\'s own plate (lane 01M50CD7SN)', () => {
  it('a human gets the person glyph in the provider slot, never the unknown "?"', () => {
    const sync = body('syncLabels');
    const human = sync.slice(sync.indexOf("node.kind === 'human'"), sync.indexOf('modelProvider(node.model)'));
    expect(human).toContain('HUMAN_GLYPH_SVG');
    expect(human).toContain("icon.title = 'human'");
  });

  it('"you" exists only where the labels are interactive — never on /broadcast', () => {
    expect(index).toMatch(/you = interactiveLabels \? \(next\.you \?\? null\) : null;/);
    expect(body('syncLabels')).toMatch(/name === you[\s\S]*?'lc-gl-label__you'/);
  });
});

describe('a replayed walk wears its age (lane 01M50TZA8X)', () => {
  it('runs the replay at REPLAY_TEMPO and stamps each replayed walk tag with its age, never a live one', () => {
    const drain = index.slice(index.indexOf('function drainReplay'), index.indexOf('function update('));
    expect(drain).toContain('tempo = REPLAY_TEMPO');
    expect(drain).toContain('replayAt = ev.at ?? null');
    expect(drain).toContain('replayAt = null');
    // Every walk tag goes through setWalkTag, which adds the age only while a replay emits.
    expect(index).not.toMatch(/walkTags\.set\((?!name, verb\))/);
    expect(index).toContain('if (replayAt !== null) walkAges.set(name, replayAge(Date.now() - replayAt))');
    expect(index).toContain("ago.className = 'lc-gl-label__ago'");
  });
});


describe('the companion gesture rides a beat that played (ADR 617)', () => {
  it('plays only beside a played beat, in place, on its own roll', () => {
    const fire = index.slice(index.indexOf('function fireAmbient'), index.indexOf('function playAmbientBeat'));
    expect(fire).toContain('if (played && decision.kind !== \'none\' && decision.companion)');
    // The room notices first (something moving nearby), else a seated gesture of their own.
    expect(fire).toContain("actors.notice(c, target, slotRng(teamName, slot, 'notice'))");
    expect(fire).toContain("playAmbientBeat(c, slot, false, 'companion-beat')");
  });
});

describe('the musterd voice at its objects (sound identity spec §2.2–2.3, lane 01M61R4CBA)', () => {
  const emitBody = index.slice(index.indexOf('function emit(ev: OfficeEvent)'), index.indexOf("    switch (ev.kind) {", index.indexOf('function emit(ev: OfficeEvent)')));
  it('rings the chimes at the board for a lane done by any route, once per lane, never on replay', () => {
    expect(emitBody).toContain("ev.kind === 'walk-pin' && ev.state === 'done' && !replaying && !rangDone.has(ev.lane)");
    expect(emitBody).toContain("roomTone.moment('laneDone', boardPan()");
    expect(emitBody).toContain('bar: barForLane(ev.lane)');
    expect(emitBody).toContain('voices: voicesForChain([ev.who, laneOwners.carrier(ev.lane, ev.who)])');
    expect(index).not.toContain("roomTone.moment('fanfare'");
  });
  it('rolls the scale for a goal shipped, waiting out the gate behind its last lane', () => {
    expect(emitBody).toContain("ev.kind === 'goal-done' && !replaying");
    expect(emitBody).toContain("roomTone.moment('goalDone', boardPan())");
    expect(emitBody).toContain('420 - (Date.now() - lastLaneDoneAt)');
  });
  it('a question and a redirect ring the bell at the desk they are aimed at, above the motion gate', () => {
    expect(emitBody).toContain("gesture === 'question' || gesture === 'redirect'");
    expect(emitBody).toContain('roomTone.moment(gesture, at ? screenPan(at.x, width) : 0)');
    expect(index).not.toContain("roomTone.moment('askbell'");
    expect(index).not.toContain("roomTone.moment('whoosh'");
  });
  it('a handoff is a note here and the answer there', () => {
    expect(emitBody).toContain("roomTone.moment('handoffSend'");
    expect(emitBody).toContain("roomTone.moment('handoffAnswer', toPan)");
  });
  it('the door cousin plays up for an arrival and down for a departure, over the door foley', () => {
    expect(index).toContain("roomTone.moment('door', doorPan)");
    expect(index).toContain("if (came) roomTone.moment('arrive', doorPan)");
    expect(index).toContain("roomTone.moment('leave', doorPan)");
  });
});
