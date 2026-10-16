/**
 * Dirty-rect repaint for /broadcast (spec docs/superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md,
 * lever 2; lane 01M4VS1SJQ).
 *
 * The room is painted as a sequence of UNITS — each depth item, and each layer around the depth loop
 * (the shell, the wall fixtures, the beams, the night light, the vignette, the cues). A frame is two
 * passes over that same sequence:
 *
 *  1. MEASURE. Every unit replays into a recording context that rasterizes nothing. It keeps two facts
 *     per unit: the device-pixel box it paints, and a hash of what it paints — the context state it
 *     inherits plus every call it makes. Static furniture hashes the same on every frame, so it is
 *     never damage; a member breathing hashes differently every frame, so it always is.
 *  2. PAINT. The damage is the box of every unit whose hash is new this frame, plus the box of every
 *     unit whose hash disappeared. The canvas is clipped to those rects, they are cleared, and the
 *     sequence runs again with the units that cannot touch them skipped.
 *
 * Nothing here knows what a desk or a member is: a change is whatever changes the calls. A palette
 * flip, a lighting step or a sprite rebuilt all change the hash, so none of them needs its own trigger.
 *
 * Two rules keep a partial frame byte-identical to a full one:
 *  - a unit is skipped only when it is NEUTRAL — it leaves the context state exactly as it found it —
 *    so every unit that does run inherits the same state it had in the measure pass. A unit that
 *    leaks state still runs, and the clip keeps its pixels out;
 *  - the clip rects are whole device pixels under the identity transform, so inside them the draws
 *    land on the same grid with the same coverage as an unclipped frame.
 */

/** Device-pixel box, integer, half-open: `[x0, x1) × [y0, y1)`. */
export interface DeviceRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One measured unit: what it paints (`key`) and where (`rect`, null when it paints nothing). */
export interface Unit {
  key: number;
  rect: DeviceRect | null;
  /** True when the unit leaves the context state as it found it, so the paint pass may skip it. */
  neutral: boolean;
  /** It painted with a path it inherited, so the unit before it must have run (see `mustRun`). */
  consumesPath?: boolean;
  /** It ended with a path still open — which only matters to a next unit that consumes it. */
  leavesPath?: boolean;
}

/** How the room passes each unit of its paint sequence through the caller (`renderScene` opts). */
export interface UnitHook {
  run: (draw: () => void) => void;
}

export type RepaintPlan =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'rects'; rects: DeviceRect[]; area: number };

/** Device px added around every unit's measured box: antialiasing, plus the rounding of the estimate. */
export const DAMAGE_PAD = 4;
/** Above this many rects after merging, merge the closest pairs until it holds. */
export const MAX_RECTS = 16;
/** Above this share of the canvas, a full repaint is cheaper than clipping to that many rects. */
export const MAX_DAMAGE_FRACTION = 0.5;

// ── hashing ─────────────────────────────────────────────────────────────────────────────────────────

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** One FNV-1a pass over a string. Strings repeat all frame long (colours, fonts, composite modes), so
 *  each is hashed once and remembered; the cache is bounded by resetting it when it grows past use. */
const strHashes = new Map<string, number>();
function strHash(s: string): number {
  let v = strHashes.get(s);
  if (v === undefined) {
    v = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) v = Math.imul(v ^ s.charCodeAt(i), 0x01000193) >>> 0;
    if (strHashes.size > 20000) strHashes.clear();
    strHashes.set(s, v);
  }
  return v;
}

/** Two independent 32-bit multiply-xor streams, folded into one safe integer at the end — a 53-bit
 *  key, so two different units colliding on a frame is not a thing a 30 fps stream will see. */
class Hasher {
  a = 0x811c9dc5;
  b = 0x01000193;
  word(w: number): void {
    this.a = Math.imul(this.a ^ w, 0x01000193) >>> 0;
    this.b = Math.imul(this.b ^ w, 0x85ebca6b) >>> 0;
  }
  num(n: number): void {
    f64[0] = n;
    this.word(u32[0]!);
    this.word(u32[1]!);
  }
  str(s: string): void {
    this.word(strHash(s));
  }
  key(): number {
    return this.a * 0x200000 + (this.b & 0x1fffff);
  }
}

