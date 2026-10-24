import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { homePoses } from './actors';
import { memberColor } from '../format';
import { depth, fitBox, fitFloor, project, ROOM_BOX } from './iso';
import {
  BENCH,
  ENTRANCE,
  BOOKSHELVES,
  CHAIR_OFF,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  FWD,
  KEYBOARD_ALONG,
  LOUNGE,
  NOOK,
  PLANTS,
  WORKING_HOURS_CALENDAR,
} from './layout';
import { computeLightEnv } from './lighting';
import type { PetMode, PetState } from './pet';
import { ART_IDS, FAKE_IMG, fakeArt } from './rendered/fixtures';
import type { ReceptionistState } from './receptionist';
import { GESTURE } from './skeleton';
import {
  BOOT_LED,
  receptionistPose,
  confettiColor,
  plateText,
  WAGON_RED,
  wagonTrail,
  actorSortAnchor,
  animatedDeskAnchors,
  deskHasProp,
  boardAnchor,
  coffeeAnchor,
  contactPool,
  actorDepth,
  deskNearDepth,
  deskPropSort,
  DOCK_CRADLE_ALONG,
  PROP_SPEC,
  benchDockAt,
  benchMonitorAt,
  benchPropSort,
  deskSeat,
  deskStationItems,
  seatedArmsDepth,
  DOCK_HALF_ACROSS,
  dockAcross,
  drawCue,
  drawDog,
  drawWorkstation,
  backgroundKey,
  drawWalls,
  DARK_PALETTE,
  paletteKey,
  setScenePalette,
  ownedDeskWarmAlpha,
  workstationKey,
  MACHINE_H,
  MONITOR_ALONG,
  renderScene,
  WIDEST_PANEL_HALF,
  furnishedBox,
} from './render';
import { assignSeats } from './seating';
import type { RenderOpts } from './render';
import type { OfficeNode, Pose, WelcomePaint } from './types';
import { projectWallBoard, STICKY_CAP, type WallBoard } from './wallboard';
import { fmtOps, recordingCtx, type RecordedOp } from './recording-ctx';
import { deviceBox, measureBounds, type SpriteCache } from './sprite-cache';
import type { Lane, LaneState, WorkingHours } from '@musterd/protocol';

/** The art every scene in this file renders with (fake images, the shipped manifest and dog). */
const ART = fakeArt();

/** `renderScene` with the art supplied — every positional default spelled out so a test can skip to `opts`. */
function scene(
  ctx: CanvasRenderingContext2D,
  fit: Parameters<typeof renderScene>[1],
  placements: Parameters<typeof renderScene>[2],
  byName: Parameters<typeof renderScene>[3],
  poses: Parameters<typeof renderScene>[4],
  t = 0,
  teamName = 'revive',
  env?: Parameters<typeof renderScene>[7],
  pet: Parameters<typeof renderScene>[8] = null,
  fx?: Parameters<typeof renderScene>[9],
  recep: Parameters<typeof renderScene>[10] = null,
  wallBoard: Parameters<typeof renderScene>[11] = null,
  hours: Parameters<typeof renderScene>[12] = null,
  opts: Omit<RenderOpts, 'rendered'> & { rendered?: RenderOpts['rendered'] } = {},
) {
  return renderScene(ctx, fit, placements, byName, poses, t, teamName, env, pet, fx, recep, wallBoard, hours, { rendered: ART, ...opts });
}

/** `drawWorkstation` with the art supplied, in the painters' positional order. */
const ws = (
  ctx: CanvasRenderingContext2D,
  fit: Parameters<typeof drawWorkstation>[1],
  slot: Parameters<typeof drawWorkstation>[2],
  node: Parameters<typeof drawWorkstation>[3],
  teamName: string,
  owned: boolean,
  t: number,
  hide: Parameters<typeof drawWorkstation>[7],
  lampsLit: boolean,
  atWork: boolean,
  phase: Parameters<typeof drawWorkstation>[10],
) => drawWorkstation(ctx, fit, slot, node, teamName, owned, t, hide, lampsLit, atWork, phase, ART);

/** The real cache's measuring rule, unmemoized — a test double that skips an item drawing nothing. */
const measuredBox: SpriteCache['box'] = (_key, draw) => {
  const b = measureBounds(draw);
  return b ? deviceBox(b, 1) : null;
};

/** A minimal lane for wall-board fixtures — only id and state matter to the wall. */
function laneFix(id: string, state: LaneState): Lane {
  return {
    id,
    team: 'revive',
    project: 'default',
    title: 't',
    detail: null,
    owner_seat: null,
    role: null,
    scope: [],
    areas: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal' as const,
    stakes_provenance: 'declared' as const,
    merged: null,
    state,
    created_by: 'nick',
    created_at: 1,
    claimed_at: null,
    resolved_at: null,
    updated_at: 1,
  };
}

function node(name: string, activity: OfficeNode['activity']): OfficeNode {
  return {
    name,
    kind: 'agent',
    service: false,
    woken: false,
    presence: 'online',
    activity,
    posture: activity === 'working' ? 'working' : 'active',
    state: null,
    color: memberColor(name, 'agent'),
    role: '',
    surface: null,
    model: null,
    workTitle: null,
    workSource: null,
    laneState: null,
    moreLanes: 0,
    dnd: false,
    offline_reason: null,
    last_seen_at: null,
    created_at: null,
    sponsored_by: null,
  };
}

/** A no-op 2D context that records nothing — just enough surface for the scene's draw calls so we can
 * assert the whole painter's-order pass runs end to end without throwing. `paints` collects every colour
 * the scene assigns, so a test can check they're all ones canvas can actually parse (see below). */
function mockCtx(paints: string[] = []): CanvasRenderingContext2D {
  const grad = {
    addColorStop(_stop: number, color: string) {
      paints.push(color);
    },
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      if (prop === 'canvas') return { width: 1200, height: 900 };
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop in target) return target[prop as string];
      return () => undefined; // every draw method is a no-op
    },
    set(_target, prop, value) {
      if ((prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string')
        paints.push(value);
      return true; // fillStyle/strokeStyle/font/etc. — accept and ignore
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
}

/**
 * A colour string canvas can actually parse. This is not pedantry: assigning an unparseable `fillStyle`
 * **throws nothing and changes nothing** — the context quietly keeps its previous colour, so the shape is
 * painted in whatever the last draw left behind. The result is a solid that looks fine until an unrelated
 * change reorders the depth sort, and then paints itself the wrong colour with no error anywhere. That is
 * exactly how the kitchenette counter's side faces went green (`mul()` returned `rgb(…)`, which `hexRgb`
 * parsed to `NaN`), so the guard is on the whole scene rather than the one function that regressed.
 */
function parseableColor(c: string): boolean {
  if (/NaN|undefined|null/i.test(c)) return false;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$|^#[0-9a-f]{8}$/i.test(c)) return true;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(c)) return true;
  if (/^hsla?\(\s*[-\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\)$/.test(c)) return true;
  return /^[a-z]+$/i.test(c); // a named colour (transparent, white, …)
}

/** The acceptance confetti cue: deterministic per `t` (no per-frame randomness — a given moment
 * always draws the same burst), and every particle colour parseable across its whole lifetime. */
describe('drawCue confetti', () => {
  it('paints only parseable colours across the burst lifetime', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 0.99]) {
      const paints: string[] = [];
      drawCue(
        mockCtx(paints),
        { at: { x: 300, y: 200 }, color: '#5cd49a', glyph: '', t, urgent: false, kind: 'confetti' },
        1,
      );
      expect(paints.length).toBeGreaterThan(0);
      for (const c of paints) expect(parseableColor(c), c).toBe(true);
    }
  });

  it('is a pure function of t — the same moment draws the same colours in the same order', () => {
    const a: string[] = [];
    const b: string[] = [];
    const cue = {
      at: { x: 300, y: 200 },
      color: '#5cd49a',
      glyph: '' as const,
      t: 0.4,
      urgent: false,
      kind: 'confetti' as const,
    };
    drawCue(mockCtx(a), cue, 1);
    drawCue(mockCtx(b), cue, 1);
    expect(a).toEqual(b);
  });
});

/** The fan/coffee overlay anchors (Tier-A animated props). The key behaviour: a fan only spins and a mug
 * only steams at an *occupied* desk — an unattended running fan or a steaming fresh mug reads as wrong. */
describe('animatedDeskAnchors', () => {
  const fit = fitFloor(1200, 900);
  const allSlots = new Set(DESK_SLOTS.map((s) => s.id));

  it('animates nothing — no spinning fans, no steaming mugs — when no desks are occupied', () => {
    const { fans, coffees } = animatedDeskAnchors(fit, new Set());
    expect(fans).toHaveLength(0);
    expect(coffees).toHaveLength(0);
  });

  it('spins fans and steams mugs only at occupied desks', () => {
    const full = animatedDeskAnchors(fit, allSlots);
    expect(full.fans.length).toBeGreaterThan(0); // some desks carry a fan (a stable per-desk hash)
    expect(full.coffees.length).toBeGreaterThan(0); // some desks carry a mug
  });

  it('does not put a coffee mug on every desk', () => {
    // fewer steaming mugs than desks even when all are seated → mugs are a per-desk hash, not universal
    expect(animatedDeskAnchors(fit, allSlots).coffees.length).toBeLessThan(DESK_SLOTS.length);
  });

  it('drops a fan the moment its desk empties (gated per-slot, not all-or-nothing)', () => {
    const full = animatedDeskAnchors(fit, allSlots).fans.length;
    const fanSlot = DESK_SLOTS.find(
      (s) => animatedDeskAnchors(fit, new Set([s.id])).fans.length === 1,
    );
    expect(fanSlot).toBeDefined();
    const minusOne = new Set(allSlots);
    minusOne.delete(fanSlot!.id);
    expect(animatedDeskAnchors(fit, minusOne).fans.length).toBe(full - 1);
  });

  it('gives every occupied desk at least one moving prop — no desk sits still (lane 01M50X1WRW)', () => {
    for (const slot of DESK_SLOTS) {
      const { fans, coffees } = animatedDeskAnchors(fit, new Set([slot.id]));
      expect(fans.length + coffees.length, `desk ${slot.id}`).toBeGreaterThan(0);
    }
  });

  it('fills a bare desk with a fan or a mug, and not the same one everywhere', () => {
    for (const slot of DESK_SLOTS)
      expect(deskHasProp(slot.id, 'fan') || deskHasProp(slot.id, 'coffee'), `desk ${slot.id}`).toBe(
        true,
      );
    const fans = DESK_SLOTS.filter((s) => deskHasProp(s.id, 'fan')).length;
    expect(fans).toBeGreaterThan(1);
    expect(fans).toBeLessThan(DESK_SLOTS.length);
  });

  it('drops a mug steam the moment its desk empties (empty desk → empty, un-steaming mug)', () => {
    const full = animatedDeskAnchors(fit, allSlots).coffees.length;
    const mugSlot = DESK_SLOTS.find(
      (s) => animatedDeskAnchors(fit, new Set([s.id])).coffees.length === 1,
    );
    expect(mugSlot).toBeDefined();
    const minusOne = new Set(allSlots);
    minusOne.delete(mugSlot!.id);
    expect(animatedDeskAnchors(fit, minusOne).coffees.length).toBe(full - 1);
  });
});

