import { type Appearance, lookFor } from './appearance';
import type { FigureAssets } from './rendered/assets';
import { drawFigureFrame } from './rendered/figure';
import {
  type Anim,
  type CarryAnim,
  dir8FromDir,
  dir8FromHeading,
  type GestureAnim,
  type SheetSpec,
  type LookAnim,
} from './rendered/figureSheet';
import { project, type Fit, type Pt } from './iso';
import { arcEnv, GESTURE, holdEnv, smooth } from './skeleton';
import type { CarryKind, Dir, OfficeNode, Pose } from './types';

/**
 * The character: which sprite clip a pose is in (`animFor`) and the one draw that puts a composed
 * figure frame on the floor (`drawCharacter`), under the room's light tint, with the wisp over its
 * crown. The skeleton painter that flattened `skeleton.ts` joints onto the canvas went with the painted
 * office (lane 01M5D8EJ40, plan Task 19; `docs/wiki/restoring-the-painted-office.md`).
 */

function disc(ctx: CanvasRenderingContext2D, c: Pt, rx: number, ry: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

export interface CharacterOpts {
  lx: number;
  ly: number;
  dir: Dir;
  /**
   * The figure's sprite sheets (office realism, plan Task 13): the character is a composed frame —
   * `anim`/`animStart` pick it. `tint` is the room's light tint (`figureTintFor`); `topColor` the
   * identity hue.
   */
  rendered: FigureAssets;
  anim?: Anim;
  animStart?: number;
  /** A gesture clip's frame (`animFor`), when the beat rather than the clock picks it. */
  animFrame?: number;
  tint?: string;
  topColor?: string;
  node: OfficeNode;
  /** Continuous facing (radians, logical floor space) — overrides `dir`'s cardinal basis mid-turn. */
  heading?: number;
  /** Uniform size multiplier — nook/queue actors render at 0.72. */
  size: number;
  alpha: number;
  carry: CarryKind | null;
  /** The in-place gesture playing this frame (see `GESTURE`) and its 0→1 window progress. */
  gesture?: number;
  gestureT?: number;
  /** Mug colour while a sip beat plays — drawn in the raised hand, matching the (hidden) desk mug. */
  mug?: string;
  /** Scene clock (s) and the member's seed — the face's own small life: a blink, an LED pulse. */
  t: number;
  seed: number;
  /** How far into a sit (0 standing … 1 seated) — where the rendered figure's crown, and its wisp, are. */
  sit?: number;
  /**
   * Override the wardrobe instead of hashing it from the name.
   *
   * For members the hash is the whole point — a name is all the identity the floor has. The
   * receptionist is the exception: she is a *designed* character, so leaving her look to a hash meant
   * nobody had ever actually looked at the combination it produced (it dealt gold skin under dark red
   * long hair, which closed around her face into one oval and read, fairly, as a seal).
   */
  look?: Appearance;
  /** A first arrival's lanyard, in their colour (lane 01M3F81DD9) — from the toss until they sit. */
  lanyard?: string;
}

/**
 * Which sprite clip a pose is in, and when it started, so `frameRect` can count frames from the
 * scene clock (plan Task 13). The actor state machine is untouched: this reads what it already
 * decided. Walking wins; seated with a typing pulse types, seated otherwise idles; a half-sat pose
 * is the sit-down clip scrubbed by `sit` (rising plays it backwards, which is a stand-up); a
 * standing member with a bubble speaks; everyone else idles. `startT` for the loops is the
 * member's seed, so nineteen idlers are never in phase.
 */
/**
 * Each painter beat's sprite clip (increment 3b): the clip, the posture it was posed in, and how the
 * beat's window picks a frame — `arc`/`hold`/`rise`/`fall` map the beat's own envelope onto an
 * envelope clip (rest → peak), `seq` samples a clip that carries its own motion. `take` is `reach`
 * played back down, so the card's two legs are one clip.
 */
const GESTURE_CLIP: Record<
  number,
  { anim: GestureAnim | LookAnim; seated: boolean; map: 'arc' | 'hold' | 'rise' | 'fall' | 'seq' }
> = {
  [GESTURE.stretch]: { anim: 'g-stretch', seated: true, map: 'arc' },
  [GESTURE.glance]: { anim: 'g-glance', seated: true, map: 'arc' },
  [GESTURE.scratch]: { anim: 'g-scratch', seated: true, map: 'seq' },
  [GESTURE.chin]: { anim: 'g-chin', seated: true, map: 'hold' },
  [GESTURE.lean]: { anim: 'g-lean', seated: true, map: 'hold' },
  [GESTURE.sip]: { anim: 'g-sip', seated: true, map: 'seq' },
  [GESTURE.swivel]: { anim: 'g-swivel', seated: true, map: 'seq' },
  [GESTURE.roll]: { anim: 'g-roll', seated: true, map: 'arc' },
  [GESTURE.settle]: { anim: 'g-settle', seated: true, map: 'hold' },
  [GESTURE.shoulders]: { anim: 'g-shoulders', seated: true, map: 'seq' },
  [GESTURE.behindHead]: { anim: 'g-behindHead', seated: true, map: 'hold' },
  [GESTURE.rubEyes]: { anim: 'g-rubEyes', seated: true, map: 'hold' },
  [GESTURE.pocketPhone]: { anim: 'g-pocketPhone', seated: true, map: 'hold' },
  [GESTURE.eat]: { anim: 'g-eat', seated: true, map: 'seq' },
  [GESTURE.browse]: { anim: 'g-browse', seated: false, map: 'hold' },
  [GESTURE.fill]: { anim: 'g-fill', seated: false, map: 'hold' },
  [GESTURE.pour]: { anim: 'g-pour', seated: false, map: 'hold' },
  [GESTURE.call]: { anim: 'g-call', seated: false, map: 'hold' },
  [GESTURE.wave]: { anim: 'g-wave', seated: false, map: 'seq' },
  [GESTURE.reach]: { anim: 'g-reach', seated: false, map: 'rise' },
  [GESTURE.take]: { anim: 'g-reach', seated: false, map: 'fall' },
  // heads that look (lane 01M5XS5ZYP): held, so the head turns, stays on the speaker, and comes back
  [GESTURE.look45L]: { anim: 'g-look45L', seated: true, map: 'hold' },
  [GESTURE.look45R]: { anim: 'g-look45R', seated: true, map: 'hold' },
  [GESTURE.look90L]: { anim: 'g-look90L', seated: true, map: 'hold' },
  [GESTURE.look90R]: { anim: 'g-look90R', seated: true, map: 'hold' },
};

/**
 * The look clip to blit for a direction: the sheet stores the looks facing east and north and the
 * runtime mirrors south and west from them, and a horizontal flip turns a left look into a right one.
 * So on a mirrored direction the OTHER side's clip is the one whose flipped pixels look the right way.
 */
export function lookClip(anim: Anim, mirrored: boolean): Anim {
  if (!mirrored) return anim;
  if (anim === 'g-look45L') return 'g-look45R';
  if (anim === 'g-look45R') return 'g-look45L';
  if (anim === 'g-look90L') return 'g-look90R';
  if (anim === 'g-look90R') return 'g-look90L';
  return anim;
}

const GESTURE_SEATED: ReadonlySet<Anim> = new Set(
  Object.values(GESTURE_CLIP)
    .filter((c) => c.seated)
    .map((c) => c.anim),
);

/** The frame of a gesture clip at `gestureT`, for a clip of `frames` frames. */
export function gestureFrame(
  map: 'arc' | 'hold' | 'rise' | 'fall' | 'seq',
  gestureT: number,
  frames: number,
): number {
  const g = Math.max(0, Math.min(1, gestureT));
  if (map === 'seq') return Math.min(frames - 1, Math.floor(g * frames));
  const e =
    map === 'arc'
      ? arcEnv(g)
      : map === 'hold'
        ? holdEnv(g)
        : map === 'rise'
          ? smooth(g)
          : 1 - smooth(g);
  return Math.round(Math.max(0, Math.min(1, e)) * (frames - 1));
}

/**
 * How the hands hold what a member carries (plan Task 16) — the painter's carry overlays: both hands at
 * the chest for the box and the plate, the right hand out in front for the card, a mug or a bottle. The
 * laptop rides under the arm and the phone needs no grip of its own, so those keep the plain clips.
 */
function grip(carry: CarryKind | null): 'hold2' | 'hold1' | null {
  if (carry === 'box' || carry === 'movingBox' || carry === 'plate' || carry === 'folder') return 'hold2';
  if (carry === 'card' || carry === 'mug' || carry === 'bottle') return 'hold1';
  return null;
}

/** The carrying variant of the walk or the idle, when the sheet has it (an older one falls back). */
function carrying(
  base: 'walk' | 'idle',
  pose: Pose,
  anims: SheetSpec['anims'],
): 'walk' | 'idle' | CarryAnim {
  const g = grip(pose.carry);
  const call = base === 'walk' && pose.gesture === GESTURE.call;
  const anim = call ? 'walk-call' : g ? (`${base}-${g}` as CarryAnim) : base;
  return anims[anim] ? anim : base;
}

export function animFor(
  pose: Pose,
  typing: number,
  t: number,
  seed: number,
  anims: SheetSpec['anims'],
): { anim: Anim; startT: number; frame?: number } {
  // A beat with a clip of its own plays it — in the posture the clip was posed in. A seated beat on a
  // standing member (or the reverse), or a sheet from before the clip, falls through to the base clip.
  const g = pose.gesture ? GESTURE_CLIP[pose.gesture] : undefined;
  const ga = g ? anims[g.anim] : undefined;
  if (g && ga && !pose.moving && (g.seated ? pose.sit > 0.9 : pose.sit === 0)) {
    return { anim: g.anim, startT: 0, frame: gestureFrame(g.map, pose.gestureT, ga.frames) };
  }
  if (pose.moving) {
    // The walk is scrubbed by the gait PHASE, which the actor system advances by distance (STRIDE
    // floor units per cycle), never by the clock — a clock-driven loop is the skating nick saw.
    const anim = carrying('walk', pose, anims);
    const a = anims[anim]!;
    return { anim, startT: t - pose.phase * (a.frames / a.fps) };
  }
  // A casual seat — couch, stool, meeting chair — has no keyboard: hands in the lap, laptop under the
  // arm (`sit-lap`, office v3-6) and never the typing clip nor the raised hand over it (`sit-hand` is
  // the keyboard arms plus one arm up — spec §2.8); a sheet without it idles (v3-3 shipped the seats
  // first). This outranks the bubble below: a bubbled café sitter keeps the hands down.
  if (pose.sit > 0.9 && pose.casual)
    return { anim: anims['sit-lap'] ? 'sit-lap' : 'sit-idle', startT: seed * 10 };
  // Seated at a desk with something to say: the hand goes up (the painter's help overlay), over the typing.
  if (pose.sit > 0.9 && pose.bubble && anims['sit-hand'])
    return { anim: 'sit-hand', startT: seed * 10 };
  if (pose.sit > 0.9) return { anim: typing > 0 ? 'sit-type' : 'sit-idle', startT: seed * 10 };
  if (pose.sit > 0) {
    const a = anims['sit-down'];
    const duration = a.frames / a.fps;
    return { anim: 'sit-down', startT: t - pose.sit * duration };
  }
  // A held box or mug outranks the talking hand — the speak clip would wave it about.
  if (grip(pose.carry)) return { anim: carrying('idle', pose, anims), startT: seed * 10 };
  if (pose.bubble) return { anim: 'speak', startT: seed * 10 };
  return { anim: 'idle', startT: seed * 10 };
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  fit: Fit,
  o: CharacterOpts,
  armsOnly = false,
): void {
  const { node, dir, size } = o;
  // The rendered path: one composed sprite frame. The seated overlay (armsOnly) draws the same frame's
  // arm cells again, over the desk slab (plan Task 16).
  const look = lookOf(o);
  const dir8 = o.heading !== undefined ? dir8FromHeading(o.heading) : dir8FromDir(dir);
  // A gesture clip covers the directions it is seen in; anywhere else the base clip stands in.
  let anim = lookClip(o.anim ?? 'idle', o.rendered.spec.mirror?.[dir8] !== undefined);
  let frame = o.animFrame;
  const spec = o.rendered.spec.anims[anim];
  if (!spec || (spec.dirs && !spec.dirs.includes(dir8))) {
    anim = anim.startsWith('g-')
      ? o.anim && GESTURE_SEATED.has(o.anim)
        ? 'sit-idle'
        : 'idle'
      : 'idle';
    frame = undefined;
  }
  drawFigureFrame({
    ctx,
    fit,
    at: { lx: o.lx, ly: o.ly },
    sheets: o.rendered.sheets,
    spec: o.rendered.spec,
    look,
    kind: node.kind,
    topColor: o.topColor ?? node.color,
    held: {
      carry: o.carry,
      // the desk mug is in the hand only through the middle of the beat, as the painter has it
      ...(o.mug !== undefined &&
      anim === 'g-sip' &&
      (o.gestureT ?? 0) > 0.12 &&
      (o.gestureT ?? 0) < 0.95
        ? { mug: o.mug }
        : {}),
      ...(o.lanyard !== undefined ? { lanyard: o.lanyard } : {}),
    },
    part: armsOnly ? 'arms' : 'all',
    anim,
    dir: dir8,
    t: o.t,
    startT: o.animStart ?? 0,
    ...(frame !== undefined ? { frame } : {}),
    alpha: o.alpha,
    tint: o.tint ?? '#ffffff',
    size,
    scratch: o.rendered.scratch,
  });
  if (!armsOnly && o.alpha > 0) {
    // The wisp over the sprite's crown — lowered through a sit the way the nameplate is (render.ts).
    const crown = o.rendered.spec.height ?? 96;
    const u = fit.scale * size;
    const p = project(o.lx, o.ly, fit);
    const base = { x: p.x, y: p.y - (crown - 1 - (o.sit ?? 0) * 22 * (crown / 96)) * u };
    const prev = ctx.globalAlpha;
    if (o.alpha < 1) ctx.globalAlpha = Math.max(0, o.alpha);
    drawWisp(
      ctx,
      base,
      { x: base.x, y: base.y - 12 * u },
      u,
      o.topColor ?? node.color,
      o.t,
      o.seed,
    );
    ctx.globalAlpha = prev;
  }
}

/**
 * The wisp: a curved little antenna topped with a warm firefly glow, drawn last so it pokes through any hat.
 * Once the agents' "sign of life" (a straight mast + a green LED); now every member carries one, and it's the
 * quirky-warm counterpart to the floating nameplate above — a mote that hovers over the head, gently
 * drifting and breathing. It also stays the only from-behind tell, so it must read at office scale. `base`
 * is just off the crown and `top` where the stalk would end standing still; both painters call it.
 */
export function drawWisp(
  ctx: CanvasRenderingContext2D,
  base: Pt,
  top: Pt,
  u: number,
  acc: string,
  t: number,
  seed: number,
): void {
  const swayDir = seed % 2 === 0 ? 1 : -1;
  const drift = Math.sin(t * 1.05 + seed * 5) * 1.7 * u; // a firefly's idle wander
  const tx = top.x + drift;
  const ty = top.y - Math.abs(Math.sin(t * 0.9 + seed * 3)) * 1.3 * u; // and a gentle bob
  // A curved stalk in the member's own hue, bowed to one side so it reads as a whimsical antenna, not a
  // mast. The control point is offset sideways from the straight line between crown and tip.
  const cx = (base.x + tx) / 2 + swayDir * 4.6 * u;
  const cy = (base.y + ty) / 2;
  ctx.strokeStyle = acc;
  ctx.lineWidth = 1.7 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.quadraticCurveTo(cx, cy, tx, ty);
  ctx.stroke();
  // The firefly at the tip: two additive warm layers (halo + mid) glowing under a bright near-white core,
  // breathing. Additive so it reads as *light*, not a bead — the warm counterpart to the old green LED.
  const pulse = 0.72 + 0.28 * Math.sin(t * 1.7 + seed * 6);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  disc(ctx, { x: tx, y: ty }, 5.4 * u * pulse, 5.2 * u * pulse, 'rgba(245, 188, 92, 0.5)');
  disc(ctx, { x: tx, y: ty }, 3.0 * u * pulse, 2.9 * u * pulse, 'rgba(255, 214, 130, 0.55)');
  ctx.restore();
  disc(ctx, { x: tx, y: ty }, 1.7 * u, 1.7 * u, 'rgba(255, 248, 228, 0.96)');
}

/** The member's look: their own (the receptionist's is designed), or `lookFor`'s. */
function lookOf(o: CharacterOpts): Appearance {
  return o.look ?? lookFor(o.node);
}