// ── the recording context ───────────────────────────────────────────────────────────────────────────

type M = [number, number, number, number, number, number];

/** The 2D context state a draw can inherit, in a fixed order, with the HTML spec defaults. */
const STATE_KEYS = [
  'globalAlpha',
  'globalCompositeOperation',
  'fillStyle',
  'strokeStyle',
  'lineWidth',
  'lineCap',
  'lineJoin',
  'miterLimit',
  'lineDashOffset',
  'font',
  'textAlign',
  'textBaseline',
  'direction',
  'letterSpacing',
  'shadowBlur',
  'shadowColor',
  'shadowOffsetX',
  'shadowOffsetY',
  'filter',
  'imageSmoothingEnabled',
  'imageSmoothingQuality',
] as const;
type StateKey = (typeof STATE_KEYS)[number];
const DEFAULTS: unknown[] = [
  1,
  'source-over',
  '#000000',
  '#000000',
  1,
  'butt',
  'miter',
  10,
  0,
  '10px sans-serif',
  'start',
  'alphabetic',
  'inherit',
  '0px',
  0,
  'rgba(0, 0, 0, 0)',
  0,
  0,
  'none',
  true,
  'low',
];
const SLOT: Record<StateKey, number> = Object.fromEntries(
  STATE_KEYS.map((k, i) => [k, i]),
) as Record<StateKey, number>;
const I_LINE_WIDTH = SLOT.lineWidth;
const I_LINE_JOIN = SLOT.lineJoin;
const I_LINE_CAP = SLOT.lineCap;
const I_MITER = SLOT.miterLimit;
const I_FONT = SLOT.font;

interface State {
  v: unknown[];
  m: M;
  dash: number[];
  /** Hash of the clip paths in force (0 = none). */
  clip: number;
}

/** A gradient or pattern the recorder handed out: its content hash grows as stops are added. */
interface Paint {
  h: Hasher;
}

export interface Recorder {
  /** The context to hand to the painter during the measure pass. Rasterizes nothing. */
  ctx: CanvasRenderingContext2D;
  /** Start a frame: the state the real context is in when the room starts painting. */
  reset: (m: M) => void;
  begin: () => void;
  end: () => Unit;
}

/** Op codes: a method's identity in the hash is a number, not its name. */
let nextOp = 1;
const OP: Record<string, number> = {};
const op = (name: string): number => (OP[name] ??= nextOp++ * 0x9e3779b1);

/**
 * The measure-pass context: a plain object with the methods and properties the room uses, no Proxy,
 * because it replays every call the room makes every frame. `measureText` must agree with the real
 * canvas — a monitor's ellipsis or a pill's width depends on it, so an estimate would measure
 * different calls than the paint pass makes — so it is answered by `measure`, a real 2D context, in
 * the font the painter set.
 */