describe('working monitor desktop', () => {
  const fit = fitFloor(1200, 900);

  function paintsFor(activity: OfficeNode['activity']): string[] {
    const member = node('stanley', activity);
    const members = new Map([[member.name, member]]);
    const placements = assignSeats([member]);
    const paints: string[] = [];
    scene(mockCtx(paints), fit, placements, members, homePoses(placements, members), 2.4);
    return paints;
  }

  it('renders Stanley’s working window desk as a living desktop', () => {
    // Stanley hashes to desk-slot index 15, whose stable desk ID is 20. The layout's sparse IDs must
    // never make this working, camera-facing screen fall back to the dark idle slab.
    expect(paintsFor('working')).toContain('#2f9a8a');
  });

  it('keeps Stanley’s idle monitor dim', () => {
    expect(paintsFor('active')).not.toContain('#2f9a8a');
  });
});

/** The full painter's-order pass. An *empty* office still draws all 12 workstations — every chair (the
 * per-desk style variety), every monitor setup, keyboard and mouse — so this exercises the whole furniture
 * surface, including the stable per-desk chair/monitor/peripheral variation, without needing live actors. */
/** Where the break-nook's ambient steam is born. The machine is drawn *and* anchored from the same
 * geometry, and the two drifting apart is silent: the plume simply starts inside the machine and the
 * espresso reads as a small fire. */
describe('coffeeAnchor (the ambient steam source)', () => {
  const fit = fitFloor(1200, 900);

  it('sits above the machine, not inside it — steam leaves the warmer plate', () => {
    const counterTop =
      project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit).y -
      LOUNGE.counter.h * fit.scale;
    const clearance = (counterTop - coffeeAnchor(fit).y) / fit.scale; // screen y grows downward
    expect(clearance).toBeGreaterThanOrEqual(MACHINE_H);
  });

  it('is centred on the machine, so the plume rises off the machine and not the counter beside it', () => {
    expect(coffeeAnchor(fit).x).toBeCloseTo(
      project(NOOK.lx + LOUNGE.machine.dx, NOOK.ly + LOUNGE.machine.dy, fit).x,
    );
  });
});

/**
 * The wall agile board (`wallLaneBoard`) — the object that replaced the whiteboard. It draws REAL
 * lane data as sticky notes in state-toned columns; the only type it sets is the `+N` overflow
 * badge. Member colours stay off the wall: identity lives on the floor, state lives on the board.
 */
describe('the wall agile board', () => {
  const fit = fitFloor(1200, 900);

  /** A little board: two open, one active, one blocked. */
  const wallData = (): WallBoard =>
    projectWallBoard({
      lanes: [
        laneFix('a', 'open'),
        laneFix('b', 'open'),
        laneFix('c', 'active'),
        laneFix('d', 'blocked'),
      ],
      warnings: [],
    })!;

  /** A ctx that also records `fillText` / stroke colours. */
  function textCtx(paints: string[], texts: string[]): CanvasRenderingContext2D {
    const grad = { addColorStop: (_s: number, c: string) => void paints.push(c) };
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'fillText') return (s: string) => void texts.push(s);
          return () => undefined;
        },
        set(_t, prop, value) {
          if ((prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string')
            paints.push(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  const roster = (nodes: OfficeNode[]): Map<string, OfficeNode> =>
    new Map(nodes.map((n) => [n.name, n]));
  const boardScene = (ctx: CanvasRenderingContext2D, wall: WallBoard | null): void =>
    void scene(
      ctx,
      fit,
      new Map(),
      roster([node('ada', 'working')]),
      new Map(),
      0,
      'revive',
      undefined,
      null,
      undefined,
      null,
      wall,
    );

  it('paints the face and the lanes in state tones, never member roster colours', () => {
    const paints: string[] = [];
    const nodes = ['ada', 'bo'].map((n) => node(n, 'working'));
    scene(
      textCtx(paints, []),
      fit,
      new Map(),
      roster(nodes),
      new Map(),
      0,
      'revive',
      undefined,
      null,
      undefined,
      null,
      wallData(),
    );
    // the cork and the pale oak frame are rendered art (`wall/board`); only the notes paint
    expect(paints).not.toContain('#C98F52');
    expect(paints).not.toContain('#3F74C4'); // the caps are in the render too
    expect(paints).toContain('#EFE8D8'); // an open sticky's paper wash
    expect(paints).toContain('rgba(180, 168, 143, 0.75)'); // its washi tab, at the cap's tone
    for (const n of nodes) expect(paints).not.toContain(n.color);
  });

  it('pins one tag per dated read on the strip, overdue in the accent (ADR 644 inc 3)', () => {
    const paints: string[] = [];
    boardScene(
      textCtx(paints, []),
      Object.assign(wallData(), { reads: ['overdue', 'waiting', 'read'] as const }),
    );
    expect(paints).toContain('#F6DFA4'); // the overdue tag's amber wash
    expect(paints).toContain('#B8860B'); // and its tack, the accent itself
    expect(paints).toContain('#EDE6D8'); // a waiting tag's plain paper
    expect(paints).toContain('#5E5446'); // the read tag's tick
  });

  it('hangs a bare strip when nothing is dated', () => {
    const paints: string[] = [];
    boardScene(textCtx(paints, []), wallData());
    expect(paints).not.toContain('#F6DFA4');
    expect(paints).not.toContain('#EDE6D8');
    expect(paints).not.toContain('#5E5446');
  });

  it('hangs an empty board when no team is connected: face and caps, zero paper', () => {
    const paints: string[] = [];
    boardScene(textCtx(paints, []), null);
    expect(paints).not.toContain('#C98F52'); // the cork is rendered, not painted
    expect(paints).not.toContain('#3F74C4'); // the caps are in the render too
    expect(paints).not.toContain('#EFE8D8'); // …but no sticky paper hangs under them
    expect(paints).not.toContain('#D8D4F3');
    expect(paints).not.toContain('rgba(180, 168, 143, 0.75)'); // and no tape holding nothing
  });

  it('paints the Team working-hours sign from schedule data', () => {
    const texts: string[] = [];
    const hours: WorkingHours = {
      timezone: 'America/Los_Angeles',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '11:00',
      end: '15:00',
    };
    scene(
      textCtx([], texts),
      fit,
      new Map(),
      roster([node('ada', 'working')]),
      new Map(),
      0,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      hours,
    );
    expect(texts).toContain('MON–FRI');
    expect(texts).toContain('11am–3pm');
  });

  it('writes only the overflow badge — a column past its cap says +N, nothing else says anything', () => {
    const texts: string[] = [];
    const crowded = projectWallBoard({
      lanes: Array.from({ length: STICKY_CAP + 2 }, (_, i) => laneFix(`L${i}`, 'open')),
      warnings: [],
    })!;
    boardScene(textCtx([], texts), crowded);
    expect(texts).toContain('+2');
    const quiet: string[] = [];
    boardScene(textCtx([], quiet), wallData());
    expect(quiet.some((t) => /^\+\d+$/.test(t))).toBe(false);
  });

  /** Fills painted in sticky-paper colours — the wall's DOM-cap analogue: never more than 6 columns
   * of STICKY_CAP notes (each note is two fills: paper + header edge), however big the real board. */
  it('never pins more paper than the cap allows, however many lanes exist', () => {
    const paints: string[] = [];
    const flood = projectWallBoard({
      lanes: Array.from({ length: 80 }, (_, i) =>
        laneFix(`L${i}`, (['open', 'active', 'blocked', 'done'] as const)[i % 4]!),
      ),
      warnings: [],
    })!;
    boardScene(textCtx(paints, []), flood);
    const paper = new Set(['#EFE8D8', '#E6E3F8', '#D8D4F3', '#F5DAD4', '#DFDCF6', '#D5ECDF']);
    const notes = paints.filter((c) => paper.has(c)).length;
    expect(notes).toBeGreaterThan(0);
    expect(notes).toBeLessThanOrEqual(6 * STICKY_CAP);
  });

  // A stopped plan's cards (lane 01M4V9YKMG): sun-bleached paper, paler tape, a curled corner.
  it("paints a stalled lane's sticky sun-faded, and a fresh one at full wash", () => {
    const fresh: string[] = [];
    boardScene(textCtx(fresh, []), projectWallBoard({ lanes: [laneFix('L1', 'open')], warnings: [] }));
    expect(fresh).toContain('#EFE8D8');
    expect(fresh).not.toContain('#E4DED1');
    const faded: string[] = [];
    boardScene(
      textCtx(faded, []),
      projectWallBoard({ lanes: [laneFix('L1', 'open')], warnings: [] }, new Set(['L1'])),
    );
    expect(faded).toContain('#E4DED1'); // the open wash pulled toward newsprint grey
    expect(faded).toContain('rgba(180, 168, 143, 0.35)'); // its tape, half as present
    expect(faded).toContain('rgba(60, 35, 10, 0.22)'); // the curl's shadow wedge
    expect(faded).not.toContain('#EFE8D8');
  });

  it('boardAnchor returns a finite on-screen box for the hotspot to sit on', () => {
    const a = boardAnchor(fit);
    for (const v of [a.x, a.y, a.w, a.h]) expect(Number.isFinite(v)).toBe(true);
    expect(a.w).toBeGreaterThan(0);
    expect(a.h).toBeGreaterThan(0);
  });

  // The sign hangs over the middle of the board's top edge (live-briefing spec, increment 5). On a
  // slanted wall that is lower than the box's top, which is the board's high corner; a sign hung from
  // the box top floated clear of the board, over the window (captured 2026-10-09 at 1440×900).
  it('boardAnchor gives the top edge’s midpoint inside the box, below its top on a slanted wall', () => {
    for (const f of [fit, fitFloor(1200, 900), fitFloor(700, 500)]) {
      const a = boardAnchor(f);
      expect(a.topMidY).toBeGreaterThan(a.y);
      expect(a.topMidY).toBeLessThan(a.y + a.h);
    }
  });

  // nick, 2026-10-09: a level sign on a slanted wall reads as pasted on the screen, not hung on the
  // wall. The sign is skewed by the board's own top-edge slope, so it lies in the wall's plane.
  it('boardAnchor gives the slope of the board’s top edge, which the sign is skewed by', () => {
    for (const f of [fit, fitFloor(1200, 900), fitFloor(700, 500)]) {
      const a = boardAnchor(f);
      expect(Number.isFinite(a.tiltDeg)).toBe(true);
      expect(Math.abs(a.tiltDeg)).toBeGreaterThan(5); // the wall runs at the iso angle, not level
      expect(Math.abs(a.tiltDeg)).toBeLessThan(45);
    }
  });
});


describe('the wall by default', () => {
  const fit = fitFloor(1200, 900);
  const roster = (nodes: OfficeNode[]): Map<string, OfficeNode> =>
    new Map(nodes.map((n) => [n.name, n]));

  /** Collects every string the scene sets with `fillText`. */
  function sceneText(): string[] {
    const texts: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
            return () => ({ addColorStop() {} });
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'fillText') return (s: string) => void texts.push(s);
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    scene(ctx, fit, new Map(), roster([node('ada', 'working')]), new Map());
    return texts;
  }

  it('writes no words on the agile board by default — an empty board has nothing to say', () => {
    const texts = sceneText();
    expect(texts.some((t) => /^\+\d+$/.test(t))).toBe(false);
  });

  it('sets no numerals: the clock dial is rendered art, and only the hands paint', () => {
    expect(sceneText().filter((t) => /^(3|6|9|12)$/.test(t))).toEqual([]);
  });
});

describe('the working-hours clock companion', () => {
  const fit = fitFloor(1200, 900);
  const schedule: WorkingHours = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '11:00',
    end: '15:00',
  };

  it('sets every schedule line through the wall-plane text transform', () => {
    const textEvents: Array<{ text: string; wallTransforms: number }> = [];
    const transforms: number[] = [0];
    const ctx = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
            return () => ({ addColorStop() {} });
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'save') return () => transforms.push(transforms.at(-1)!);
          if (prop === 'restore') return () => void transforms.pop();
          if (prop === 'transform')
            return () => {
              transforms[transforms.length - 1]! += 1;
            };
          if (prop === 'fillText')
            return (text: string) => textEvents.push({ text, wallTransforms: transforms.at(-1)! });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;

    scene(
      ctx,
      fit,
      new Map(),
      new Map(),
      new Map(),
      4,
      'revive',
      computeLightEnv(12, false),
      null,
      undefined,
      null,
      null,
      schedule,
    );

    for (const text of ['MON–FRI', '11am–3pm']) {
      const matches = textEvents.filter((event) => event.text === text);
      expect(matches, text).not.toHaveLength(0);
      expect(
        matches.every((event) => event.wallTransforms > 0),
        text,
      ).toBe(true);
    }
  });

  it('keeps every line inside the card, even when the days are a list rather than a run', () => {
    // A monospace stand-in: `measureText` is what the renderer shrinks against, so the same model has
    // to answer both the fit query and the assertion.
    const advance = 0.6;
    const drawn: Array<{ text: string; size: number }> = [];
    let font = '700 10px mono';
    const ctx = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'font') return font;
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
            return () => ({ addColorStop() {} });
          if (prop === 'measureText')
            return (text: string) => ({
              width: text.length * advance * Number(/ (\d+(?:\.\d+)?)px /.exec(font)?.[1] ?? 10),
            });
          if (prop === 'fillText')
            return (text: string) =>
              drawn.push({ text, size: Number(/ (\d+(?:\.\d+)?)px /.exec(font)?.[1] ?? 10) });
          return () => undefined;
        },
        set: (_target, prop, value) => {
          if (prop === 'font') font = String(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;

    const listed: WorkingHours = { ...schedule, days: ['mon', 'wed', 'fri'] };
    scene(
      ctx,
      fit,
      new Map(),
      new Map(),
      new Map(),
      4,
      'revive',
      computeLightEnv(12, false),
      null,
      undefined,
      null,
      null,
      listed,
    );

    const inner = WORKING_HOURS_CALENDAR.w - 18;
    for (const text of ['MON · WED · FRI', '11am–3pm']) {
      const hit = drawn.find((event) => event.text === text);
      expect(hit, text).toBeDefined();
      // A line shrunk to exactly the limit lands on it to within a float wobble, so allow one.
      expect(text.length * advance * hit!.size, text).toBeLessThanOrEqual(inner + 1e-6);
    }
  });
});

describe('renderScene draws the whole office without throwing', () => {
  const fit = fitFloor(1200, 900);
  const empty = new Map();

  it('renders an empty office (all desks vacant) — every chair style + monitor setup drawn', () => {
    expect(() => scene(mockCtx(), fit, empty, new Map(), new Map())).not.toThrow();
  });

  it('renders through the day and the night lighting envelopes', () => {
    expect(() =>
      scene(
        mockCtx(),
        fit,
        empty,
        new Map(),
        new Map(),
        0,
        'revive',
        computeLightEnv(12, true),
      ),
    ).not.toThrow();
    expect(() =>
      scene(
        mockCtx(),
        fit,
        empty,
        new Map(),
        new Map(),
        0,
        'revive',
        computeLightEnv(1, false),
      ),
    ).not.toThrow();
  });

  it('only ever assigns colours canvas can parse', () => {
    // The failure this catches is silent by construction — canvas keeps its previous colour rather than
    // throwing — so nothing else in the suite can see it. Run the populated scene (members at desks *and*
    // on the leisure furniture) so every furniture path that shades a face gets exercised.
    const paints: string[] = [];
    const nodes: OfficeNode[] = [
      node('desker', 'working'),
      node('lounger', 'active'),
      node('reader', 'active'),
    ];
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const placements = assignSeats(nodes);
    const poses = homePoses(placements, byName);
    scene(
      mockCtx(paints),
      fit,
      placements,
      byName,
      poses,
      1.5,
      'revive',
      computeLightEnv(21, true),
    );

    expect(paints.length).toBeGreaterThan(50); // the pass actually ran
    expect(paints.filter((c) => !parseableColor(c))).toEqual([]);
  });
});


/** Every dog pose blits one frame of the sheet — sleeping in the baked frame, trotting in the live loop —
 * and a pose with no cell would take the whole scene's frame down with it, not just the dog. */
describe('drawDog draws every pose from the sheet', () => {
  const fit = fitFloor(1200, 900);
  const modes: PetMode[] = ['sleep', 'curl', 'sit', 'stretch', 'walk'];
  const pet = (mode: PetMode, flip: boolean): PetState => ({
    lx: 300,
    ly: 300,
    mode,
    modeT: 0.4,
    phase: 1.7,
    flip,
    path: [],
    seg: 0,
    plan: 'nap',
    sitFor: 5,
    speed: 55,
    face: flip ? -1 : 1,
    faceMag: 1,
    depthSign: 1,
    vel: 55,
    cargo: 'none',
    errand: null,
  });

  it.each(modes)('blits one sheet frame for the %s pose, both facings', (mode) => {
    for (const flip of [false, true]) {
      const r = recordingCtx();
      drawDog(r.ctx, fit, pet(mode, flip), 3.2, ART);
      expect(r.ops.filter((o) => o.name === 'drawImage' && o.args[0] === FAKE_IMG && o.args.length === 9)).toHaveLength(1);
    }
  });

  it('draws no dog without a sheet', () => {
    const r = recordingCtx();
    drawDog(r.ctx, fit, pet('walk', false), 3.2, fakeArt({ dog: false }));
    expect(r.ops.filter((o) => o.name === 'drawImage')).toHaveLength(0);
  });
});