export function makeRecorder(opts: {
  width: number;
  height: number;
  measure?: (font: string, text: string) => number;
  pad?: number;
}): Recorder {
  const pad = opts.pad ?? DAMAGE_PAD;
  const measure =
    opts.measure ?? ((font: string, text: string) => 0.6 * fontPx(font) * text.length);
  let st: State = fresh([1, 0, 0, 1, 0, 0]);
  let stack: State[] = [];
  const paints = new WeakMap<object, Paint>();
  const images = new WeakMap<object, number>();
  let nextImage = 1;

  // The current unit.
  let h = new Hasher();
  let startState = 0;
  let startDepth = 0;
  let ux0 = Infinity;
  let uy0 = Infinity;
  let ux1 = -Infinity;
  let uy1 = -Infinity;
  /* The current path is context state that save/restore does not cover: a unit can leave one behind
     and the next unit can fill it. So it is hashed (`path`, over the path calls since the last
     beginPath) and counted (`pathLen`), and a unit that paints with an inherited path says so. */
  let path = new Hasher();
  let pathLen = 0;
  let touched = false;
  let consumed = false;
  // The current path's device extent; added to the unit only when the path is painted.
  let px0 = Infinity;
  let py0 = Infinity;
  let px1 = -Infinity;
  let py1 = -Infinity;

  function fresh(m: M): State {
    return { v: [...DEFAULTS], m, dash: [], clip: 0 };
  }
  function clone(s: State): State {
    return { v: [...s.v], m: s.m, dash: s.dash, clip: s.clip };
  }
  function valueHash(x: Hasher, v: unknown): void {
    if (typeof v === 'number') x.num(v);
    else if (typeof v === 'string') x.str(v);
    else if (typeof v === 'boolean') x.word(v ? 1 : 2);
    else if (v === null || v === undefined) x.word(3);
    else if (Array.isArray(v)) {
      x.word(v.length);
      for (const e of v) valueHash(x, e);
    } else if (typeof v === 'object') {
      const p = paints.get(v);
      if (p) {
        x.word(4);
        x.word(p.h.a);
        x.word(p.h.b);
        return;
      }
      let id = images.get(v);
      if (id === undefined) {
        id = nextImage++;
        images.set(v, id);
      }
      x.word(5);
      x.word(id);
    } else x.word(6);
  }
  function stateHash(s: State, depth: number): number {
    const x = new Hasher();
    for (const v of s.v) valueHash(x, v);
    for (const n of s.m) x.num(n);
    valueHash(x, s.dash);
    x.word(s.clip);
    x.word(depth);
    return x.key();
  }
  /** Every call goes in the unit's hash: its op code and its arguments. */
  function call(code: number, a: ArrayLike<unknown>): void {
    h.word(code);
    for (let i = 0; i < a.length; i++) valueHash(h, a[i]);
  }
  /** A call that reads or extends the current path. */
  function pathCall(code: number, a: ArrayLike<unknown>, extends_: boolean): void {
    if (!touched) {
      touched = true;
      consumed = pathLen > 0;
      // What it paints then depends on the path it inherited — and only then.
      if (consumed) {
        h.word(path.a);
        h.word(path.b);
      }
    }
    if (!extends_) return;
    // In device space: the same call under a different transform is a different path.
    path.word(code);
    for (let i = 0; i < a.length; i++) valueHash(path, a[i]);
    for (const n of st.m) path.num(n);
    pathLen++;
  }
  function pt(x: number, y: number): void {
    const m = st.m;
    const dx = m[0] * x + m[2] * y + m[4];
    const dy = m[1] * x + m[3] * y + m[5];
    if (dx < px0) px0 = dx;
    if (dx > px1) px1 = dx;
    if (dy < py0) py0 = dy;
    if (dy > py1) py1 = dy;
  }
  function box(x: number, y: number, w: number, hh: number): void {
    pt(x, y);
    pt(x + w, y);
    pt(x, y + hh);
    pt(x + w, y + hh);
  }
  function clearPath(): void {
    path = new Hasher();
    pathLen = 0;
    px0 = Infinity;
    py0 = Infinity;
    px1 = -Infinity;
    py1 = -Infinity;
  }
  function scaleOf(m: M): number {
    return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
  }
  /** Fold the pending path into the unit's box, grown by `grow` device px. */
  function paintPath(grow: number): void {
    if (px0 === Infinity) return;
    if (px0 - grow < ux0) ux0 = px0 - grow;
    if (py0 - grow < uy0) uy0 = py0 - grow;
    if (px1 + grow > ux1) ux1 = px1 + grow;
    if (py1 + grow > uy1) uy1 = py1 + grow;
  }
  function strokeGrow(): number {
    const lw = Number(st.v[I_LINE_WIDTH]) || 0;
    const join = st.v[I_LINE_JOIN] === 'miter' ? Number(st.v[I_MITER]) || 10 : 1;
    const cap = st.v[I_LINE_CAP] === 'square' ? Math.SQRT2 : 1;
    return (lw / 2) * Math.max(join, cap) * scaleOf(st.m);
  }
  /** A rect, text or image painted straight away: through the path box, leaving the pending path. */
  function paintBox(x: number, y: number, w: number, hh: number, grow: number): void {
    const s0 = px0;
    const s1 = py0;
    const s2 = px1;
    const s3 = py1;
    px0 = Infinity;
    py0 = Infinity;
    px1 = -Infinity;
    py1 = -Infinity;
    box(x, y, w, hh);
    paintPath(grow);
    px0 = s0;
    py0 = s1;
    px1 = s2;
    py1 = s3;
  }
  function text(s: unknown, x: number, y: number, grow: number): void {
    const str = String(s);
    const font = String(st.v[I_FONT]);
    const w = measure(font, str);
    const em = fontPx(font);
    // Any textAlign/baseline: both sides of the anchor, ascent and descent — an over-estimate is a
    // slightly larger rect, an under-estimate is a stale glyph.
    paintBox(x - w, y - em * 1.2, 2 * w, em * 2.4, grow);
  }
  const mul = (m: M, n: M): M => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const STOP = op('addColorStop');
  function makePaint(kind: string, args: ArrayLike<unknown>): object {
    const p: Paint = { h: new Hasher() };
    p.h.str(kind);
    for (let i = 0; i < args.length; i++) valueHash(p.h, args[i]);
    const obj = {
      addColorStop(o: number, c: string): void {
        p.h.num(o);
        p.h.str(c);
        h.word(STOP);
        h.num(o);
        h.str(c);
      },
      setTransform(): void {},
    };
    paints.set(obj, p);
    return obj;
  }

  const canvas = { width: opts.width, height: opts.height };
  const ctx: Record<string, unknown> = { canvas };
  type Args = number[];
  /*
   * The context calls the room uses, one line each: what the call does to the state or the unit's
   * box. `def` adds the bookkeeping every call shares — its op code and arguments go in the unit's
   * hash, and a call that builds (PATH) or paints with (USE) the current path goes in the path's.
   * Written as a table, not 35 hand-rolled methods, because every byte of it ships (ADR 151).
   */
  const PATH = 1;
  const USE = 2;
  const def = (name: string, flags: number, fn: (...a: Args) => unknown): void => {
    const code = op(name);
    ctx[name] = function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params -- no array per call on the hot path
      const a = arguments as unknown as Args;
      call(code, a);
      if (flags) pathCall(code, a, flags === PATH);
      return Reflect.apply(fn, null, a);
    };
  };
  const tf = (n: M): void => {
    st.m = mul(st.m, n);
  };
  def('save', 0, () => stack.push(clone(st)));
  def('restore', 0, () => {
    st = stack.pop() ?? st;
  });
  def('translate', 0, (x, y) => tf([1, 0, 0, 1, x!, y!]));
  def('scale', 0, (x, y) => tf([x!, 0, 0, y!, 0, 0]));
  def('rotate', 0, (r) => tf([Math.cos(r!), Math.sin(r!), -Math.sin(r!), Math.cos(r!), 0, 0]));
  def('transform', 0, (a, b, c, d, e, f) => tf([a!, b!, c!, d!, e!, f!]));
  def('setTransform', 0, (...a) => {
    const o = a[0] as unknown as DOMMatrix2DInit | number;
    st.m =
      typeof o === 'object' ? [o.a ?? 1, o.b ?? 0, o.c ?? 0, o.d ?? 1, o.e ?? 0, o.f ?? 0] : (a.slice(0, 6) as M);
  });
  def('resetTransform', 0, () => {
    st.m = [1, 0, 0, 1, 0, 0];
  });
  def('setLineDash', 0, (...d) => {
    st.dash = [...((d[0] as unknown as number[]) ?? [])];
  });
  def('beginPath', 0, () => {
    touched = true;
    clearPath();
  });
  def('moveTo', PATH, pt);
  def('lineTo', PATH, pt);
  def('closePath', PATH, () => {});
  def('bezierCurveTo', PATH, (a, b, c, d, e, f) => {
    pt(a!, b!);
    pt(c!, d!);
    pt(e!, f!);
  });
  def('quadraticCurveTo', PATH, (a, b, c, d) => {
    pt(a!, b!);
    pt(c!, d!);
  });
  def('arc', PATH, (x, y, r) => box(x! - r!, y! - r!, 2 * r!, 2 * r!));
  def('arcTo', PATH, (a, b, c, d, r) => {
    box(a! - r!, b! - r!, 2 * r!, 2 * r!);
    box(c! - r!, d! - r!, 2 * r!, 2 * r!);
  });
  def('ellipse', PATH, (x, y, rx, ry) => {
    const r = Math.max(Math.abs(rx!), Math.abs(ry!));
    box(x! - r, y! - r, 2 * r, 2 * r);
  });
  def('rect', PATH, box as (...a: Args) => void);
  def('roundRect', PATH, box as (...a: Args) => void);
  def('fill', USE, () => paintPath(0));
  def('stroke', USE, () => paintPath(strokeGrow()));
  def('clip', USE, () => {
    const x = new Hasher();
    x.word(st.clip);
    x.num(px0);
    x.num(py0);
    x.num(px1);
    x.num(py1);
    st.clip = x.a;
  });
  def('fillRect', 0, (x, y, w, hh) => paintBox(x!, y!, w!, hh!, 0));
  def('strokeRect', 0, (x, y, w, hh) => paintBox(x!, y!, w!, hh!, strokeGrow()));
  def('clearRect', 0, (x, y, w, hh) => paintBox(x!, y!, w!, hh!, 0));
  def('fillText', 0, (s, x, y) => text(s, x!, y!, 0));
  def('strokeText', 0, (s, x, y) => text(s, x!, y!, strokeGrow()));
  def('drawImage', 0, (...a) => {
    const img = a[0] as unknown as { width?: number; height?: number };
    if (a.length >= 9) paintBox(a[5]!, a[6]!, a[7]!, a[8]!, 0);
    else if (a.length >= 5) paintBox(a[1]!, a[2]!, a[3]!, a[4]!, 0);
    else paintBox(a[1]!, a[2]!, Number(img.width) || 0, Number(img.height) || 0, 0);
  });
  for (const kind of ['Linear', 'Radial', 'Conic']) def(`create${kind}Gradient`, 0, (...a) => makePaint(kind, a));
  def('createPattern', 0, (...a) => makePaint('pattern', a));
  ctx.getTransform = () => ({ a: st.m[0], b: st.m[1], c: st.m[2], d: st.m[3], e: st.m[4], f: st.m[5] });
  ctx.getLineDash = () => [...st.dash];
  ctx.isPointInPath = () => false;
  ctx.measureText = (s: string) => ({ width: measure(String(st.v[I_FONT]), String(s)) });
  for (const [i, k] of STATE_KEYS.entries()) {
    const code = op(k);
    Object.defineProperty(ctx, k, {
      get: () => st.v[i],
      set: (v: unknown) => {
        st.v[i] = v;
        h.word(code);
        valueHash(h, v);
      },
    });
  }

  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    reset(m) {
      st = fresh(m);
      stack = [];
      clearPath(); // the paint pass opens each frame with beginPath to match
    },
    begin() {
      h = new Hasher();
      startDepth = stack.length;
      startState = stateHash(st, startDepth);
      h.num(startState);
      touched = false;
      consumed = false;
      ux0 = Infinity;
      uy0 = Infinity;
      ux1 = -Infinity;
      uy1 = -Infinity;
    },
    end() {
      // Neutral = the units after this one inherit the same state whether or not it ran: the same
      // props, transform, dash and clip at the same save depth.
      const neutral = stack.length === startDepth && stateHash(st, stack.length) === startState;
      let rect: DeviceRect | null = null;
      if (ux0 !== Infinity) {
        rect = clamp(
          {
            x0: Math.floor(ux0) - pad,
            y0: Math.floor(uy0) - pad,
            x1: Math.ceil(ux1) + pad,
            y1: Math.ceil(uy1) + pad,
          },
          opts.width,
          opts.height,
        );
      }
      return { key: h.key(), rect, neutral, consumesPath: consumed, leavesPath: pathLen > 0 };
    },
  };
}