describe('where an actor sorts against the furniture', () => {
  const slot = DESK_SLOTS[0]!;
  const couch = { lx: NOOK.lx + LOUNGE.couch.dx, ly: NOOK.ly + LOUNGE.couch.dy };
  const cushion = { lx: couch.lx + 34, ly: couch.ly + 4 };

  function pose(over: Partial<Pose>): Pose {
    return {
      lx: slot.lx,
      ly: slot.ly,
      dir: slot.dir,
      small: false,
      carry: null,
      bubble: null,
      alpha: 1,
      moving: false,
      run: false,
      gesture: 0,
      gestureT: 0,
      phase: 0,
      stride: 0,
      sit: 0,
      ...over,
    };
  }

  it('sits a desk member at their chair, not at their feet', () => {
    const a = actorSortAnchor(pose({ sit: 1 }), slot, undefined);
    expect(a.seatedAtDesk).toBe(true);
    // the chair is CHAIR_OFF behind the desk, i.e. not the pose's own position
    expect(Math.hypot(a.lx - slot.lx, a.ly - slot.ly)).toBeGreaterThan(30);
  });

  it('sorts an errand diner at the couch, never at the desk they came from', () => {
    // The bug: this member's *placement* is still their desk while an errand has sat them on the
    // lounge couch. Keying off the placement sorted them across the room and the office painted over
    // them — they vanished for the length of the meal.
    const p = pose({ ...cushion, sit: 1, depthAt: couch });
    const a = actorSortAnchor(p, slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(couch.lx);
    expect(a.ly).toBe(couch.ly);
  });

  it('sorts a member at their own feet while the sit blend eases off after standing', () => {
    // The same bug's other face: `sit` eases down rather than switching, so just after getting up the
    // walker still read as seated — and was still sorted at that distant desk, sliding through the
    // lounge furniture on the way out.
    const p = pose({ lx: cushion.lx + 40, ly: cushion.ly + 40, sit: 0.7 });
    const a = actorSortAnchor(p, slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(p.lx);
    expect(a.ly).toBe(p.ly);
  });

  it('sorts a standing member at their feet even while at their own desk', () => {
    const a = actorSortAnchor(pose({ sit: 0 }), slot, undefined);
    expect(a.seatedAtDesk).toBe(false);
    expect(a.lx).toBe(slot.lx);
  });

  it('still honours a leisure placement that asks to sort with its furniture', () => {
    const p = pose({ ...cushion, sit: 1 });
    const a = actorSortAnchor(p, undefined, { depthAt: couch });
    expect(a.lx).toBe(couch.lx);
  });
});

/**
 * The contact pool's compounding guard.
 *
 * A desk is not one solid — it is a top, four legs, a monitor, a keyboard and a mug, and every one of
 * them reaches `box()`. The first cut of the pool drew for all of them, and a dozen overlapping pools
 * per pod turned the desks into a dark brown mass. The `MIN_SPAN` floor is what stops that, so it is
 * pinned here: without it the guard is one careless edit away from returning, and the symptom (a room
 * that has quietly lost its light) is not something any other assertion in this file would catch.
 */
describe('contact pool', () => {
  const fit = fitFloor(1200, 900);
  /** Count the radial gradients a call creates — one per pool actually drawn. */
  function poolCtx(): { ctx: CanvasRenderingContext2D; pools: () => number } {
    let n = 0;
    const grad = { addColorStop() {} };
    const ctx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createRadialGradient')
            return () => {
              n++;
              return grad;
            };
          if (prop === 'createLinearGradient') return () => grad;
          if (prop === 'measureText') return () => ({ width: 0 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, pools: () => n };
  }

  it('draws nothing for a footprint below the minimum span', () => {
    const { ctx, pools } = poolCtx();
    // A keyboard-sized solid: real, but far too small to own a shadow anyone would notice.
    contactPool(ctx, fit, 100, 100, 6, 4, 0);
    expect(pools()).toBe(0);
  });

  it('draws a pool for a desk-sized footprint', () => {
    const { ctx, pools } = poolCtx();
    contactPool(ctx, fit, 100, 100, 100, 68, 0);
    expect(pools()).toBe(1);
  });

  it('draws the pool at the surface the solid stands on, not always the floor', () => {
    // The monitor on a desk pools on the DESK TOP. Same footprint, different baseUp, must not collapse
    // to the same y — otherwise everything in the room casts onto the floor and desks read as glass.
    const ys: number[] = [];
    const grad = { addColorStop() {} };
    const spy = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => grad;
          if (prop === 'translate') return (_x: number, y: number) => void ys.push(y);
          if (prop === 'measureText') return () => ({ width: 0 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    contactPool(spy, fit, 100, 100, 40, 40, 0);
    contactPool(spy, fit, 100, 100, 40, 40, 30);
    expect(ys).toHaveLength(2);
    expect(ys[1]!).toBeLessThan(ys[0]!); // higher base → higher on screen
  });
});

/**
 * "The docked laptop must never block the view of the front of any monitor screen" (nick,
 * 2026-09-04) — held here as geometry rather than as a look at two desks.
 *
 * It takes both halves. OUTBOARD alone is not enough, because a prop nearer the viewer can still
 * paint over a panel it overlaps diagonally in the projection; BEHIND alone is not enough either,
 * because a dock hidden behind the screen is not a dock anyone can see. The trap the second half
 * exists for is real: `at()`'s across term is +1 on an N desk and −1 on a W one, so a single written
 * across sorts behind the monitor on one camera-facing row and in FRONT of it on the other — a
 * defect that looks fine on whichever row you happened to open.
 */
describe('the dock never covers a screen (laptop/dock design)', () => {
  const FACINGS = ['N', 'S', 'E', 'W'] as const;

  it('sorts behind the monitor at every facing, not just the row you looked at', () => {
    for (const dir of FACINGS) {
      const dock = deskPropSort(dir, 26, dockAcross(dir));
      const mon = deskPropSort(dir, MONITOR_ALONG, 0);
      expect(dock, `dock must paint before the monitor on a ${dir} desk`).toBeLessThan(mon);
    }
  });

  it('sits mostly clear of the widest panel, so it reads as beside it and not tucked behind it', () => {
    // The soft half of the requirement, and deliberately not "no overlap at all": a 20-wide dock
    // cannot fit outboard of a dual's 35 on a 100-wide slab, and the desk edge is the harder limit.
    // Behind (above) is what makes the screen safe; this only keeps the dock worth drawing.
    for (const dir of FACINGS) {
      const outer = Math.abs(dockAcross(dir)) + DOCK_HALF_ACROSS;
      const clear = (outer - WIDEST_PANEL_HALF) / (DOCK_HALF_ACROSS * 2);
      expect(clear, `dock is mostly hidden behind a panel on a ${dir} desk`).toBeGreaterThan(0.6);
    }
  });

  it('stays on the desk — outboard is bounded by the slab, not just by the panel', () => {
    for (const dir of FACINGS) {
      expect(Math.abs(dockAcross(dir)) + DOCK_HALF_ACROSS).toBeLessThanOrEqual(DESK_W / 2);
    }
  });

  it('a fixed across would have failed the first of these — the sign flip is the whole point', () => {
    // The shape of the bug this replaced: one written constant, used at every facing.
    const naive = -26;
    const behind = FACINGS.filter(
      (dir) => deskPropSort(dir, 18, naive) < deskPropSort(dir, MONITOR_ALONG, 0),
    );
    expect(behind.length).toBeLessThan(FACINGS.length); // it cannot be behind on all four
  });
});

/**
 * The desk's near half, and the ordering #1394 shipped without a test.
 *
 * #1394 moved the whole desk's key to its near corner and buried the sitter at every N/W desk; #1400
 * reverted it. The lesson is that the passer-by and the sitter ask opposite questions of one scalar,
 * so the desk keeps its centre key and gains a SECOND item on its camera-near half — keyed at the
 * near corner, except never past this desk's own sitter.
 *
 * These pin every claim at all four facings. The first cut of the implementation defined the extra
 * half by `FWD` rather than by depth and these caught it immediately on N: on an N or W desk the
 * facing points AWAY from the viewer, so the room side is the far side.
 */
describe('the desk near half (the correct version of the reverted #1394)', () => {
  const FACINGS = ['N', 'S', 'E', 'W'] as const;
  const slotAt = (dir: (typeof FACINGS)[number]) => ({ lx: 400, ly: 400, dir });
  /** Where a sitter at this desk sorts: the chair, opposite the facing (see `actorSortAnchor`). */
  const seatOf = (dir: (typeof FACINGS)[number]) => {
    const f = FWD[dir];
    return { lx: 400 - f[0] * CHAIR_OFF, ly: 400 - f[1] * CHAIR_OFF };
  };

  it('an EMPTY desk keys its near half past the slab at every facing — that is what catches a passer-by', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      expect(
        deskNearDepth(slot, null),
        `near half must key after the slab on a ${dir} desk`,
      ).toBeGreaterThan(depth(slot.lx, slot.ly));
    }
  });

  it('a member standing clear in front of an empty desk still paints after it', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const sn = dir === 'S' || dir === 'N';
      const wx = sn ? DESK_W : DESK_D;
      const dy = sn ? DESK_D : DESK_W;
      // A body a stride beyond the desk's near corner — plainly in the room, not at the desk.
      const outside = depth(slot.lx + wx / 2 + 20, slot.ly + dy / 2 + 20);
      expect(
        outside,
        `a member in front of a ${dir} desk must paint after its near half`,
      ).toBeGreaterThan(deskNearDepth(slot, null));
    }
  });

  it('NEVER keys past its own sitter, at any facing — the regression #1400 reverted', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const seat = seatOf(dir);
      expect(
        deskNearDepth(slot, seat),
        `near half must paint before the sitter on a ${dir} desk`,
      ).toBeLessThan(depth(seat.lx, seat.ly));
    }
  });

  it('an occupied desk is never keyed FURTHER forward than the same desk empty', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      expect(deskNearDepth(slot, seatOf(dir))).toBeLessThanOrEqual(deskNearDepth(slot, null));
    }
  });
});

/**
 * Lane 01M2K1G140. /character-sheet drew a seated member as a body alone in mid-air, so the one tool
 * built to judge bodies at 4x could not show a seated beat at all — no slab for forearms to rest on,
 * no chair for a roll beat to move, and nothing for `handsInLap` to suppress. That is how #1394's
 * regression (a desk burying a sitter's head and torso at N/W) reached the live broadcast.
 *
 * The sheet now draws the real station. These pin the thing that makes that safe rather than merely
 * nicer-looking: the room and the fixture read ONE set of depth keys. A fixture with its own copy of
 * the paint order drifts, and a drifted fixture is worse than none — it is confidently wrong, which
 * is precisely the failure this repo paid for three times in two days (#1397, #1404, #1430).
 */