function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 10;
}

// ── rect arithmetic ─────────────────────────────────────────────────────────────────────────────────

function clamp(r: DeviceRect, w: number, h: number): DeviceRect | null {
  const out = {
    x0: Math.max(0, r.x0),
    y0: Math.max(0, r.y0),
    x1: Math.min(w, r.x1),
    y1: Math.min(h, r.y1),
  };
  return out.x1 > out.x0 && out.y1 > out.y0 ? out : null;
}

export function area(r: DeviceRect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

function union(a: DeviceRect, b: DeviceRect): DeviceRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function intersects(a: DeviceRect, b: DeviceRect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Merge damage into a small set: overlapping (or touching) rects always fold together, so no pixel is
 * cleared twice; past `max`, the pair whose union adds the least area folds next.
 */
export function mergeRects(input: readonly DeviceRect[], max = MAX_RECTS): DeviceRect[] {
  const rs = [...input];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rs.length && !changed; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]!;
        const b = rs[j]!;
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          rs[i] = union(a, b);
          rs.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  while (rs.length > max) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const grow = area(union(rs[i]!, rs[j]!)) - area(rs[i]!) - area(rs[j]!);
        if (grow < best) {
          best = grow;
          bi = i;
          bj = j;
        }
      }
    }
    rs[bi] = union(rs[bi]!, rs[bj]!);
    rs.splice(bj, 1);
    // A fold can make a new overlap; fold those too so the set stays disjoint.
    return mergeRects(rs, max);
  }
  return rs;
}