describe('one station, one set of keys — the room and the character sheet', () => {
  const FACINGS = ['N', 'S', 'E', 'W'] as const;
  const slotAt = (dir: (typeof FACINGS)[number]) => ({
    id: 0,
    lx: 400,
    ly: 400,
    dir,
    pod: -1,
    kind: 'pod' as const,
  });
  const ctx = mockCtx();
  const FIT = fitFloor(1200, 900);

  it('builds the station every facing needs: slab, near half, and the chair in two pieces', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const { items } = deskStationItems(ctx, FIT, slot, null, { rendered: ART, teamName: 'revive' });
      expect(items.length, `a ${dir} desk`).toBe(4);
      // The slab first, its room-side half after it — the whole point of the #1410 split.
      expect(items[1]!.d).toBeGreaterThan(items[0]!.d);
    }
  });

  it('the near half is the same key `deskNearDepth` reports — not a second spelling of it', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const { items } = deskStationItems(ctx, FIT, slot, null, { rendered: ART, teamName: 'revive' });
      expect(items[1]!.d).toBe(deskNearDepth(slot, null));
    }
  });

  /*
   * My first cut of this asserted the backrest always paints AFTER the cushion, and it went red on S
   * — correctly. An S-facing member faces the viewer, so their chair is BEHIND them and both pieces
   * belong in front of nothing; at N the chair stands between viewer and member and the backrest
   * must cover their back. The claim is not "backrest last", it is that the chair is on the opposite
   * side of the sitter from their desk, and the backrest is the far end of it. That is facing-general;
   * "backrest last" was S-shaped thinking dressed up as an invariant.
   */
  it('the sitter sits on the cushion at every facing, and the chair runs away from the desk', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const seat = deskSeat(slot);
      const { items } = deskStationItems(ctx, FIT, slot, null, { rendered: ART, teamName: 'revive' });
      const [slab, , base, back] = [items[0]!, items[1]!, items[2]!, items[3]!];
      const body = actorDepth(seat.lx, seat.ly);
      // You always paint over the cushion you are sitting on — a chair drawn as ONE box swallows the
      // sitter from the waist down at whichever facing it sorts wrongly on, which is why it is two.
      expect(body, `${dir}: the sitter must paint over the cushion`).toBeGreaterThan(base.d);
      // Desk → cushion → backrest runs one way, whichever way the desk faces. If the backrest ever
      // doubled back toward the desk it would land on the wrong side of the body at that facing.
      expect(
        Math.sign(back.d - base.d),
        `${dir}: the backrest must continue away from the desk, not back toward it`,
      ).toBe(Math.sign(base.d - slab.d));
    }
  });

  it('seated forearms come back on top of the slab, one constant after it — #1397', () => {
    for (const dir of FACINGS) {
      const slot = slotAt(dir);
      const { items } = deskStationItems(ctx, FIT, slot, null, { rendered: ART, teamName: 'revive' });
      expect(seatedArmsDepth(slot)).toBeGreaterThan(items[0]!.d);
      // …and still before the near half, which is the desk edge in FRONT of the arms.
      expect(seatedArmsDepth(slot)).toBeLessThan(items[1]!.d);
    }
  });

  it('the character sheet spells no depth key of its own — it asks for the room’s', () => {
    const sheet = readFileSync(
      fileURLToPath(new URL('../../routes/character-sheet.tsx', import.meta.url)),
      'utf8',
    );
    // It goes through the shared builder and the shared keys…
    for (const fn of [
      'deskStationItems',
      'deskSeat',
      'actorDepth',
      'seatedArmsDepth',
      'actorSortAnchor',
    ]) {
      expect(sheet, `the sheet must reach for ${fn}`).toContain(fn);
    }
    // …and it honours the overlay's own gate, so a beat that drops the hands into the lap does not
    // paint lap arms floating on the desk. A sheet that always drew the overlay would HIDE that bug.
    expect(sheet).toContain('handsInLap');
    // …and it never computes a sort key OR a chair position itself. Either one in this file is a
    // second home for something the room already knows, and a fixture that drifts is worse than none.
    expect(sheet).not.toMatch(/\bdepth\(/);
    expect(sheet, 'the sheet must not derive the chair from CHAIR_OFF/FWD').not.toMatch(
      /CHAIR_OFF|\bFWD\b/,
    );
  });
});

/**
 * nick, watching /live 2026-09-15: "in the row of desks on the northeast wall, all the laptop
 * stands/laptops look like they are floating in front of the monitors." That row is the BENCH — the
 * four-seat shared counter, the only run of seats against a wall.
 *
 * Two independent defects put them there, and a third is why no test said so.
 *
 * `benchStation` placed the dock with `DOCK_ALONG`/`DOCK_ACROSS`, which are sized against a POD desk
 * (DESK_D 68, DESK_W 100). The bench counter is 30 deep and each seat's share of the top is 75, so
 * the dock stood 17 units past the back edge — in the air — and leaned 12.5 units into its
 * neighbour's seat. The monitor one line above already derived its own position from `BENCH.deep`;
 * the dock beside it got the pod constants verbatim. One prop knew what furniture it was standing on.
 *
 * And `benchStation` painted monitor → dock → keyboard in CALL ORDER, with no depth sort at all,
 * while `drawWorkstation` sorts every prop. So the dock painted over the monitor at every facing
 * regardless of where it was — which is why it read as "in front of" rather than as a near miss.
 */
describe('the bench row: a dock has to be standing on the counter it is docked to', () => {
  const seatShare = BENCH.long / BENCH.seats;
  const benchSeats = DESK_SLOTS.filter((s) => s.kind === 'bench');

  it('has the four seats this is about', () => {
    expect(benchSeats).toHaveLength(BENCH.seats);
  });

  it('every dock stands entirely ON the counter, not out past its back edge', () => {
    for (const slot of benchSeats) {
      const { lx, ly } = benchDockAt(slot);
      // The cradle's own footprint, not just its centre: an overhanging edge is the visible defect.
      const backEdge = BENCH.ly - BENCH.deep / 2;
      const frontEdge = BENCH.ly + BENCH.deep / 2;
      expect(
        ly - DOCK_CRADLE_ALONG / 2,
        `seat ${slot.id} hangs off the BACK of the counter`,
      ).toBeGreaterThanOrEqual(backEdge);
      expect(
        ly + DOCK_CRADLE_ALONG / 2,
        `seat ${slot.id} hangs off the FRONT of the counter`,
      ).toBeLessThanOrEqual(frontEdge);
      expect(Number.isFinite(lx)).toBe(true);
    }
  });

  it('every dock stays inside its own seat’s share of the counter', () => {
    for (const slot of benchSeats) {
      const { lx } = benchDockAt(slot);
      const off = Math.abs(lx - slot.lx) + DOCK_HALF_ACROSS;
      expect(off, `seat ${slot.id} leans into its neighbour`).toBeLessThanOrEqual(seatShare / 2);
    }
  });

  it('the dock paints BEHIND the monitor — by geometry, not by call order', () => {
    for (const slot of benchSeats) {
      expect(
        benchPropSort(slot, benchDockAt(slot)),
        `seat ${slot.id}: the dock must sort before its monitor`,
      ).toBeLessThan(benchPropSort(slot, benchMonitorAt(slot)));
    }
  });

  /*
   * `deskPropSort` was exported with the comment "so the dock's 'behind the monitor' claim can be
   * falsified" — and `drawWorkstation` inlined the identical expression instead of calling it. The
   * four-facing test below it was therefore checking a COPY of the rule, and would have gone on
   * passing if the painter's copy drifted. Same trap as #1397, #1404 and #1430, in the one place
   * that exists to prove this class of thing.
   */
  it('the painter asks deskPropSort for its order — it does not keep its own copy of the rule', () => {
    const src = readFileSync(fileURLToPath(new URL('./render.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/sum:\s*deskPropSort\(/);
    // The inlined spelling must be gone: one home, or the test above proves nothing.
    expect(src).not.toMatch(/sum:\s*f\[0\] \* along/);
  });
});

/**
 * Every desk prop stands ON the desk.
 *
 * This is the invariant the bench dock broke (it stood 17 units past the counter's back edge), and it
 * held on pod desks only by luck of tuning — several stations sit flush at the edge, so a prop that
 * grows, or a station that moves, falls off with no test to say so. The dock did exactly that once
 * already: widening the laptop 20 → 24 in #1394 pushed `|dockAcross| + DOCK_HALF_ACROSS` to 52 on a
 * 50 half-width slab, and nick caught it on the broadcast rather than CI.
 *
 * It reads the footprint off `PROP_SPEC` — the same record the painter places and sizes from — so
 * this is a property of what is drawn, not of numbers copied into a test.
 */
describe('desk props stand on the desk', () => {
  const FACINGS = ['N', 'S', 'E', 'W'] as const;

  it('every prop’s base is inside the slab, at every facing', () => {
    for (const dir of FACINGS) {
      // The slab's half-extents in the desk's own frame: DESK_W is always across the shoulders,
      // whichever way the desk faces — the box swaps wx/dy, the desk-relative frame does not.
      const halfAlong = DESK_D / 2;
      const halfAcross = DESK_W / 2;
      for (const [kind, sp] of Object.entries(PROP_SPEC)) {
        expect(
          Math.abs(sp.along) + sp.d / 2,
          `${kind} runs off the ${dir} desk along the facing`,
        ).toBeLessThanOrEqual(halfAlong);
        expect(
          Math.abs(sp.across) + sp.w / 2,
          `${kind} runs off the ${dir} desk across the shoulders`,
        ).toBeLessThanOrEqual(halfAcross);
      }
    }
  });

  it('no two props are stacked on the same spot', () => {
    const specs = Object.entries(PROP_SPEC);
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const [an, a] = specs[i]!;
        const [bn, b] = specs[j]!;
        const apart =
          Math.abs(a.along - b.along) >= (a.d + b.d) / 2 ||
          Math.abs(a.across - b.across) >= (a.w + b.w) / 2;
        expect(apart, `${an} and ${bn} occupy the same patch of desk`).toBe(true);
      }
    }
  });

  it('no prop lands on the keyboard, the mouse, the monitor or the dock', () => {
    /*
     * The work gear is not optional and not hashed, so a personal prop overlapping it is a prop
     * sitting on the keys. Two things this has to get right, both of which it got wrong first:
     *
     * - the MONITOR's footprint is its base plate (22 across, 11 deep), NOT the panel. The panel is
     *   raised on a neck and a dual's outer edge reaches 35 — comparing that against a pot standing
     *   on the desk flags a collision between things at different heights. First cut did exactly
     *   that and "found" a plant/monitor overlap that is a panel passing over a pot.
     * - the DOCK changes sides with the facing (`dockAcross`), so a fixed +38 tests half the floor.
     */
    for (const dir of FACINGS) {
      const gear = [
        { name: 'keyboard', along: KEYBOARD_ALONG, across: 0, d: 13, w: 40 },
        { name: 'mouse', along: KEYBOARD_ALONG + 2, across: 27, d: 11, w: 7 },
        { name: 'monitor base', along: MONITOR_ALONG, across: 0, d: 11, w: 22 },
        {
          name: 'dock',
          along: 26,
          across: dockAcross(dir),
          d: DOCK_CRADLE_ALONG,
          w: DOCK_HALF_ACROSS * 2,
        },
      ];
      for (const [kind, sp] of Object.entries(PROP_SPEC)) {
        for (const g of gear) {
          const apart =
            Math.abs(sp.along - g.along) >= (sp.d + g.d) / 2 ||
            Math.abs(sp.across - g.across) >= (sp.w + g.w) / 2;
          expect(apart, `${kind} overlaps the ${g.name} on a ${dir} desk`).toBe(true);
        }
      }
    }
  });
});

/**
 * Sprite cache (spec 2026-09-17): the standing invariant. With a cache supplied, renderScene must
 * emit exactly the direct path's ops in the direct path's order — the blit bookkeeping aside.
 * `passthroughCache` draws straight onto the caller's recording context (no offscreen), so the ops
 * a sprite part emits land in the same stream as the live parts, in the order the loop ran them.
 */
function passthroughCache(ctx: CanvasRenderingContext2D): SpriteCache {
  return {
    box: measuredBox,
    get: (_key, _box, draw) => {
      draw(ctx);
      return {} as CanvasImageSource;
    },
    size: () => 0,
    clear: () => {},
  };
}
const BLIT_OPS = new Set(['save', 'restore', 'setTransform', 'drawImage']);
const sceneOps = (ops: RecordedOp[]): string[] => fmtOps(ops.filter((o) => !BLIT_OPS.has(o.name)));

/** A full room: 24 members across pods, bench, window desks and the overflow strip, working and idle. */
function fullRoom(): {
  placements: ReturnType<typeof assignSeats>;
  byName: Map<string, OfficeNode>;
  poses: Map<string, Pose>;
} {
  const names = [
    'ada',
    'bo',
    'cy',
    'di',
    'ed',
    'fay',
    'gus',
    'hal',
    'ivy',
    'jo',
    'kim',
    'lou',
    'mo',
    'ned',
    'oz',
    'pat',
    'quin',
    'rae',
    'sy',
    'ty',
    'uma',
    'vic',
    'wes',
    'xi',
  ];
  const nodes = names.map((n, i) =>
    node(n, i % 3 === 0 ? 'working' : i % 3 === 1 ? 'active' : 'offline'),
  );
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const placements = assignSeats(nodes);
  return { placements, byName, poses: homePoses(placements, byName) };
}

describe('sprite parts', () => {
  const fit = fitFloor(1920, 1080);
  const env = computeLightEnv(21, true); // night: veil up, lamps on — the busiest paint
  const schedule: WorkingHours = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '09:00',
    end: '17:00',
  };
  const wallFixture = (): WallBoard =>
    projectWallBoard({
      lanes: [laneFix('a', 'open'), laneFix('b', 'active'), laneFix('c', 'blocked')],
      warnings: [],
    })!;

  it('with a cache, renderScene emits the direct path’s ops in the same order (blit bookkeeping aside)', () => {
    const { placements, byName, poses } = fullRoom();
    const a = recordingCtx();
    scene(
      a.ctx,
      fit,
      placements,
      byName,
      poses,
      3,
      'revive',
      env,
      null,
      undefined,
      null,
      wallFixture(),
      schedule,
    );
    const b = recordingCtx();
    scene(
      b.ctx,
      fit,
      placements,
      byName,
      poses,
      3,
      'revive',
      env,
      null,
      undefined,
      null,
      wallFixture(),
      schedule,
      {
        sprites: passthroughCache(b.ctx),
        dpr: 1,
      },
    );
    expect(sceneOps(b.ops)).toEqual(sceneOps(a.ops));
    expect(a.ops.length).toBeGreaterThan(1000); // the fixture actually painted a room
  });
});

/** Ops that READ a context property this draw never SET: fill→fillStyle, stroke→strokeStyle+lineWidth,
 * fillText→font+textAlign+textBaseline+fillStyle. `save`/`restore` are tracked as a stack. A cached
 * item starts from the 2D defaults, so anything it reads without setting is state it was silently
 * inheriting from the previous item on the direct path — a sprite would paint it differently. */
function readsBeforeWrites(ops: RecordedOp[]): string[] {
  const reads: Record<string, string[]> = {
    fill: ['fillStyle'],
    fillRect: ['fillStyle'],
    fillText: ['fillStyle', 'font', 'textAlign', 'textBaseline'],
    stroke: ['strokeStyle', 'lineWidth'],
    strokeRect: ['strokeStyle', 'lineWidth'],
    strokeText: ['strokeStyle', 'font'],
  };
  let set = new Set<string>();
  const stack: Set<string>[] = [];
  const bad: string[] = [];
  ops.forEach((o, i) => {
    if (o.name.startsWith('set:')) set.add(o.name.slice(4));
    else if (o.name === 'save') stack.push(new Set(set));
    else if (o.name === 'restore') set = stack.pop() ?? set;
    else
      for (const p of reads[o.name] ?? []) if (!set.has(p)) bad.push(`${i}:${o.name} reads ${p}`);
  });
  return bad;
}

describe('workstation phases (sprite cache)', () => {
  const fit = fitFloor(1920, 1080);
  const slot = DESK_SLOTS.find((s) => s.kind !== 'bench')!;
  /** A desk whose screen faces the camera (N or W) — the only facings whose lit panel paints a face
   * at all, so the only ones where "the screen is the live part" is observable. */
  const facingSlot = DESK_SLOTS.find(
    (s) => s.kind !== 'bench' && (s.dir === 'N' || s.dir === 'W'),
  )!;
  const owner = node('ava', 'working');
  const cases = [
    ['empty', null, false],
    ['owner idle', owner, false],
    ['owner working', owner, true],
  ] as const;
  for (const [label, n, atWork] of cases) {
    it(`${label}: pre ++ monitor ++ post == all`, () => {
      const all = recordingCtx();
      ws(all.ctx, fit, slot, n, 'revive', false, 3, undefined, true, atWork, 'all');
      const split = recordingCtx();
      for (const phase of ['pre', 'monitor', 'post'] as const) {
        ws(
          split.ctx,
          fit,
          slot,
          n,
          'revive',
          false,
          3,
          undefined,
          true,
          atWork,
          phase,
        );
      }
      expect(fmtOps(split.ops)).toEqual(fmtOps(all.ops));
      expect(all.ops.length).toBeGreaterThan(50);
    });
  }
  it('an owned, stepped-away desk (afterglow prop at the monitor’s station) splits the same way', () => {
    const away: OfficeNode = { ...owner, presence: 'away', last_seen_at: Date.now() - 60_000 };
    const all = recordingCtx();
    ws(all.ctx, fit, slot, away, 'revive', true, 3, undefined, true, false, 'all');
    const split = recordingCtx();
    for (const phase of ['pre', 'monitor', 'post'] as const) {
      ws(split.ctx, fit, slot, away, 'revive', true, 3, undefined, true, false, phase);
    }
    expect(fmtOps(split.ops)).toEqual(fmtOps(all.ops));
    expect(fmtOps(all.ops).some((o) => o.includes('rgba(122, 148, 156'))).toBe(true); // the afterglow painted
  });
  it('the monitor phase is the only one that reads t — and only while the owner pulses (ADR 660)', () => {
    // A live pulse: the desktop scrolls on `t`, so two frames differ.
    const pulsing = {
      ...owner,
      pulse: { ts: Date.now(), intensity: 3, kind: 'edit' as const, last_ts: Date.now() },
    };
    for (const phase of ['pre', 'post'] as const) {
      const a = recordingCtx();
      ws(a.ctx, fit, slot, pulsing, 'revive', false, 1, undefined, true, true, phase);
      const b = recordingCtx();
      ws(b.ctx, fit, slot, pulsing, 'revive', false, 9, undefined, true, true, phase);
      expect(fmtOps(a.ops)).toEqual(fmtOps(b.ops));
    }
    const c = recordingCtx();
    ws(
      c.ctx,
      fit,
      facingSlot,
      pulsing,
      'revive',
      false,
      1,
      undefined,
      true,
      true,
      'monitor',
    );
    const d = recordingCtx();
    ws(
      d.ctx,
      fit,
      facingSlot,
      pulsing,
      'revive',
      false,
      9,
      undefined,
      true,
      true,
      'monitor',
    );
    expect(fmtOps(c.ops)).not.toEqual(fmtOps(d.ops));
  });

  describe('the screen follows the pulse, not the posture (ADR 660 §3)', () => {
    const paint = (n: typeof owner, t = 3) => {
      const r = recordingCtx();
      ws(
        r.ctx,
        fit,
        facingSlot,
        n,
        'revive',
        false,
        t,
        undefined,
        true,
        true,
        'monitor',
      );
      return fmtOps(r.ops);
    };
    const lighter = (ops: string[]) => ops.filter((o) => o.includes('lighter')).length;
    const now = Date.now();

    it('a seated working owner with no pulse has a lit, STILL screen and no bloom', () => {
      expect(lighter(paint(owner))).toBe(0);
      expect(paint(owner, 1)).toEqual(paint(owner, 9)); // nothing scrolls on `t`
    });

    it('a live pulse animates the desktop and blooms', () => {
      const pulsing = {
        ...owner,
        pulse: { ts: now, intensity: 2, kind: 'read' as const, last_ts: now },
      };
      expect(lighter(paint(pulsing))).toBeGreaterThan(0);
    });

    it('a pulse older than the TTL is as still as none', () => {
      const stale = {
        ...owner,
        pulse: { ts: now - 60_000, intensity: 9, kind: 'run' as const, last_ts: now - 60_000 },
      };
      expect(lighter(paint(stale))).toBe(0);
    });

    it('a run blooms brighter than an edit', () => {
      const alpha = (ops: string[]) => {
        const m = ops.join('\n').match(/rgba\(154, 228, 240, ([0-9.]+)\)/);
        return m ? Number(m[1]) : -1;
      };
      const run = {
        ...owner,
        pulse: { ts: now, intensity: 2, kind: 'run' as const, last_ts: now },
      };
      const edit = {
        ...owner,
        pulse: { ts: now, intensity: 2, kind: 'edit' as const, last_ts: now },
      };
      expect(alpha(paint(run))).toBeGreaterThan(alpha(paint(edit)));
      expect(alpha(paint(edit))).toBeCloseTo(0.38, 2);
    });
  });
  it('cached phases set every state they read (nothing inherited from the previous item)', () => {
    for (const [, n, atWork] of cases) {
      for (const phase of ['pre', 'post'] as const) {
        const r = recordingCtx();
        ws(r.ctx, fit, slot, n, 'revive', false, 3, undefined, true, atWork, phase);
        expect(readsBeforeWrites(r.ops)).toEqual([]);
      }
    }
  });
  it('deskStationItems carries sprite·live·sprite parts for a desk slot and no workstation parts for a bench seat', () => {
    const r = recordingCtx();
    const desk = deskStationItems(r.ctx, fit, slot, owner, {
      rendered: ART,
      teamName: 'revive',
      t: 3,
      lampsOn: true,
    });
    expect(desk.items[0]!.parts!.map((p) => p.kind)).toEqual(['sprite', 'live', 'sprite']);
    const bench = deskStationItems(r.ctx, fit, DESK_SLOTS.find((s) => s.kind === 'bench')!, owner, {
      rendered: ART,
      teamName: 'revive',
    });
    // A bench seat has no workstation; only its resting chair is still furniture, and sprites as such.
    const keys = bench.items
      .flatMap((i) => i.parts ?? [])
      .map((p) => (p.kind === 'sprite' ? p.key.split('·')[0] : 'live'));
    expect(keys.every((k) => k === 'chair')).toBe(true);
  });
  it('a chair sprites only at rest — mid roll-back it paints live', () => {
    const r = recordingCtx();
    const desk = DESK_SLOTS.find((s) => s.kind !== 'bench')!;
    const seat = deskSeat(desk);
    const at = (gesture: number, gestureT: number) =>
      deskStationItems(r.ctx, fit, desk, owner, {
        rendered: ART,
        teamName: 'revive',
        ownerPose: { lx: seat.lx, ly: seat.ly, dir: desk.dir, sit: 1, gesture, gestureT } as Pose,
      }).items.filter((i) =>
        i.parts?.some((p) => p.kind === 'sprite' && p.key.startsWith('chair·')),
      ).length;
    expect(at(0, 0)).toBe(2); // base + back, resting
    expect(at(GESTURE.roll, 0.5)).toBe(0);
  });
  it('the workstation key changes with every pixel-changing input and never with t', () => {
    const base = {
      slot,
      node: owner,
      teamName: 'revive',
      owned: false,
      working: true,
      lampLit: true,
      hidden: undefined,
      fit,
      dpr: 1,
      warmAlpha: '',
    };
    const k = workstationKey(base);
    expect(workstationKey({ ...base, working: false })).not.toBe(k);
    expect(workstationKey({ ...base, lampLit: false })).not.toBe(k);
    expect(workstationKey({ ...base, owned: true })).not.toBe(k);
    expect(workstationKey({ ...base, node: null })).not.toBe(k);
    expect(workstationKey({ ...base, hidden: new Set(['coffee'] as const) })).not.toBe(k);
    expect(workstationKey({ ...base, fit: { ...fit, ox: fit.ox + 0.5 } })).not.toBe(k);
    expect(workstationKey({ ...base, dpr: 2 })).not.toBe(k);
    expect(workstationKey({ ...base, warmAlpha: '0.108' })).not.toBe(k);
    expect(workstationKey({ ...base, hidden: new Set(['water', 'coffee'] as const) })).toBe(
      workstationKey({ ...base, hidden: new Set(['coffee', 'water'] as const) }),
    );
  });
  it('ownedDeskWarmAlpha is the exact string the afterglow paints with', () => {
    const now = 1_000_000_000;
    expect(ownedDeskWarmAlpha(null, true, now)).toBe('');
    expect(ownedDeskWarmAlpha(owner, false, now)).toBe('');
    const offline: OfficeNode = { ...owner, presence: 'offline', last_seen_at: now - 1_800_000 };
    expect(ownedDeskWarmAlpha(offline, true, now)).toBe('0.090');
    expect(ownedDeskWarmAlpha({ ...offline, last_seen_at: now - 7_200_000 }, true, now)).toBe('');
    const away: OfficeNode = { ...owner, presence: 'away', last_seen_at: now };
    expect(ownedDeskWarmAlpha(away, true, now)).toBe('0.108');
  });
});