/**
 * What changed between two measured frames. A unit is matched by its key (what it paints, where): a
 * key on both sides is unchanged; a key only now is new paint, and a key only before is paint that
 * has to be covered up. `prev === null` (first frame, after a resting blit, a resize) is a full repaint.
 */
export function planRepaint(
  prev: readonly Unit[] | null,
  curr: readonly Unit[],
  width: number,
  height: number,
  opts: { maxRects?: number; maxFraction?: number } = {},
): RepaintPlan {
  if (!prev) return { kind: 'full' };
  // A unit that paints with the path the unit before it left open needs that unit to have run, which
  // the skip rule does not promise. None of the room's units does; if one ever does, paint whole.
  if (curr.some((u) => u.consumesPath)) return { kind: 'full' };
  const before = new Map<number, DeviceRect[]>();
  for (const u of prev) {
    if (!u.rect) continue;
    const list = before.get(u.key);
    if (list) list.push(u.rect);
    else before.set(u.key, [u.rect]);
  }
  const damage: DeviceRect[] = [];
  for (const u of curr) {
    if (!u.rect) continue;
    const list = before.get(u.key);
    if (list && list.length) list.pop();
    else damage.push(u.rect);
  }
  for (const list of before.values()) damage.push(...list);
  if (!damage.length) return { kind: 'none' };
  const rects = mergeRects(damage, opts.maxRects ?? MAX_RECTS);
  const total = rects.reduce((n, r) => n + area(r), 0);
  if (total > (opts.maxFraction ?? MAX_DAMAGE_FRACTION) * width * height) return { kind: 'full' };
  return { kind: 'rects', rects, area: total };
}

/** The paint pass's filter: run a unit when it can touch a rect, or when skipping it would change the
 *  state the units after it inherit. */
export function mustRun(u: Unit | undefined, rects: readonly DeviceRect[]): boolean {
  if (!u) return true;
  if (!u.neutral) return true;
  if (!u.rect) return false;
  for (const r of rects) if (intersects(u.rect, r)) return true;
  return false;
}