describe('static furniture sprites', () => {
  const fit = fitFloor(1920, 1080);
  it('plants, shelves, the entrance and the bench counter each carry one sprite part', () => {
    const { placements, byName, poses } = fullRoom();
    const keys: string[] = [];
    const census: SpriteCache = {
      box: measuredBox,
      get: (key, _box, draw) => {
        keys.push(key);
        draw(recordingCtx().ctx);
        return {} as CanvasImageSource;
      },
      size: () => 0,
      clear: () => {},
    };
    const r = recordingCtx();
    scene(
      r.ctx,
      fit,
      placements,
      byName,
      poses,
      3,
      'revive',
      computeLightEnv(21, true),
      null,
      undefined,
      null,
      null,
      null,
      {
        sprites: census,
        dpr: 1,
      },
    );
    const count = (kind: string) => keys.filter((k) => k.startsWith(`${kind}·`)).length;
    expect(count('plant')).toBe(PLANTS.length);
    expect(count('shelf')).toBe(BOOKSHELVES.length);
    expect(count('entrance')).toBe(1);
    expect(count('bench')).toBe(1);
    expect(new Set(keys).size).toBe(keys.length); // no two items share a key
  });
  it('every sprite part in the room sets every state it reads — the furniture made sprites for dirty rects too', () => {
    const { placements, byName, poses } = fullRoom();
    const draws = new Map<string, (c: CanvasRenderingContext2D) => void>();
    const census: SpriteCache = {
      box: measuredBox,
      get: (key, _box, draw) => {
        draws.set(key, draw);
        return {} as CanvasImageSource;
      },
      size: () => 0,
      clear: () => {},
    };
    scene(
      recordingCtx().ctx,
      fit,
      placements,
      byName,
      poses,
      3,
      'revive',
      computeLightEnv(21, true),
      null,
      undefined,
      null,
      null,
      null,
      {
        sprites: census,
        dpr: 1,
      },
    );
    const kinds = new Set([...draws.keys()].map((k) => k.split('·')[0]));
    for (const k of ['near', 'chair', 'meeting', 'printer', 'nook', 'recep'])
      expect(kinds.has(k), k).toBe(true);
    for (const [key, draw] of draws) {
      const r = recordingCtx();
      draw(r.ctx);
      expect(readsBeforeWrites(r.ops), key).toEqual([]);
    }
  });
  it('a sprite key follows the palette, so a theme flip cannot reuse the old raster', () => {
    const before = paletteKey();
    setScenePalette({ ...DARK_PALETTE, wood: '#123456' });
    expect(paletteKey()).not.toBe(before);
    setScenePalette(DARK_PALETTE);
    expect(paletteKey()).toBe(before);
  });
});

describe('background layer (sprite cache)', () => {
  const fit = fitFloor(1920, 1080);
  const env = computeLightEnv(14, true);
  const schedule: WorkingHours = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '09:00',
    end: '17:00',
  };
  const board = (): WallBoard =>
    projectWallBoard({ lanes: [laneFix('a', 'open'), laneFix('b', 'active')], warnings: [] })!;

  it('the walls read the office hour only through the clock hands', () => {
    const live1 = recordingCtx();
    drawWalls(live1.ctx, fit, { ...env, hours: 9 }, schedule, board(), 3, undefined, ART);
    const live2 = recordingCtx();
    drawWalls(live2.ctx, fit, { ...env, hours: 16.5 }, schedule, board(), 3, undefined, ART);
    expect(fmtOps(live1.ops)).not.toEqual(fmtOps(live2.ops)); // the clock hands moved
    // every fixture blits its art once, and the prints paint on their mats
    expect(live1.ops.filter((o) => o.name === 'drawImage' && o.args[0] === FAKE_IMG)).toHaveLength(ART_IDS.filter((id) => id.startsWith('wall/')).length);
  });

  it('a card that just landed sways on its tape, a taken one leaves a pin hole, and both settle (L5)', () => {
    const draw = (w: WallBoard) => {
      const r = recordingCtx();
      drawWalls(r.ctx, fit, env, schedule, w, 3, undefined, ART);
      return fmtOps(r.ops);
    };
    const plain = board();
    const withAge = (age: number): WallBoard =>
      plain.map((c) => ({ ...c, stickies: c.stickies.map((s) => ({ ...s, age })) }));
    expect(draw(withAge(0.15))).not.toEqual(draw(plain)); // mid-swing: the bottom edge has moved
    expect(draw(withAge(1.5))).toEqual(draw(plain)); // settled: hangs still, like any card
    const taken: WallBoard = plain.map((c) => ({
      ...c,
      stickies: c.stickies.map((s) => ({ ...s, taken: true as const })),
    }));
    expect(draw(taken)).not.toEqual(draw(plain));
  });

  it('a slot a card has held keeps its tack hole; a slot none has held stays clean (L5, history)', () => {
    const draw = (w: WallBoard) => {
      const r = recordingCtx();
      drawWalls(r.ctx, fit, env, schedule, w, 3, undefined, ART);
      return fmtOps(r.ops);
    };
    const holeFills = (ops: string[]) =>
      ops.filter((o) => o.includes('rgba(52, 28, 8, 0.75)')).length;
    const full = board();
    // `projectWallBoard` derives `held` from the board (lane 01M50WEBTC); strip it for a cork with no history.
    const emptied: WallBoard = full.map((c) => ({ key: c.key, count: c.count, stickies: [] }));
    // never held: a cork with no history shows no holes at all
    expect(holeFills(draw(emptied))).toBe(0);
    // held 3 slots in the first column and 2 in the second, now empty: five holes
    const held: WallBoard = emptied.map((c, i) =>
      i === 0 ? { ...c, held: 3 } : i === 1 ? { ...c, held: 2 } : c,
    );
    expect(holeFills(draw(held))).toBe(5);
    // a card back on one of those slots covers its hole: held 3, one card hanging -> two holes remain
    const oneBack: WallBoard = held.map((c, i) =>
      i === 0 ? { ...c, stickies: full[0]!.stickies.slice(0, 1) } : c,
    );
    expect(holeFills(draw(oneBack))).toBe(4);
  });

  it('the sign and the board paint only when there is one; the clock hands always do', () => {
    const live = recordingCtx();
    drawWalls(live.ctx, fit, env, schedule, board(), 3, undefined, ART);
    const noFixtures = recordingCtx();
    drawWalls(noFixtures.ctx, fit, env, null, null, 3, undefined, ART);
    expect(live.ops.length).toBeGreaterThan(noFixtures.ops.length); // sign + board are in there
    expect(noFixtures.ops.length).toBeGreaterThan(0); // the clock always hangs
  });

  it('backgroundKey follows the room state and its fade in 32 steps, the daylight, the fit and the dpr — not the hour (plan Task 8)', () => {
    const k = backgroundKey(fit, env, 1);
    expect(backgroundKey(fit, env, 1)).toBe(k);
    // the same day state at another hour is the same key…
    expect(backgroundKey(fit, { ...env, hours: 10 }, 1)).toBe(backgroundKey(fit, { ...env, hours: 14 }, 1));
    // …a fade step is not; and two instants 10 s apart inside a fade share a step
    const a = backgroundKey(fit, { ...env, hours: 16.6 }, 1);
    expect(a).not.toBe(backgroundKey(fit, { ...env, hours: 14 }, 1));
    expect(backgroundKey(fit, { ...env, hours: 16.6 + 10 / 3600 }, 1)).toBe(a);
    // what the shell paints with
    expect(backgroundKey(fit, { ...env, daylight: env.daylight / 2 }, 1)).not.toBe(k);
    expect(backgroundKey({ ...fit, oy: fit.oy + 1 }, env, 1)).not.toBe(k);
    expect(backgroundKey(fit, env, 2)).not.toBe(k);
    // what it does not read: the painted shell's sky wash is gone with it
    expect(backgroundKey(fit, { ...env, skyStrength: env.skyStrength + 0.2 }, 1)).toBe(k);
  });

  it('the wall fixtures set every state they read, so a sprite can start from the 2D defaults', () => {
    const r = recordingCtx();
    drawWalls(r.ctx, fit, env, schedule, board(), 3, undefined, ART);
    expect(readsBeforeWrites(r.ops)).toEqual([]);
  });
});

describe('the Welcome Wagon painters (lane 01M3F81DD9)', () => {
  const fit = fitFloor(1200, 900);
  function recCtx(paints: string[], texts: string[] = []): CanvasRenderingContext2D {
    const grad = { addColorStop: (_s: number, c: string) => void paints.push(c) };
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 1200, height: 900 };
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
          if (prop === 'measureText') return () => ({ width: 0 });
          if (prop === 'fillText') return (s: string) => void texts.push(s);
          return () => undefined;
        },
        set(_t, prop, value) {
          if ((prop === 'fillStyle' || prop === 'strokeStyle') && typeof value === 'string')
            paints.push(value);
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
  }
  const walkingPet = (over: Partial<PetState> = {}): PetState => ({
    lx: 300,
    ly: 300,
    mode: 'walk',
    modeT: 0.4,
    phase: 1.7,
    flip: false,
    path: [
      { lx: 200, ly: 300 },
      { lx: 400, ly: 300 },
    ],
    seg: 0,
    plan: 'sit-then-nap',
    sitFor: 4,
    speed: 55,
    face: 1,
    faceMag: 1,
    depthSign: 1,
    vel: 55,
    cargo: 'none',
    errand: null,
    ...over,
  });
  const paint = (over: Partial<WelcomePaint> = {}): WelcomePaint => ({
    lanyards: new Map(),
    tosses: [],
    hello: new Map(),
    bootBlink: new Map(),
    labels: [],
    ...over,
  });

  it('clips a long name on a nameplate', () => {
    expect(plateText('ada')).toBe('ada');
    expect(plateText('a-very-long-seat-name')).toBe('a-very-lo…');
  });

  it("colours a newcomer's confetti in their colour and mustard; plain confetti keeps its palette", () => {
    expect(confettiColor(0, 'hsl(1, 2%, 3%)')).toBe('hsl(1, 2%, 3%)');
    expect(confettiColor(1, 'hsl(1, 2%, 3%)')).toBe('#E1AD01');
    expect(confettiColor(0)).toBe('#5cd49a');
  });

  it('trails the wagon behind the dog, the way it came', () => {
    const trail = wagonTrail(walkingPet({ cargo: 'wagon' }));
    expect(trail.lx).toBeLessThan(300); // walking +lx, so the wagon is at smaller lx
    expect(Math.abs(trail.ly - 300)).toBeLessThan(1);
  });

  it('draws the wagon only while the dog is hauling it', () => {
    const hauling: string[] = [];
    scene(
      recCtx(hauling),
      fit,
      new Map(),
      new Map(),
      new Map(),
      1,
      'revive',
      undefined,
      walkingPet({ cargo: 'wagon' }),
    );
    expect(hauling).toContain(WAGON_RED);
    const free: string[] = [];
    scene(
      recCtx(free),
      fit,
      new Map(),
      new Map(),
      new Map(),
      1,
      'revive',
      undefined,
      walkingPet(),
    );
    expect(free).not.toContain(WAGON_RED);
  });

  it('paints the lanyard, the label strip, the hello and the blink', () => {
    const member = node('ada', 'working');
    const members = new Map([[member.name, member]]);
    const placements = assignSeats([member]);
    const home = homePoses(placements, members).get('ada')!;
    // Standing and facing the camera, so the lanyard's card is on the visible side of the chest.
    const poses = new Map([['ada', { ...home, dir: 'S' as const, heading: Math.PI / 2, sit: 0 }]]);
    const paints: string[] = [];
    const texts: string[] = [];
    scene(
      recCtx(paints, texts),
      fit,
      placements,
      members,
      poses,
      5,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      {
        welcome: paint({
          lanyards: new Map([['ada', 'hsl(11, 68%, 62%)']]),
          hello: new Map([['ada', 4.8]]),
          bootBlink: new Map([['ada', 4.9]]),
          labels: [{ color: 'hsl(22, 68%, 62%)', t0: 4.5 }],
        }),
      },
    );
    expect(paints).toContain('hsl(11, 68%, 62%)'); // the lanyard
    expect(paints).toContain('hsl(22, 68%, 62%)'); // the label strip
    expect(paints).toContain(BOOT_LED); // the agent's boot blink
    expect(texts).toContain('hello');
  });

  it('draws a lanyard in flight from the front desk, and only while it flies', () => {
    const flying: string[] = [];
    scene(
      recCtx(flying),
      fit,
      new Map(),
      new Map(),
      new Map(),
      2.2,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      {
        welcome: paint({ tosses: [{ name: 'ada', color: 'hsl(44, 68%, 62%)', t0: 2.0 }] }),
      },
    );
    expect(flying).toContain('hsl(44, 68%, 62%)');
    const landed: string[] = [];
    scene(
      recCtx(landed),
      fit,
      new Map(),
      new Map(),
      new Map(),
      3.0,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      {
        welcome: paint({ tosses: [{ name: 'ada', color: 'hsl(44, 68%, 62%)', t0: 2.0 }] }),
      },
    );
    expect(landed).not.toContain('hsl(44, 68%, 62%)');
  });

  it('the receptionist throws on a toss, lifts the receiver on a ring, types on a label', () => {
    const r = (mode: ReceptionistState['mode'], modeT = 0.3): ReceptionistState => ({
      mode,
      modeT,
      aloneT: 0,
      lastSlot: 0,
      beatLen: 5,
    });
    expect(receptionistPose(r('toss')).gesture).toBe(GESTURE.wave);
    expect(receptionistPose(r('ringing'))).toMatchObject({ gesture: GESTURE.call, carry: 'phone' });
    expect(receptionistPose(r('label'))).toMatchObject({ typing: true, carry: null });
    expect(receptionistPose(r('idle')).gesture).toBe(0);
  });

  it('a spent welcome paints nothing of itself', () => {
    const member = node('ada', 'working');
    const members = new Map([[member.name, member]]);
    const placements = assignSeats([member]);
    const paints: string[] = [];
    const texts: string[] = [];
    scene(
      recCtx(paints, texts),
      fit,
      placements,
      members,
      homePoses(placements, members),
      50,
      'revive',
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      {
        welcome: paint({
          hello: new Map([['ada', 1]]),
          bootBlink: new Map([['ada', 1]]),
          labels: [{ color: 'hsl(22, 68%, 62%)', t0: 1 }],
        }),
      },
    );
    expect(texts).not.toContain('hello');
    expect(paints).not.toContain(BOOT_LED);
    expect(paints).not.toContain('hsl(22, 68%, 62%)');
  });
});

describe('furnishedBox (2026-10-01: /live and /broadcast fit the furnished room)', () => {
  it('sits inside the whole scene and keeps the door and the agile board whole', () => {
    const f = furnishedBox();
    expect(f.left).toBeGreaterThan(ROOM_BOX.left);
    expect(f.right).toBeLessThan(ROOM_BOX.right);
    expect(f.top).toBeGreaterThan(ROOM_BOX.top);
    expect(f.bottom).toBeLessThan(ROOM_BOX.bottom);
    const unit = { ox: 0, oy: 0, scale: 1 };
    const doorOuter = project(ENTRANCE.lx - 42, ENTRANCE.ly + 44 + 5, unit);
    const board = boardAnchor(unit);
    expect(f.left).toBeLessThan(doorOuter.x);
    expect(f.right).toBeGreaterThan(board.x + board.w);
  });

  it('a height-bound panel grows; a width-bound one never crops the door', () => {
    const grow = (w: number, h: number) =>
      fitBox(w, h, furnishedBox(), 1).scale / fitBox(w, h, ROOM_BOX).scale;
    const wide = grow(1400, 700); // a laptop /live room panel — height-bound
    expect(wide).toBeGreaterThan(1.07);
    for (const [w, h] of [
      [1459, 1080],
      [390, 500],
      [700, 900],
    ] as const) {
      const fit = fitBox(w, h, furnishedBox(), 1);
      const door = project(ENTRANCE.lx - 42, ENTRANCE.ly + 44 + 5, fit);
      expect(door.x).toBeGreaterThanOrEqual(0);
      const b = boardAnchor(fit);
      expect(b.x + b.w).toBeLessThanOrEqual(w);
    }
    console.log('furnished/room scale', {
      laptop: wide,
      broadcast: grow(1459, 1080),
      phone: grow(390, 500),
    });
  });
});
