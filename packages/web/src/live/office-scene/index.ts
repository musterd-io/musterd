import type { Posture } from '@musterd/protocol';
import { preloadCanvasFont } from '../canvasFont';
import { pulseIntensity, pulseLive, type SeatPulse } from '../pulse';
import { roomTone, screenPan, type LifeContext } from '../sound';
import { displayModel } from '../modelBadge';
import { modelProvider } from '../modelProvider';
import { HUMAN_GLYPH_SVG, providerIconHtml } from '../modelProviderIcon';
import { occupation } from '../occupation';
import { identityMeta, plateDetailParts, shortLaneState, shortWorkTitle } from '../presenceLabel';
import { musterdChipSvg } from '../../brand/chipMark';
import { memberColor, memberInk } from '../format';
import { platesOpenMode, stillMode } from '../stillMode';
import { surfaceGlyph } from '../surfaceGlyph';
import { createActors, type Actors } from './actors';
import { solidHit, walkable } from './nav';
import {
  plateCoversBoard, layoutPlates, leaderFrom, type PlateBox, type PlateMemo } from './plateLayout';
import { helpWalks } from './mapping';
import { REPLAY_TEMPO, replayAge } from './replay';
import { stepDomAnimations } from './domCadence';
import {
  ambientFrameBudgetMs,
  coalesceStep,
  DEFAULT_CAPTURE_FPS,
  officeDpr,
  officeVisible,
  shouldCoalesceDraw,
  suspendIgnored,
} from './broadcast';
import { AMBIENT_SLOT_MS, ambientPool, decideAmbient, roll, slotAt, slotRng, type AmbientDecision } from './ambientSeed';
import { walkTag } from '../headline';
import {
  createPet,
  petBeat,
  petBeg,
  petFollow,
  petGreet,
  petNotice,
  petWagon,
  petZoomies,
  stepPet,
} from './pet';
import { createReceptionist, receptionistCue, stepReceptionist } from './receptionist';
import { CORNER_CAMERA, fitBox, project, roomBox, type Camera, type Fit, type Pt } from './iso';
import {
  CHAIR_OFF,
  COFFEE_STAND,
  COOLER_STAND,
  DESK_SLOTS,
  ENTRANCE,
  FWD,
  LEISURE_SPOTS,
  RECEPTIONIST,
  SEAT_BACK,
  WAGON_PICKUP,
} from './layout';
import { computeLightEnv, type LightEnv } from './lighting';
import { isWithinWorkingHours } from './workingHours';
import { assignSeats, workingAtDesk, type Placement } from './seating';
import {
  captionForPresence,
  pushCaption,
  tickCaption,
  CAPTION_HOLD_MS,
  type Caption,
  type CaptionRail,
} from '../captions';
import { createWelcome, stepWelcome } from './welcome';
import { createWelcomeRoom, type WelcomeSoundAt } from './welcomeRoom';
import {
  animatedDeskAnchors,
  boardAnchor,
  hoursAnchor,
  furnishedBox,
  coffeeAnchor,
  DARK_PALETTE,
  deskHasProp,
  drawCue,
  magicAnchors,
  renderScene,
  setScenePalette,
  toneColor,
  type Cue,
  type RenderOpts,
  type ScenePalette,
} from './render';
import {
  makeRecorder,
  mustRun,
  planRepaint,
  type Recorder,
  type RepaintPlan,
  type Unit,
  type UnitHook,
} from './damage';
import { loadFigureAssets, loadRenderedAssets, parseFigureSpec, renderedOfficeFromSearch, type RenderedAssets } from './rendered/assets';
import { cameraMatches, parseManifest } from './rendered/manifest';
import { makeSpriteCache, resetCtxState } from './sprite-cache';
import { GESTURE, isIdleGesture } from './skeleton';
import { createLaneOwners } from './laneOwners';
import { laneSeed, WALL_COLUMNS, withPinned, withTaken, type PinnedCard, type WallBoard } from './wallboard';
import {
  enqueueSpeech,
  shapeSpeech,
  bubbleShiftOffBoard,
  bubbleShiftIntoView,
  speechHoldMs,
  speechLength,
  speechTokens,
  SPEECH_MARK_GLYPH,
  typeCadence,
  type Addressee,
  type SpeechMarking,
  type SpeechToken,
} from './speech';
import type {
  DirtyParity,
  OfficeAsk,
  AmbientLogEntry,
  OfficeData,
  OfficeEvent,
  OfficeHandle,
  OfficeNode,
  Pose,
  SpriteParity,
} from './types';

export type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode, OfficeStats } from './types';

const DPR_CAP = 2;

/**
 * The synthetic head the receptionist's bubble hangs from, and the key `showSpeech` recognises as
 * "this is the house voice, not a seat".
 *
 * A bare string literal in three places was one typo away from a bubble that renders as an ordinary
 * member — and the failure would be silent, because `heads.get(who)` simply returns undefined and
 * `showSpeech` drops the line. She is deliberately NOT in the node map (staff, not roster —
 * receptionist.ts), so no name collision with a real seat is possible: a member called
 * `receptionist` could not be seated, since the room's own front desk is not a desk in `DESK_SLOTS`.
 */
const RECEPTIONIST_SPEAKER = 'receptionist';
const CUE_SECS = 1.5;

/** Posture → the name label's dot modifier. One green: only `working` earns it. */
const DOT_STATE: Record<Posture, 'on' | 'idle' | 'away' | 'off'> = {
  working: 'on',
  active: 'idle', // the dot's visual state keeps its CSS name; the wire token is `active`
  away: 'away',
  offline: 'off',
};
// Speech-bubble lifecycle: the hold, the queue policy and their constants live in `speech.ts`
// (`speechHoldMs` / `enqueueSpeech`) so they can be tested — this module runs the DOM half.
const SPEECH_OUT_MS = 560;

/** How far above the head anchor the bubble sits (clears the name label). */
const SPEECH_LIFT = 26;
/** What an expanded bubble keeps clear of the stage's top edge: the asks bar laid over it (~36px
 *  tall at 10px from the top) plus a breath. */
const SPEECH_TOP_CLEAR = 52;
/** An expanded bubble never shrinks below its glance (about three lines) to honour that clearance. */
const SPEECH_MIN_H = 64;
/** The bubble's widest (`.lc-speech__inner` max-width in Live.css); below it no edge check is needed. */
const SPEECH_MAX_W = 260;
/** After a real act, keep the loop alive this long so the Rive character settles into idle rather than
 * freezing mid-gesture (ADR 086 #5 afterglow) — a brief, bounded post-act tail, not a continuous loop. */
const AFTERGLOW_MS = 2600;
/** Ambient micro-choreography (ADR 086 Phase 2, seeded by E1): when the room is quiet, inject one idle
 * beat (a seated micro-gesture — scratch, sip, swivel… — or a stroll), drawn per 10s wall-clock slot so
 * every viewer of the same team sees the same beats. How OFTEN is `ambientSeed.ambientFireP`, which
 * scales with how many people are in the room (E1b): a populated floor reads at ~2.5–3 beats/idle-min,
 * a room of two stays near the old ~30–70s cadence so a near-empty office does not read as twitchy.
 * Timer-based (not RAF), one beat at a time (plus, in a room of six or more, one in-place companion
 * gesture inside the same wake — ADR 617), always preempted by a real act. 90–180s read as a frozen
 * room once the beat variety grew (nick's call, 2026-07); the old 15–25s water-cooler parade is still
 * the floor to stay well above. */
/** While Tier B is awake for an *ambient-only* beat, coalesce toward ~20fps: only advance+redraw once
 * this much wall time has built up. A coffee stroll is visually identical at 20fps and ~3× cheaper; real
 * acts keep 60fps because their motion is not `ambientOnly`. */
const AMBIENT_FRAME_MS = 50;

/**
 * THE DRIFT TIER (nick, 2026-09-14). A parked room is a still photograph — correct, cheap, and the
 * reason it never looked alive between beats. This wakes it just enough for the idle sway, at 4fps.
 *
 * MEASURED before it was built, on /office-preview (12 desks), headless, 30s windows, main-thread
 * busy time via CDP Performance.getMetrics, as a delta over a genuinely parked room (4.26/4.47% of
 * one core):
 *
 *   2fps  +1.4   ·   4fps  +2.1..2.6   ·   6fps  +3.2   ·   12fps  +4.4   ·   20fps (ambient) +8.9
 *
 * 4 because 2 reads as a slideshow for a sway and 6 buys smoothness nobody can see. The cost lands in
 * the same order as the "~2% of one core" already recorded in packages/web/AGENTS.md for the ambient
 * cap, which the team accepted as a product call.
 *
 * A TIMER, NOT THE RAF COALESCER, and that is the spike's other finding rather than a style choice.
 * Every coalesced measurement showed ~1800 ticks in 30s — rAF keeps firing at 60Hz and early-returns,
 * so about a third of the 4fps cost was wasted wakeups. Fitting the four points: ~0.35pt per draw/s
 * of real drawing, ~0.8pt of pure loop overhead. A timer skips ~56 pointless wakes a second.
 *
 * It does NOT touch the loop's park predicate: the loop still parks exactly when it always did, and
 * this is a separate, slower heartbeat that only runs WHILE it is parked. The AGENTS.md rule is
 * "stop when UNSEEN" — a hidden tab, a collapsed panel — and those still park dead, below.
 */
const DRIFT_FRAME_MS = 250;

/** How often the office re-reads the PST clock so the lighting tracks the real sun (the sun moves slowly —
 * once a minute is plenty, and a rebake only happens when the veil/lamp state actually crosses a step). */
const LIGHT_TICK_MS = 60000;
/** Dirty-rect repaint's safety net: a whole frame at least this often, so anything a measurement
 *  missed heals within seconds instead of leaving a ghost on the stream (smooth-capture spec, lever 2). */
const SAFETY_REPAINT_MS = 5000;

/**
 * The `?light=HH` / `?light=HH:MM` dev override, if present — a dev aid for previewing dawn/dusk/night
 * without waiting for the wall clock (harmless in prod — it only applies when explicitly present). The
 * shift check rides the same override (keeping the real weekday), so `?light=23` also previews the
 * after-hours office.
 */
function lightOverrideHours(): number | null {
  try {
    const q = new URLSearchParams(window.location.search).get('light');
    const m = q && /^(\d{1,2})(?::(\d{2}))?$/.exec(q.trim());
    if (m) return (Number(m[1]) % 24) + (m[2] ? Number(m[2]) / 60 : 0);
  } catch {
    /* no window/search available — the real clock rules */
  }
  return null;
}

/** Current hour-of-day (0..24) in America/Los_Angeles — the office clock the lighting follows. */
function pstNowHours(): number {
  const override = lightOverrideHours();
  if (override !== null) return override;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hh % 24) + mm / 60;
}

/**
 * `?still` — MEASUREMENT MODE. Two things in this file answer to it, and they are different sizes.
 *
 * THE BUBBLE HOLD. A speech bubble dismisses itself after `SPEECH_HOLD_MS + 22ms/char` (capped at
 * 6–9s). That is right for a reader and fatal for a measurement: the a11y contrast sweep settles,
 * freezes rAF and shoots one screenshot, and that window straddles the dismiss countdown — so the
 * same commit measures a different room run to run, and a bubble caught mid-fade is sampled over
 * whatever scene paint is behind it rather than over its own paper. Measured 2026-08-17:
 * /office-preview flipped red about 1 run in 3, always an `lc-speech__text` row, on #3b5854 /
 * #2d4245 / #724b29 — three different bits of furniture, one bubble.
 *
 * THE AMBIENT HOLD (added 2026-08-19, ADR 285). The idle-beat scheduler injects a stroll or a
 * micro-gesture every 30–70s, forever. It already stands down under reduced motion — but
 * /office-preview mounts this scene with `reduced: false` hardcoded, so on the route the contrast
 * gate leans on hardest it keeps running: an identity-keeping motion probe watched a room sit
 * perfectly still for 115 seconds and then start walking again at 137s. One re-arming timer is
 * enough to make a page that never settles, and the sweep then reports MEASURED MID-FLIGHT on every
 * run — a true signal that decays into noise precisely because it is always on.
 *
 * The room still paints what it would otherwise paint: nothing is hidden, nothing is repositioned,
 * and the script's own walks are untouched (they drain in ~22s, and they are the subject). What
 * stops is the room MOVING ON of its own accord. Inert unless explicitly present, like `?light=HH`.
 *
 * The flag itself is read by `../stillMode`, shared with the overlay reel and the asks-strip so the
 * four consumers cannot drift apart on what `?still` means.
 */

/** An in-flight speech bubble over a member's head — its DOM root plus the timers/frames to cancel when
 * the office is disposed (or the member leaves the floor mid-sentence). */
interface Speech {
  outer: HTMLDivElement;
  cancels: Array<() => void>;
  /** The bubble's width with its whole glance shown, measured once before the typewriter empties it. */
  w: number;
}

/** An act waiting for the speaker's current bubble to finish. Stored as the ARGUMENTS, not as a
 * built bubble: by the time it plays the member may have walked to another desk, so the head anchor
 * and the actor's colour have to be resolved then, not now. */
interface Utterance {
  raw: string;
  tone: string;
  // Explicitly `| undefined` on each optional: the repo runs `exactOptionalPropertyTypes`, so a
  // field declared `id?: string` will not accept an `id` that is present and undefined — which is
  // exactly what forwarding `showSpeech`'s own optional arguments produces.
  id?: string | undefined;
  act?: string | undefined;
  addressee?: Addressee | null | undefined;
  marking?: SpeechMarking | null | undefined;
  lane?: string | null | undefined;
}

/**
 * Mount the live isometric office. Exposes a `{update, emit, dispose}` handle the `OfficeScene`
 * component drives. The office is a code-drawn Canvas2D scene; every member is an actor
 * (see `actors.ts`) drawn at a live pose. When nothing moves, the scene is baked to an offscreen buffer
 * and blitted (cheap); while acts play as choreography (walks/carry/hand-raise) the frame does a full
 * depth-sorted redraw so walkers overlap desks correctly and their labels follow them. Transient cues
 * (status pulse, note, resolve…) animate on top either way. Rive is a later swap behind `drawActor`.
 * Client-only.
 */
export interface OfficeOptions {
  /** Called with the act's envelope id when a speech bubble is clicked — the route uses it to scroll
   * to / highlight that act in the stream panel. Bubbles without an id (or no handler) aren't clickable. */
  onActClick?: (id: string) => void;
  /** `/live` only: a bubble whose act is about a lane gets an "open ›" that hands back the lane id —
   * the route opens that lane's chain on the board. Acts with no lane open their log row instead
   * (`onActClick`). Broadcast passes neither, so its bubbles carry no link. */
  onLaneClick?: (laneId: string) => void;
  /** `/live` only: the wall's agile board becomes a click target that hands back its viewport rect —
   * the route opens the work-board overlay zooming out FROM that rect. Requires `interactiveLabels`;
   * broadcast passes nothing and the wall stays paint. */
  onBoardClick?: (rect: DOMRect) => void;
  /** First hover/focus on the board hotspot — the route uses it to preload the overlay's lazy chunk
   * so the click meets code that is already here. */
  onBoardHover?: () => void;
  /** `/live` only: the working-hours calendar becomes the door to the settings overlay, handing back
   * its viewport rect the way the board does. The hotspot starts hidden; `setSettingsSpot` shows it
   * once the viewer is someone with settings (a signed-in human). Requires `interactiveLabels`. */
  onSettingsClick?: (rect: DOMRect) => void;
  /** First hover/focus on the calendar — preload the settings overlay's chunk. */
  onSettingsHover?: () => void;
  /** Broadcast mode (ADR 157): this office is a *stream source*, not a viewer's panel. The loop keeps
   * running while the tab is hidden or headless, DPR is pinned to 1 for a deterministic capture size,
   * and suspend requests are ignored. Only `/broadcast` passes it — see ./broadcast.ts. */
  broadcast?: boolean;
  /**
   * Encode fps when `broadcast` — the office coalesces draws to this rate so paint matches capture
   * (capture-perf plan). Defaults to 30 (CLI / ADR 157). Hosted streams pass 25 via `?fps=`.
   */
  captureFps?: number;
  /**
   * `/live` only: labels accept pointer/hover so the identity+work tip can open. Broadcast keeps
   * labels non-interactive (no cursor on a stream capture).
   */
  interactiveLabels?: boolean;
  /**
   * Hybrid work cues under nameplates (spec §2). When false, always-on work lines are omitted — use
   * the team column instead.
   */
  showWorkCues?: boolean;
  /**
   * The narration line (first-five-seconds §2) — one transient plain-language moment about what
   * just happened in the room. Called with the current caption, or null when it expires. The rail
   * used to be a floating lower-third element over the scene; it now reads as chrome, so the CHROME
   * renders it (the team column's header) and the scene only says what the moment is (nick, 2026-08-31).
   */
  onCaption?: (caption: Caption | null) => void;
  /** ADR 464: a plate under the pointer names its member (null on leave), so the team column can
   * ring that member's card — the office and the column read as one person. `/live` only. */
  onPlateHover?: (name: string | null) => void;
  /**
   * Rasterize the static furniture once per state and blit it, instead of redrawing the whole room
   * every frame (spec 2026-09-17). Off unless passed: `/broadcast` passes it by default (ADR 488,
   * `&sprites=0` opts out) and `/live` never does, so viewers keep the direct render.
   * The baked idle frame never uses it — keeping `bake()` byte-identical is what makes the gate's
   * reference honest.
   */
  sprites?: boolean;
  /**
   * Repaint only what changed (./damage.ts, smooth-capture spec lever 2). Needs `sprites` — it rides
   * the sprite cache's switch, as the spec scopes it. `/broadcast` passes it by default (`&dirty=0`
   * opts out) and `/office-preview?dirty` for the parity gate; `/live` never does.
   */
  dirtyRects?: boolean;
  /**
   * What the panel is fitted to. `'room'` (default): the whole scene, margins and all — the musterd.io
   * hero and /office-preview. `'furnished'`: the furnished room (`furnishedBox`), so people and plates
   * read larger while the door and the agile board are always in frame — /live and /broadcast.
   * Constant per mount, so every sprite key stays valid.
   */
  fit?: 'room' | 'furnished';
}

export function mountOffice(
  host: HTMLElement,
  labelHost: HTMLElement,
  reduced: boolean,
  options: OfficeOptions = {},
): OfficeHandle {
  const broadcast = options.broadcast === true;
  /* Read once at mount: the flag cannot change under a running room, and re-parsing per bubble would
     put a URLSearchParams allocation on the speech path. */
  const STILL = stillMode();
  const captureFps =
    typeof options.captureFps === 'number' && options.captureFps > 0
      ? options.captureFps
      : DEFAULT_CAPTURE_FPS;
  const interactiveLabels = options.interactiveLabels === true;
  /* `?plates-open` (stillMode.ts) — measurement mode: every plate mounts with its detail already
     open, so the harness segment's four inks are visible to the contrast sweep. Read once here
     rather than per plate per sync: the flag cannot change without a navigation, and this runs
     inside syncLabels. Interactive routes only — a broadcast plate has no detail to open. */
  const platesOpen = interactiveLabels && platesOpenMode();
  const showWorkCues = options.showWorkCues !== false;
  const dpr = officeDpr(broadcast, DPR_CAP);
  /* The per-item sprite cache, or undefined — `renderScene` with no cache paints exactly as it
     always has, so this flag is the whole blast radius. Cleared on resize (every key carries the
     fit, so stale entries would only waste memory) and on dispose. */
  const sprites = options.sprites === true ? makeSpriteCache({ dpr }) : undefined;
  const dirtyRects = sprites !== undefined && options.dirtyRects === true;
  /* Pre-rendered art behind `?office=rendered` (office realism, spec 2026-10-20 §7). Read once at
     mount like the other flags. The painted room draws until the images have decoded; then one
     rebake switches every item whose asset arrived, and the sprite cache starts over (its keys
     never saw the images). A manifest that is not there — a checkout before the art landed — logs
     once and leaves the room painted. */
  let rendered: RenderedAssets | undefined;
  const renderedFlag = typeof window !== 'undefined' && renderedOfficeFromSearch(window.location.search);
  /* The rendered room is drawn from the corner camera (spec §2.2, plan Task 5); the painted room
     keeps the iso it was drawn at. The camera rides on the fit, so every `project()` follows. */
  const cam: Camera | undefined = renderedFlag ? CORNER_CAMERA : undefined;
  if (renderedFlag) {
    const files = import.meta.glob('./rendered/assets/*', { query: '?url', import: 'default', eager: true }) as Record<
      string,
      string
    >;
    const manifestUrl = files['./rendered/assets/manifest.json'];
    if (!manifestUrl) {
      console.warn('office: ?office=rendered but rendered/assets/manifest.json is not in this build — painting');
    } else {
      void fetch(manifestUrl)
        .then((r) => r.json())
        .then((json: unknown) => {
          const manifest = parseManifest(json);
          if (!cameraMatches(manifest, CORNER_CAMERA)) {
            throw new Error(
              `rendered at camera (${manifest.camera.kx}, ${manifest.camera.ky}), scene projects through (${CORNER_CAMERA.kx}, ${CORNER_CAMERA.ky}) — re-render with --ky ${CORNER_CAMERA.ky}`,
            );
          }
          return loadRenderedAssets(manifest, (file) => files[`./rendered/assets/${file}`] ?? file);
        })
        .then(async (r) => {
          /* The figure sheets (increment 3) ride in beside the room: no figure.json, or one that
             will not parse, leaves the members painted and says so once. */
          const figureUrl = files['./rendered/assets/figure.json'];
          if (figureUrl) {
            try {
              const spec = parseFigureSpec(await (await fetch(figureUrl)).json());
              const fig = await loadFigureAssets(spec, (file) => files[`./rendered/assets/${file}`] ?? file);
              if (fig.missing.length) console.warn(`office: ${fig.missing.length} figure sheet(s) failed to load: ${fig.missing.join(', ')}`);
              // No skin sheet means no figure at all: keep the painted members rather than draw nobody.
              if (fig.sheets.has('skin')) r.figure = { spec: fig.spec, sheets: fig.sheets, scratch: fig.scratch };
              else console.warn('office: the figure skin sheet did not load — members stay painted');
            } catch (e: unknown) {
              console.warn('office: figure.json unusable — members stay painted', e);
            }
          }
          return r;
        })
        .then((r) => {
          if (disposed) return;
          if (r.missing.length) console.warn(`office: ${r.missing.length} rendered asset(s) failed to load: ${r.missing.join(', ')}`);
          rendered = r;
          sprites?.clear();
          bake();
        })
        .catch((e: unknown) => console.warn('office: rendered manifest unusable — painting', e));
    }
  }
  /* The dirty-rect state (see drawDamaged): the measure-pass recorder, sized to the canvas, and the
     last painted frame's units. Both reset on resize. */
  let recorder: Recorder | null = null;
  let prevUnits: Unit[] | null = null;

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  host.appendChild(canvas);

  // The agile board's hotspot — a real button laid over the painted board (the canvas takes no
  // pointer events; every click target in the office is DOM in the label layer). Created before any
  // nameplate or speech bubble so those stay above it in paint order: a bubble drifting across the
  // wall must stay clickable. Positioned from `boardAnchor` on every bake, so it tracks resizes the
  // same way the labels do.
  const boardSpot =
    interactiveLabels && options.onBoardClick
      ? (() => {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'lc-boardspot';
          el.setAttribute('aria-label', 'Open the work board');
          // The sign hung above the board (live-briefing spec, increment 5): it says what the board is
          // and that it opens, before anyone has to find out by hovering. A child of the button, so a
          // click on the sign is a click on the board.
          const tag = document.createElement('span');
          tag.className = 'lc-boardspot__tag';
          tag.textContent = 'work board';
          const caret = document.createElement('span');
          caret.className = 'lc-boardspot__caret';
          caret.setAttribute('aria-hidden', 'true');
          caret.textContent = '›';
          tag.appendChild(caret);
          el.appendChild(tag);
          el.addEventListener('click', () => options.onBoardClick!(el.getBoundingClientRect()));
          if (options.onBoardHover) {
            const warm = () => options.onBoardHover!();
            el.addEventListener('pointerenter', warm, { once: true });
            el.addEventListener('focus', warm, { once: true });
          }
          labelHost.appendChild(el);
          return el;
        })()
      : null;

  // The working-hours calendar's hotspot — the settings door (nick, 2026-10-19). Same build as the
  // board's: a real button over the paint, below every nameplate and bubble in DOM order. Hidden
  // until the route says the viewer has settings; a dot on it says a pairing waits for them.
  const hoursSpot =
    interactiveLabels && options.onSettingsClick
      ? (() => {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'lc-hoursspot';
          el.hidden = true;
          el.setAttribute('aria-label', 'Open settings');
          el.title = 'Settings';
          // A small oak tab fixed flush under the calendar's frame: the wall clock is directly above
          // the card and its header carries the days, and a sign hung on strings reached the desks.
          // A child of the button, so a click on it opens settings.
          const tab = document.createElement('span');
          tab.className = 'lc-hoursspot__tab';
          tab.setAttribute('aria-hidden', 'true');
          tab.textContent = 'settings ›';
          el.appendChild(tab);
          const dot = document.createElement('span');
          dot.className = 'lc-hoursspot__dot';
          dot.setAttribute('aria-hidden', 'true');
          el.appendChild(dot);
          el.addEventListener('click', () => options.onSettingsClick!(el.getBoundingClientRect()));
          if (options.onSettingsHover) {
            const warm = () => options.onSettingsHover!();
            el.addEventListener('pointerenter', warm, { once: true });
            el.addEventListener('focus', warm, { once: true });
          }
          labelHost.appendChild(el);
          return el;
        })()
      : null;

  function positionHoursSpot(): void {
    if (!hoursSpot) return;
    const a = hoursAnchor(fit);
    hoursSpot.style.left = `${a.x}px`;
    hoursSpot.style.top = `${a.y}px`;
    hoursSpot.style.width = `${a.w}px`;
    hoursSpot.style.height = `${a.h}px`;
    hoursSpot.style.setProperty('--lc-tab-x', `${a.foot.x}px`);
    hoursSpot.style.setProperty('--lc-tab-y', `${a.foot.y}px`);
    hoursSpot.style.setProperty('--lc-tab-w', `${a.foot.w}px`);
    hoursSpot.style.setProperty('--lc-tab-unit', `${a.foot.unit}px`);
    hoursSpot.style.setProperty('--lc-sign-tilt', `${a.tiltDeg.toFixed(2)}deg`);
  }

  function positionBoardSpot(): void {
    if (!boardSpot) return;
    const a = boardAnchor(fit);
    boardSpot.style.left = `${a.x}px`;
    boardSpot.style.top = `${a.y}px`;
    boardSpot.style.width = `${a.w}px`;
    boardSpot.style.height = `${a.h}px`;
    // How far below the box's top the board's top edge is at its middle — the sign hangs from there.
    boardSpot.style.setProperty('--lc-sign-drop', `${a.topMidY - a.y}px`);
    boardSpot.style.setProperty('--lc-sign-tilt', `${a.tiltDeg.toFixed(2)}deg`);
    boardSpot.style.setProperty('--lc-sign-scale', fit.scale.toFixed(3));
  }
  const ctx = canvas.getContext('2d')!;
  // Warm the izzocam chyron face the canvas labels/glyphs paint in, so they land on-brand from the
  // first cue instead of flashing the system fallback (canvas never triggers the load itself).
  preloadCanvasFont();

  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d')!;

  let width = Math.max(1, host.clientWidth);
  let height = Math.max(1, host.clientHeight);
  // The furnished box carries its own breathing room (FURNISHED_PAD, TOP_TRIM), so it fits flush;
  // the whole-room box keeps the 0.96 margin it has always had.
  const fitTo = options.fit === 'furnished' ? furnishedBox(cam) : roomBox(cam);
  const fitMargin = options.fit === 'furnished' ? 1 : 0.96;
  let fit: Fit = fitBox(width, height, fitTo, fitMargin, cam);

  const actors: Actors = createActors();
  /** The office dog (pet.ts): asleep in the baked frame; stirred by the ambient scheduler below. */
  const pet = createPet();
  /** The front-desk receptionist (receptionist.ts) — staff, not roster; asleep when the room is empty. */
  const recep = createReceptionist();
  /** The scene clock, in seconds. Everything that animates on its own — breathing, the typing bursts —
   * reads it, so it advances only while the loop runs and a rested office holds its frame. */
  let clock = 0;
  let placements = new Map<string, Placement>();
  // The caption rail (first-five-seconds §2): one transient plain-language line. The queue/hold
  // logic lives here in the lazy chunk; the LINE renders in the team column's header via onCaption.
  let rail: CaptionRail = { current: null, shownAt: 0, queue: [] };
  let railTimer: ReturnType<typeof setInterval> | null = null;
  let onlineNames = new Set<string>();
  // The receptionist welcome (first-five-seconds §4) — stepped on a coarse timer; her bubble rides
  // the ordinary speech machinery via the synthetic 'receptionist' head injected each bake.
  const welcome = createWelcome(
    broadcast,
    typeof localStorage === 'undefined' ? null : localStorage,
  );
  const welcomeTimer = setInterval(() => {
    if (STILL) return; // deterministic measurement mode: nothing transient may start
    if (!broadcast && (suspended || !VISIBLE())) return;
    // The team name is hers to say: she is the one character on the floor whose job is to tell a
    // stranger where they have landed (welcome.ts).
    const line = stepWelcome(welcome, Date.now(), actors.active(), teamName);
    if (line) showSpeech(RECEPTIONIST_SPEAKER, line, 'info');
  }, 5_000);
  /**
   * The Welcome Wagon (lane 01M3F81DD9): a new Member's arrival, played by the room's own residents.
   * Every decision lives in welcomeRoom.ts (unit-tested); these ports are only the residents it plays
   * through. The receptionist welcome above is a different thing — hers greets a VIEWER.
   */
  const kindOf = (name: string): 'agent' | 'human' =>
    actors.nodes().get(name)?.kind === 'agent' ? 'agent' : 'human';
  const soundAt = (at: WelcomeSoundAt): number => {
    const p =
      at === 'desk'
        ? RECEPTIONIST
        : at === 'door'
          ? ENTRANCE
          : (actors.poses().get(at.name) ?? ENTRANCE);
    return screenPan(project(p.lx, p.ly, fit).x, width);
  };
  /**
   * Where `name`'s head is RIGHT NOW. `heads` is refreshed by bake(), which last ran when a newcomer
   * was standing at the door — a burst or a wave anchored on it landed at the entrance. Same formula
   * as render.ts's head anchor, read off the live pose.
   */
  function liveHead(name: string): Pt | null {
    const pose = actors.poses().get(name);
    if (!pose) return heads.get(name) ?? null;
    const b = project(pose.lx, pose.ly, fit);
    return { x: b.x, y: b.y - (pose.small ? 90 : 116 - pose.sit * 22) * fit.scale };
  }
  /** Where the dog parks the wagon: the open aisle behind a desk's chair (nav.test pins it walkable). */
  const deskDrop = (name: string): { lx: number; ly: number } | null => {
    const pl = placements.get(name);
    const slot = pl?.kind === 'desk' ? DESK_SLOTS[pl.slot] : undefined;
    if (!slot) return null;
    const f = FWD[slot.dir];
    return { lx: slot.lx - f[0] * (SEAT_BACK + 60), ly: slot.ly - f[1] * (SEAT_BACK + 60) };
  };
  const welcomeRoom = createWelcomeRoom(
    {
      present: (n) => actors.nodes().has(n),
      hasDesk: (n) => placements.get(n)?.kind === 'desk',
      seated: (n) => actors.isSeated(n),
      reachedMark: (n) => actors.reachedMark(n),
      busy: () => actors.actWalking(),
      kindOf,
      color: (n, hue) => memberColor(n, kindOf(n), hue),
      expectFirstArrival: (n, carry) => actors.expectFirstArrival(n, carry),
      receptionist: (cue) => receptionistCue(recep, cue),
      say: (text) => showSpeech(RECEPTIONIST_SPEAKER, text, 'info'),
      wagon: (n) => {
        const drop = deskDrop(n);
        if (drop) petWagon(pet, WAGON_PICKUP, drop);
      },
      zoomies: () => void petZoomies(pet),
      wave: (n) => {
        // The three nearest teammates who are free to look up wave; the nearest of them says so.
        const waved = nearestNeighbors(n, 3, liveHead(n)).filter((m) => actors.welcomeWave(m));
        if (waved[0]) showSpeech(waved[0], '👋', 'info');
        const drop = deskDrop(n);
        if (drop) petFollow(pet, drop); // the dog trots over to meet them at their desk
      },
      confetti: (n, color) => pushConfetti(n, color ?? undefined, liveHead(n)), // a crowd keeps the palette
      door: (hue) => pushDoorCue(hue === null ? undefined : `hsl(${hue}, 70%, 72%)`),
      caption: (text, who) => pushRail({ text, who, tone: 'presence' }),
      sound: (m, at) => roomTone.moment(m, soundAt(at)),
    },
    { reduced, still: STILL },
  );
  /**
   * The Welcome Wagon's off-loop clock — armed by update() only while a welcome is queued or playing,
   * and it stops itself after (idle cost is paid by every
   * viewer, forever: packages/web/AGENTS.md). Two jobs. Under reduced motion there is no rAF loop at
   * all, so this IS the welcome's clock: stepped here, its captions and end states land (the final
   * review found that without it a reduced-motion room never drained and its canvas froze). Otherwise
   * it starts the loop for a welcome that became ready while the room was parked. Coarse on purpose: 500 ms on a 2 s wave window is invisible.
   */
  let wagonTimer: ReturnType<typeof setInterval> | null = null;
  function armWagonTimer() {
    if (wagonTimer || STILL) return;
    wagonTimer = setInterval(() => {
      const seen = !disposed && !suspended && (broadcast || VISIBLE());
      if (reduced) {
        if (seen) welcomeRoom.step(Date.now(), clock);
      } else if (seen && welcomeRoom.active() && !raf) {
        ensureLoop();
      }
      if (disposed || !welcomeRoom.active()) {
        if (wagonTimer) clearInterval(wagonTimer);
        wagonTimer = null;
      }
    }, 500);
  }
  function renderRail() {
    // The line is chrome now, not scene DOM — hand it out and let the team column's header carry it.
    options.onCaption?.(rail.current);
    if (rail.current === null && rail.queue.length === 0) {
      if (railTimer) clearInterval(railTimer);
      railTimer = null;
    } else if (!railTimer) {
      // Tick only while something shows or waits — no standing interval on an idle rail.
      railTimer = setInterval(() => {
        rail = tickCaption(rail, Date.now());
        renderRail();
      }, CAPTION_HOLD_MS / 4);
    }
  }
  function pushRail(caption: Caption) {
    rail = pushCaption(rail, caption, Date.now());
    renderRail();
  }
  let teamName = 'revive';
  let teamWorkingHours: OfficeData['teamWorkingHours'] = null;
  let wallBoard: WallBoard | null = null; // the wall's agile board (bake-time data)
  // The signed-in viewer's own seat: their plate says "you". Only where the labels are interactive —
  // a stream's plates belong to nobody watching.
  let you: string | null = null;
  /** Cards in someone's hand, and for a while after: a claimed lane's slot stays empty until the board's
   *  own refresh has moved it to "claimed" (or 12s pass), so the card does not pop back onto the wall
   *  between the walker sitting down and the board catching up. `laneSeed` → expiry (ms). */
  const takenUntil = new Map<number, number>();
  /** Cards pinned back on the wall by a resolve/submit walk, and for a while after — the counterpart of
   *  `takenUntil`: the card hangs under its new column until the board's own refresh agrees (or 12s). */
  const pinnedUntil = new Map<number, { state: PinnedCard['state']; until: number }>();
  /** When (scene clock, seconds) each pinned card landed — it swings on its tape for the first second (L5). */
  const pinLanded = new Map<number, number>();
  function wallBoardNow(): WallBoard | null {
    const now = performance.now();
    for (const seed of actors.takenSeeds()) takenUntil.set(seed, now + 12_000);
    for (const [seed, until] of takenUntil) if (until < now) takenUntil.delete(seed);
    for (const p of actors.pinnedSeeds()) pinnedUntil.set(p.seed, { state: p.state, until: now + 12_000 });
    for (const [seed, p] of pinnedUntil) if (p.until < now) pinnedUntil.delete(seed);
    let wb = takenUntil.size ? withTaken(wallBoard, [...takenUntil.keys()]) : wallBoard;
    if (pinnedUntil.size)
      wb = withPinned(
        wb,
        [...pinnedUntil].map(([seed, p]) => {
          const landed = pinLanded.get(seed);
          return landed === undefined ? { seed, state: p.state } : { seed, state: p.state, age: clock - landed };
        }),
      );
    return wb;
  }
  let heads = new Map<string, Pt>(); // home head anchors — where in-place cues sit
  let occupied = false; // any online member on the floor → overhead lights on
  let lightEnv: LightEnv = computeLightEnv(pstNowHours(), occupied); // office lighting from the PST clock

  const labels = new Map<string, HTMLDivElement>();
  /** The ask cards (ADR 464 §3.3): one per ask to a human, resting at the human's plate while open. */
  const askCards = new Map<string, { el: HTMLDivElement; ask: OfficeAsk }>();
  const askSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The verb over a walker (ADR 464 §3.2): set when an act walk starts, worn while
   *  `actors.actWalkingFor(name)`, dropped after — an ambient stroll never wears one. */
  const walkTags = new Map<string, string>();
  /** A replayed walker's age beside its verb ("4m ago"), set only while a replay emits (lane 01M50TZA8X). */
  const walkAges = new Map<string, string>();
  /** The send time of the replayed act being emitted, else null (live). */
  let replayAt: number | null = null;
  function setWalkTag(name: string, verb: string): void {
    walkTags.set(name, verb);
    if (replayAt !== null) walkAges.set(name, replayAge(Date.now() - replayAt));
    else walkAges.delete(name);
  }
  /** Who owns each lane the room has watched (lane 01M4V774MK): the deliver walk's carrier. */
  const laneOwners = createLaneOwners();
  let seededOwners: ReadonlyMap<string, string> | undefined; // the board map last handed to `laneOwners.seed`
  /** True while `drainReplay` emits: a replayed walk is older than the board, so it never notes an owner. */
  let replaying = false;
  let asksSeeded = false; // the first update seeds the open set silently — no hands go up for backfill
  const speeches = new Map<string, Speech>(); // one live speech bubble per member (name → bubble)
  const queued = new Map<string, Utterance[]>(); // acts waiting behind a member's live bubble
  const cues: Cue[] = [];

  const AUTO_COLLAPSE_MS = 5000;
  /** Expand + timer state survives syncLabels DOM rebuilds. */
  const plateExpand = new Map<
    string,
    { expanded: boolean; timer: ReturnType<typeof setTimeout> | null }
  >();

  function clearExpandTimer(name: string) {
    const st = plateExpand.get(name);
    if (!st?.timer) return;
    clearTimeout(st.timer);
    st.timer = null;
  }

  function applyExpandDom(name: string, expanded: boolean) {
    const el = labels.get(name);
    if (!el) return;
    el.classList.toggle('is-expanded', expanded);
    // The plate is the toggle now, so it carries the state a screen reader announces.
    el.querySelector('.lc-gl-label__plate')?.setAttribute(
      'aria-expanded',
      expanded ? 'true' : 'false',
    );
  }

  function scheduleCollapse(name: string) {
    const st = plateExpand.get(name);
    if (!st?.expanded) return;
    clearExpandTimer(name);
    st.timer = setTimeout(() => {
      st.expanded = false;
      st.timer = null;
      applyExpandDom(name, false);
    }, AUTO_COLLAPSE_MS);
  }

  function toggleExpand(name: string) {
    if (!interactiveLabels) return;
    let st = plateExpand.get(name);
    if (!st) {
      // Seeded from the flag for the same reason: without this, the first click on a plate that
      // MOUNTED open would set expanded=true — a no-op the viewer reads as a dead control.
      st = { expanded: platesOpen, timer: null };
      plateExpand.set(name, st);
    }
    clearExpandTimer(name);
    st.expanded = !st.expanded;
    applyExpandDom(name, st.expanded);
    // The tick lives HERE and not in applyExpandDom, whose other caller is scheduleCollapse's
    // timer — a tick from a timer is feedback for an action nobody chose (E4 spec §2).
    const at = heads.get(name);
    roomTone.moment(st.expanded ? 'plateOpen' : 'plateClose', at ? screenPan(at.x, width) : 0);
  }

  // ── Tier-A ambient overlay (ADR 086): GPU-composited CSS life over the baked floor — a slow day-cycle
  // wash, coffee-nook steam, and the animated desk props. Pure CSS, no canvas/RAF cost; off entirely under
  // reduced-motion. Lives in its own layer between the canvas and the label overlay. (The working-monitor
  // glow is *not* here — it's drawn in the canvas by `screenPanel` so a nearer monitor occludes it.)
  const ambientHost = document.createElement('div');
  ambientHost.className = 'lc-gl-ambient';
  let steamEl: HTMLDivElement | null = null;
  // Animated desk props (Tier-A CSS): a spinning blade over each fan and rising steam over each desk mug.
  // Fixed sets (a stable per-desk hash decides which desks have them), so these pools only reposition on
  // resize/rebake — never grow/shrink with the roster.
  const fanEls: HTMLDivElement[] = [];
  const deskSteamEls: HTMLDivElement[] = [];
  // Ambient magic (fixed sets, positions from the scene geometry): golden dust motes drifting in the
  // window light shafts — they fade with --lc-amb-strength, so night simply has none — and a soft
  // twinkle riding each string-light bulb the canvas paints.
  const moteEls: HTMLDivElement[] = [];
  const twinkleEls: HTMLDivElement[] = [];
  if (!reduced) {
    host.appendChild(ambientHost);
    const daylight = document.createElement('div');
    daylight.className = 'lc-amb-daylight';
    ambientHost.appendChild(daylight);
    steamEl = document.createElement('div');
    steamEl.className = 'lc-amb-steam';
    steamEl.innerHTML = '<i></i><i></i><i></i>';
    ambientHost.appendChild(steamEl);
  }
  let lastActive = 0; // ms timestamp of the last real act/cue — drives the afterglow tail (#5)

  // Pause the RAF loop when the tab is backgrounded (no CPU on an unseen office) — except in broadcast
  // mode, where an unseen office is the normal case and the loop must keep feeding the capture.
  const VISIBLE = () => officeVisible(broadcast);

  // Suspended = the panel is collapsed (opacity: 0, still mounted). Measured before this flag: a
  // collapsed office kept the full-scene ambient repaint running at ~18fps for invisible pixels —
  // any `working` seat keeps `living()` true, so the "rest on a still frame" state never engages on
  // a working team. While suspended the loop parks and ambient beats skip; `setSuspended(false)`
  // re-bakes and paints one fresh frame immediately, so re-expanding is still instant.
  let suspended = false;

  function sizeCanvases() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    for (const c of [canvas, buf]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    // The backing store above is in DEVICE pixels; the element still needs its CSS size, or it lays
    // out at the attribute size and renders `dpr`× too large. `/live` never saw this because
    // `.lc-gl-canvas canvas { width/height: 100% !important }` supplies it there — which is exactly
    // why the landing hero (host `.hero__canvas`, no such rule) shipped a 2× scene on musterd.io
    // until 2026-08-13. A scene must size its own canvas correctly for any host, not depend on the
    // consumer's stylesheet; `/live`'s `!important` rules still win over these, so nothing moves there.
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    fit = fitBox(width, height, fitTo, fitMargin, cam);
    // Every sprite key carries the fit, so a resize only strands the old rasters — drop them.
    sprites?.clear();
    // A new canvas is a new pixel grid: the next frame paints whole, measured from scratch.
    recorder = null;
    prevUnits = null;
  }

  /** Read the office surface tokens (`--floor`, `--floor-2`, `--wood`, `--couch`) the active theme
   * cascades to the canvas host, so the scene paints daylight on a light page and dusk inside the `.lc`
   * stage. Any token that can't be read falls back to the dusk palette. */
  function resolveScenePalette(): ScenePalette {
    const cs = getComputedStyle(host);
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      floor: read('--floor', DARK_PALETTE.floor),
      floor2: read('--floor-2', DARK_PALETTE.floor2),
      wood: read('--wood', DARK_PALETTE.wood),
      couch: read('--couch', DARK_PALETTE.couch),
      wall: read('--wall', DARK_PALETTE.wall),
    };
  }

  /** Recompute the office lighting from the PST clock + occupancy + the team's declared shift, and push
   * the natural-light wash (tint + strength) to the CSS overlay. Returns whether the *canvas* light
   * (night veil / desk lamps) crossed a step and so needs a rebake — the caller decides whether to act
   * on it. */
  function refreshLightEnv(): boolean {
    const prev = lightEnv;
    const inShift = teamWorkingHours
      ? isWithinWorkingHours(teamWorkingHours, new Date(), lightOverrideHours() ?? undefined)
      : null;
    lightEnv = computeLightEnv(pstNowHours(), occupied, inShift);
    if (!reduced) {
      // natural light enters as the soft-light wash — colour + strength straight off the clock
      ambientHost.style.setProperty('--lc-amb-strength', lightEnv.skyStrength.toFixed(3));
      ambientHost.style.setProperty('--lc-amb-tint', lightEnv.skyTint);
    }
    return (
      Math.abs(lightEnv.veilAlpha - prev.veilAlpha) > 0.01 || lightEnv.lampsOn !== prev.lampsOn
    );
  }

  /** Redraw the office at rest (everyone home) into the offscreen buffer and rebuild the name labels. */
  function bake() {
    setScenePalette(resolveScenePalette()); // follow the theme cascaded to the host before painting
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, width, height);
    const nodes = actors.nodes();
    const poses = actors.poses();
    const anchors = renderScene(
      bctx,
      fit,
      placements,
      nodes,
      poses,
      clock,
      teamName,
      lightEnv,
      pet,
      actors.sceneFx(),
      recep,
      wallBoardNow(),
      teamWorkingHours,
      { welcome: welcomeRoom.paint, rendered },
    );
    heads = anchors.heads;
    // The receptionist's bubble anchor — synthetic head above her desk. syncLabels skips names
    // without a node, so she gains a voice without gaining a nameplate or a roster row.
    const rp = project(RECEPTIONIST.lx, RECEPTIONIST.ly, fit);
    heads.set(RECEPTIONIST_SPEAKER, { x: rp.x, y: rp.y - 58 * fit.scale });
    syncLabels(anchors.heads, nodes, poses);
    repositionSpeeches(anchors.heads);
    positionBoardSpot();
    positionHoursSpot();
    if (!reduced) {
      positionSteam();
      syncDeskProps();
      syncMagic();
    }
  }

  /** Position the dust-mote and bulb-twinkle overlays on the scene geometry (see `magicAnchors`).
   * Fixed sets — only repositioned on rebake/resize. Each element gets a stable stagger so the field
   * shimmers out of phase instead of pulsing in lockstep. */
  function syncMagic() {
    const { motes, bulbs } = magicAnchors(fit, lightEnv.hours);
    syncAnchorPool(moteEls, motes, 'lc-amb-mote', '<i></i>', 'translate(-50%, -50%)');
    syncAnchorPool(twinkleEls, bulbs, 'lc-amb-twinkle', '<i></i>', 'translate(-50%, -50%)');
    moteEls.forEach((el, i) => {
      el.style.setProperty('--lc-mote-delay', `${((i * 1.37) % 8).toFixed(2)}s`);
      el.style.setProperty('--lc-mote-dur', `${(7 + (i % 5) * 1.15).toFixed(2)}s`);
    });
    twinkleEls.forEach((el, i) => {
      el.style.setProperty('--lc-twinkle-delay', `${((i * 0.61) % 3.4).toFixed(2)}s`);
    });
  }

  /** Grow/shrink an element pool to `pts.length` and position each at its anchor. Used for the fixed-set
   * animated desk props — cheap reposition on every bake, structural change only if the count ever moves. */
  function syncAnchorPool(
    pool: HTMLDivElement[],
    pts: Pt[],
    cls: string,
    inner: string,
    origin: string,
  ) {
    while (pool.length < pts.length) {
      const el = document.createElement('div');
      el.className = cls;
      el.innerHTML = inner;
      ambientHost.appendChild(el);
      pool.push(el);
    }
    while (pool.length > pts.length) pool.pop()!.remove();
    pts.forEach((p, i) => {
      pool[i]!.style.transform = `${origin} translate(${p.x}px, ${p.y}px)`;
    });
  }

  /** Position the spinning-fan and desk-coffee-steam overlays over the props the canvas just baked. Fans
   * only spin at occupied desks — an unattended fan reads as wrong — so pass the seated-slot set. */
  function syncDeskProps() {
    const occupied = new Set<number>();
    for (const pl of placements.values()) if (pl.kind === 'desk') occupied.add(pl.slot);
    const { fans, coffees } = animatedDeskAnchors(fit, occupied);
    syncAnchorPool(
      fanEls,
      fans,
      'lc-amb-fan',
      '<div class="lc-amb-fan__tilt"><div class="lc-amb-fan__blades"></div></div>',
      'translate(-50%, -50%)',
    );
    syncAnchorPool(
      deskSteamEls,
      coffees,
      'lc-amb-steam lc-amb-steam--desk',
      '<i></i><i></i><i></i>',
      'translate(-50%, -100%)',
    );
    // A room of mugs must not puff in unison (lane 01M50X1WRW): each mug runs its three wisps a stable
    // fraction of the 3.6s cycle out of phase with the next. Negative delays start them mid-cycle.
    deskSteamEls.forEach((el, i) => {
      const off = ((i * 7) % 12) * 0.3;
      el.querySelectorAll('i').forEach((wisp, k) => {
        wisp.style.animationDelay = `${(k * 1.4 - off).toFixed(1)}s`;
      });
    });
  }

  function positionSteam() {
    if (!steamEl) return;
    const p = coffeeAnchor(fit);
    steamEl.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
  }

  /**
   * Plate sizes, as the browser last laid them out (lane 01M3GPH5KB). Read from a ResizeObserver so
   * the per-frame layout never forces a synchronous layout itself; an expanded plate reports its new
   * size here and the plates re-flow around it.
   */
  const plateSize = new Map<string, { w: number; h: number }>();
  const plateFullW = new Map<string, number>();
  /** Each plate's slot and hold timers from the last layout — its hysteresis (plateLayout.ts). */
  let plateMemo = new Map<string, PlateMemo>();
  let lastHeads: Map<string, Pt> | null = null;
  const plateRO =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const e of entries) {
            const name = (e.target as HTMLElement).dataset['plate'];
            if (!name) continue;
            const box = e.borderBoxSize?.[0];
            const w = box ? box.inlineSize : e.contentRect.width;
            plateSize.set(name, { w, h: box ? box.blockSize : e.contentRect.height });
            // The width WITH its "working on" chip, remembered while the chip shows: the board test below
            // judges that width, so hiding the chip (which narrows the plate) cannot flip the verdict back.
            const work = (e.target as HTMLElement).querySelector<HTMLElement>('.lc-gl-label__work');
            if (!work || work.style.display !== 'none') plateFullW.set(name, w);
          }
          // A plate that grew (expanded) or first measured re-flows the room even while it is parked.
          if (lastHeads) positionLabels(lastHeads);
        });

  /** Create/remove label elements + set their text, and position them from `headMap`. Small (nook/strip)
   * actors are left unlabelled — their names bunch at a glance and the roster panel is the name source of
   * truth; the "+N" pills and location carry the secondary read.
   *
   * Present members: collapsed plate is dot + name + provider icon; expand grows a divider after the
   * name and reveals model · harness · role behind it. Broadcast: icon + short model only. */
  function syncLabels(
    headMap: Map<string, Pt>,
    nodes: Map<string, OfficeNode>,
    poses: Map<string, Pose>,
  ) {
    const seen = new Set<string>();
    for (const name of headMap.keys()) {
      const node = nodes.get(name);
      if (!node || poses.get(name)?.small) continue;
      seen.add(name);
      let el = labels.get(name);
      if (!el) {
        el = document.createElement('div');
        el.className = 'lc-gl-label';
        el.dataset['plate'] = name;
        if (interactiveLabels) {
          el.tabIndex = 0;
          el.addEventListener('mouseenter', () => options.onPlateHover?.(node.name));
          el.addEventListener('mouseleave', () => options.onPlateHover?.(null));
        }
        labelHost.appendChild(el);
        labels.set(name, el);
        plateRO?.observe(el);
      }
      el.textContent = '';
      el.style.pointerEvents = interactiveLabels ? 'auto' : 'none';
      el.classList.toggle('is-broadcast', !interactiveLabels);
      /* The plate's rim wears the seat's own hue rather than the house mustard — the same identity
         the body under it is painted in. `memberColor`, a FILL: the CSS mixes it into the paper rim
         at 34% and it never carries text, so the fill/ink split is respected. */
      el.style.setProperty('--lc-plate-hue', node.color);

      const present = node.presence !== 'offline';
      // Absent state means the viewer has not touched this plate yet, which is where `?plates-open`
      // lands: the DEFAULT is open under the flag, so plates mount unpacked with no transition to
      // race. An explicit state always wins, so a viewer collapsing one still collapses it.
      const expanded = plateExpand.get(name)?.expanded ?? platesOpen;
      el.classList.toggle('is-expanded', expanded);

      const meta = identityMeta({
        surface: node.surface,
        model: node.model,
        role: node.role,
      });

      const plate = document.createElement('span');
      plate.className = 'lc-gl-label__plate';
      const dot = document.createElement('span');
      dot.className = `lc-gl-label__dot lc-gl-label__dot--${node.dozing ? 'off' : DOT_STATE[node.posture]}`;
      plate.appendChild(dot);
      const who = document.createElement('span');
      who.className = 'lc-gl-label__who';
      who.textContent = name;
      plate.appendChild(who);
      // What they do here, in a word a stream viewer already knows (lane 01M5FXZF49; a viewer asked
      // "can you show their occupations"). On the face, beside the name, so it is read with it — never
      // on a second line, which would make every plate taller and give plateLayout.ts more collisions
      // to settle by moving plates. A service already says what it is with its tag.
      const job = node.service ? null : occupation(node.role);
      if (job) {
        const jobEl = document.createElement('span');
        jobEl.className = 'lc-gl-label__job';
        jobEl.textContent = job;
        plate.appendChild(jobEl);
      }
      if (name === you) {
        // The viewer finding themselves in a room of twenty: a mono "you" right after the name, rimmed
        // in their own hue. Signed-in /live only (`you` is null wherever the labels are not interactive).
        const youTag = document.createElement('span');
        youTag.className = 'lc-gl-label__you';
        youTag.textContent = 'you';
        plate.appendChild(youTag);
      }
      if (node.blocked) {
        // Briefing inc 2b: owns a blocked lane. A small pennant in danger ink right after the name —
        // seen across the room on /live and on the stream alike, and only while it is true.
        const flag = document.createElement('span');
        flag.className = 'lc-gl-label__flag';
        flag.title = 'owns a blocked lane';
        flag.innerHTML =
          '<svg viewBox="0 0 10 12" aria-hidden="true"><path d="M2 1v10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.6 1.5h6l-1.8 2.4 1.8 2.4h-6z" fill="currentColor"/></svg>';
        plate.appendChild(flag);
      }

      if (present) {
        // The divider only exists once there is detail to divide from the name. Collapsed, the plate
        // is a dot, a name and the provider mark — the chevron is gone because the plate itself has
        // always been the click target, so the arrow was a second affordance for the same gesture
        // paying rent in the one dimension that matters at twenty seats.
        const plateRule = document.createElement('span');
        plateRule.className = 'lc-gl-label__rule';
        plateRule.setAttribute('aria-hidden', 'true');
        plate.appendChild(plateRule);

        if (node.dnd) {
          // dnd is prominent on the COLLAPSED plate (presence-honesty §3): same slot grammar as the
          // service tag, filled pill in the warn ink — visible at both scales without expanding.
          const dndTag = document.createElement('span');
          dndTag.className = 'lc-gl-label__dnd';
          dndTag.textContent = 'dnd';
          plate.appendChild(dndTag);
        }
        if (node.woken) {
          // Why this seat is in the room (ADR 131) — a wake put it there, rather than a person
          // opening a session. On the COLLAPSED plate, same slot grammar as `dnd` and `service`,
          // because the window it has to be read in is the whole problem: a clean codex wake held
          // presence for ELEVEN SECONDS (claim 14:19:04 → ws_close 14:19:15). A fact that only
          // appears on expand is a fact nobody will ever expand in time to see.
          // Quieter than `dnd` on purpose. dnd is an instruction to the room — do not walk to me —
          // and it outranks this; `woken` is context you check once something has caught your eye.
          const wokenTag = document.createElement('span');
          wokenTag.className = 'lc-gl-label__woken';
          wokenTag.textContent = 'woken';
          plate.appendChild(wokenTag);
        }
        if (node.service) {
          // A service seat has no model to attest (ADR 232 — it is pure code), so the provider
          // slot would render the unknown-"?" mark and read as a broken attestation. Say what it
          // is instead: a small mono "service" tag where the icon would sit.
          const tag = document.createElement('span');
          tag.className = 'lc-gl-label__service';
          tag.textContent = 'service';
          plate.appendChild(tag);
        } else if (node.kind === 'human') {
          // A human attests no model either, so the provider slot used to show the unknown "?" on
          // every person's plate — nick's included. A person glyph in the same 11px chip, worn in the
          // human's own hue: what they are, not a missing attestation.
          const icon = document.createElement('span');
          icon.className = 'lc-gl-label__provider lc-gl-label__provider--human';
          icon.title = 'human';
          icon.innerHTML = HUMAN_GLYPH_SVG;
          plate.appendChild(icon);
        } else {
          const provider = modelProvider(node.model);
          const icon = document.createElement('span');
          icon.className = 'lc-gl-label__provider';
          icon.style.borderColor = provider.border;
          icon.style.background = provider.fill;
          icon.innerHTML = providerIconHtml(provider, node.model);
          plate.appendChild(icon);
          // ADR 464: the model's short name beside its logo — a room reads "Opus 5.5", not a mark.
          // Lane titles stay OFF the plate; that is the team column's job (spec §4).
          const short = displayModel(node.model);
          if (short) {
            const modelName = document.createElement('span');
            modelName.className = 'lc-gl-label__model';
            modelName.textContent = short;
            plate.appendChild(modelName);
          }
        }

        // The detail is a two-part nest on purpose: the outer element is the animating *track* (a
        // 0fr→1fr grid column, which is the only way to slide open to a width nobody knows in
        // advance), and the inner one holds the content at its natural size so the track can clip it.
        const detail = document.createElement('span');
        detail.className = 'lc-gl-label__detail';
        const detailIn = document.createElement('span');
        detailIn.className = 'lc-gl-label__detailin';
        // Services carry no model: the tag above already says what they are, so the expanded
        // detail is harness · role only, and broadcast (model crumb only) shows nothing extra.
        // The model is already on the plate face beside its logo (ADR 464, lane 1), so the expanded
        // detail carries harness · role only — before this it said the model a second time. Broadcast
        // used to show the model crumb here as its only detail; with the name on the face it has none.
        const detailParts = interactiveLabels
          ? plateDetailParts({ surface: node.surface, role: job ? null : node.role })
          : [];
        for (const [i, part] of detailParts.entries()) {
          if (i > 0) {
            const divider = document.createElement('span');
            divider.className = 'lc-gl-label__rule';
            divider.setAttribute('aria-hidden', 'true');
            detailIn.appendChild(divider);
          }
          const segEl = document.createElement('span');
          segEl.className = `lc-gl-label__seg lc-gl-label__seg--${part.kind}`;
          // The three harnesses whose seats a provider pin cannot distinguish (a cursor seat's pin
          // says Claude) get a glyph + their own ink; everything else stays bare text.
          const glyph = part.kind === 'harness' ? surfaceGlyph(node.surface) : null;
          if (glyph) {
            segEl.classList.add(`lc-gl-label__seg--hz-${glyph.id}`);
            const mark = document.createElement('span');
            mark.className = 'lc-gl-label__hz';
            mark.setAttribute('aria-hidden', 'true');
            mark.innerHTML = glyph.svg;
            segEl.appendChild(mark);
            segEl.appendChild(document.createTextNode(part.text));
          } else {
            segEl.textContent = part.text;
          }
          detailIn.appendChild(segEl);
        }
        // Each child carries its own position so ONE css rule can stagger them. Five nth-child rules
        // did the same job and cost enough gzip to sit on the CSS budget's ceiling.
        for (const [i, child] of [...detailIn.children].entries()) {
          (child as HTMLElement).style.setProperty('--i', String(i));
        }
        detail.appendChild(detailIn);
        plate.appendChild(detail);

        if (interactiveLabels) {
          // The caret is the affordance, and it is back because removing it went too far: the plate
          // got 34% narrower for the twenty-seat floor, and nothing on it said it could open
          // (nick, 2026-08-03: "i cant tell i am able to expand the nameplate"). It rides the plate's
          // right edge, turns a quarter-turn on open, and costs ~7px — the width is worth paying for
          // a control nobody can find otherwise.
          const caret = document.createElement('span');
          caret.className = 'lc-gl-label__caret';
          caret.setAttribute('aria-hidden', 'true');
          plate.appendChild(caret);

          // The plate itself is the button — the caret is a picture of one, not a second target.
          plate.setAttribute('role', 'button');
          plate.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          plate.setAttribute('aria-label', `${name} identity`);
          plate.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExpand(name);
          });
        }
      }
      el.appendChild(plate);

      if (interactiveLabels) {
        el.addEventListener('pointerenter', () => clearExpandTimer(name));
        el.addEventListener('pointerleave', () => scheduleCollapse(name));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpand(name);
          }
        });
      }

      const chip = shortLaneState(node.laneState);
      const said = node.workSource === 'status';
      const showWork =
        showWorkCues && present && node.workTitle != null && node.workTitle.length > 0;
      if (showWork) {
        const workEl = document.createElement('span');
        workEl.className = `lc-gl-label__work${chip === 'blocked' ? ' is-blocked' : ''}`;
        workEl.textContent = shortWorkTitle(node.workTitle!);
        el.appendChild(workEl);
      }

      if (interactiveLabels && (meta.title || node.workTitle)) {
        const tip = document.createElement('div');
        tip.className = 'lc-gl-label__tip';
        tip.setAttribute('role', 'tooltip');
        const tipLines = [
          meta.title || null,
          node.workTitle
            ? `${node.workTitle}${chip ? ` (${chip})` : ''}${said ? ' · said' : ''}${
                node.moreLanes > 0 ? ` · +${node.moreLanes}` : ''
              }`
            : null,
        ].filter(Boolean);
        tip.textContent = tipLines.join('\n');
        el.appendChild(tip);
        el.title = '';
      } else if (meta.title) {
        el.title = meta.title;
      } else {
        el.title = '';
      }

      el.classList.toggle('is-offline', node.presence !== 'online' || node.dozing === true);
      // Woken seats wear a moonlit plate (nick, 2026-10-09): you can tell a wake from a person at a
      // keyboard across the room, not only by reading the tag.
      el.classList.toggle('is-woken', node.woken === true);
    }
    for (const [name, el] of labels) {
      if (!seen.has(name)) {
        clearExpandTimer(name);
        plateExpand.delete(name);
        plateRO?.unobserve(el);
        plateSize.delete(name);
        plateFullW.delete(name);
        el.remove();
        labels.delete(name);
      }
    }
    positionLabels(headMap);
  }

  /**
   * Place every plate for this frame (lane 01M3GPH5KB): front-to-back into the first free slot near its
   * own head, clear of other plates and other members' heads (plateLayout.ts). A plate off its home
   * spot draws a thin leader back to its head, in the member's colour, so it is never read as
   * someone else's. Cheap enough per frame: ~25 plates, compared pairwise, sizes from the observer.
   */
  /**
   * The in-room ask moment (ADR 464 §3.3, spec §6). A NEW open ask to a human: the asker raises a hand
   * at their desk (the welcome `wave` gesture, a beat long), a `?` cue rises over them, and a small
   * card rests at the human's plate for as long as the ask is open — the room can see who is waiting
   * on whom without a word from anyone. Settled: the card wears the verdict (✓ ✗ →) for a few seconds
   * and clears. Data-driven off `OfficeData.asks`, so a page loaded mid-ask shows the resting card
   * (no hand for backfill), and the state comes from the same derivation the banner reads.
   */
  const ASK_SETTLED_MS = 6_000;
  const ASK_MARK: Record<NonNullable<OfficeAsk['outcome']>, string> = {
    accepted: '✓',
    declined: '✗',
    proceeded: '→',
    deferred: '…',
    expired: '·',
    resolved: '✓',
  };
  function syncAsks(next: readonly OfficeAsk[], byName: Map<string, OfficeNode>) {
    const seen = new Set<string>();
    for (const ask of next) {
      seen.add(ask.id);
      const had = askCards.get(ask.id);
      if (!had) {
        if (ask.state !== 'open') continue; // a settled ask this page never saw open gets no card
        const el = document.createElement('div');
        el.className = 'lc-gl-ask';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = `<span class="lc-gl-ask__hand">✋</span><span class="lc-gl-ask__who"></span>`;
        el.querySelector('.lc-gl-ask__who')!.textContent = ask.from;
        el.style.setProperty('--lc-ask-hue', byName.get(ask.from)?.color ?? '');
        labelHost.appendChild(el);
        askCards.set(ask.id, { el, ask });
        // The hand goes up for a LIVE ask only: backfill and reduced motion show the resting card alone.
        if (asksSeeded && !reduced && !STILL) {
          actors.welcomeWave(ask.from); // the hand up beside the head, a beat long
          pushCue(ask.from, '#f4cf52', '?');
          ensureLoop();
        }
        continue;
      }
      if (ask.state === 'settled' && had.ask.state === 'open') {
        had.ask = ask;
        had.el.classList.add('is-settled');
        had.el.querySelector('.lc-gl-ask__hand')!.textContent = ASK_MARK[ask.outcome ?? 'resolved'];
        const t = setTimeout(() => {
          askSettleTimers.delete(ask.id);
          askCards.get(ask.id)?.el.remove();
          askCards.delete(ask.id);
        }, ASK_SETTLED_MS);
        askSettleTimers.set(ask.id, t);
      }
    }
    // Gone from the data without a settled beat (an older buffer edge): drop the card quietly.
    for (const [id, card] of askCards) {
      if (!seen.has(id) && card.ask.state === 'open') {
        card.el.remove();
        askCards.delete(id);
      }
    }
    asksSeeded = true;
  }

  /**
   * The walk tag (ADR 464 §3.2): the verb over a walker, for exactly as long as their act walk is
   * in flight. Managed PER FRAME here rather than on a bake: a plate rebuilt only on bakes would
   * gain the tag late and shed it late, and a plate whose width changes between two frames
   * re-centres its name — which is what the contrast sweep photographed mid-shift. An ambient
   * stroll never wears one; a finished walk loses it on the very next frame.
   */
  function syncWalkTags() {
    for (const [name, el] of labels) {
      const plate = el.querySelector('.lc-gl-label__plate');
      if (!plate) continue;
      const verb = walkTags.get(name);
      const show = verb !== undefined && actors.actWalkingFor(name);
      const tag = plate.querySelector('.lc-gl-label__walk');
      // A plate wearing a tag paints above its neighbours (`is-tagged`, z 2 — under every bubble at
      // z 3): the tag is the act's only words on the floor, and a later sibling at z auto covered it
      // (nick, 2026-10-19, lane 01M5B02V4A).
      el.classList.toggle('is-tagged', show);
      if (show && !tag) {
        const span = document.createElement('span');
        span.className = 'lc-gl-label__walk';
        // A replayed walk says how old it is, so nobody reads old news as happening now. On a long verb
        // the plate's 18rem cap clips its right edge, so the verb ellipsizes and the age stays whole.
        const age = walkAges.get(name);
        if (age === undefined) {
          span.textContent = verb;
        } else {
          span.classList.add('has-age');
          const v = document.createElement('span');
          v.className = 'lc-gl-label__verb';
          v.textContent = verb;
          const ago = document.createElement('span');
          ago.className = 'lc-gl-label__ago';
          ago.textContent = ` · ${age}`;
          span.append(v, ago);
        }
        plate.appendChild(span);
      } else if (!show && tag) {
        tag.remove();
        if (verb !== undefined) walkTags.delete(name);
        walkAges.delete(name);
      }
    }
  }

  /** Rest each card just above its human's plate (or the asker's, when the human has no plate). */
  function positionAskCards(placed: Map<string, { x: number; y: number }>) {
    const stacked = new Map<string, number>(); // cards already resting on this plate this frame
    for (const { el, ask } of askCards.values()) {
      const at = ask.to && placed.get(ask.to) ? ask.to : ask.from;
      const host = placed.get(at);
      if (!host) {
        el.style.opacity = '0';
        continue;
      }
      // Two asks resting on one plate stack upward rather than print on top of each other.
      const n = stacked.get(at) ?? 0;
      stacked.set(at, n + 1);
      const size = plateSize.get(at) ?? { w: 60, h: 14 };
      el.style.opacity = '';
      el.style.transform = `translate(-50%, -100%) translate(${host.x}px, ${host.y - size.h - 6 - n * 18}px)`;
    }
  }

  function positionLabels(headMap: Map<string, Pt>) {
    lastHeads = headMap;
    syncWalkTags();
    const boxes: PlateBox[] = [];
    // Mid-stride this frame — a sitter, a stander at the cooler or a lounge seat is not "moving".
    const poses = actors.poses();
    for (const name of labels.keys()) {
      const head = headMap.get(name);
      if (!head) continue;
      const size = plateSize.get(name);
      boxes.push({
        name,
        anchor: head,
        w: size?.w ?? 60,
        h: size?.h ?? 14,
        moving: poses.get(name)?.moving === true,
      });
    }
    // The holds run on the wall clock. The room keeps drawing for AFTERGLOW_MS (2.6s) past the last
    // motion, longer than either hold, so a plate waiting out its hold settles before the loop parks.
    const laid = layoutPlates(boxes, headMap, plateMemo, {
      scale: fit.scale,
      now: performance.now(),
    });
    plateMemo = laid.memo;
    let boardRect: { x0: number; y0: number; x1: number; y1: number } | undefined;
    for (const [name, el] of labels) {
      const laidAt = laid.placements.get(name);
      const head = headMap.get(name);
      if (!laidAt || !head) continue;
      // Clamp the plate's box to the stage's width. Plates grew a model name (ADR 464), and a seat
      // near the left wall — or a walker at the door — now has a plate wider than the room to its
      // left; before this its first word was cut off at x<0 (stanley, lane-1 acceptance).
      const size = plateSize.get(name) ?? { w: 60, h: 14 };
      const half = size.w / 2 + 2;
      const at =
        width > size.w + 4
          ? { ...laidAt, x: Math.min(Math.max(laidAt.x, half), width - half) }
          : laidAt;
      // The plate's HOME rides the transform, every frame, with no transition — it must track a
      // walking head exactly. The step off home rides `translate`, which `.lc-gl-label` transitions:
      // a plate that has to move glides there instead of snapping (nick, 2026-10-06).
      const homeX = width > size.w + 4 ? Math.min(Math.max(head.x, half), width - half) : head.x;
      // Hung by hand, not by a ruler: each plate sits a hair off true (±0.8°, seeded by the name so it never shivers).
      el.style.transform = `translate(-50%, -100%) translate(${homeX}px, ${head.y}px) rotate(${plateTilt(name)}deg)`;
      el.style.translate = `${(at.x - homeX).toFixed(1)}px ${(at.y - head.y).toFixed(1)}px`;
      el.classList.toggle('is-displaced', at.displaced);
      // A plate whose "working on" chip would run across the wall board drops the chip (the name stays,
      // and the hover tip still carries the title) — it was hiding cards, lane 01M4VNDVF7.
      const work = el.querySelector<HTMLElement>('.lc-gl-label__work');
      if (work) {
        boardRect ??= ((a) => ({ x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h }))(boardAnchor(fit));
        const over = plateCoversBoard(at, plateFullW.get(name) ?? size.w, size.h, boardRect);
        work.style.display = over ? 'none' : '';
      }
      if (at.displaced) {
        // From the plate's nearest edge to just above the crown it belongs to, in the label's own
        // coordinates (its box is `translate(-50%, -100%)` from `at`).
        const lead = leaderFrom(at, size.w, size.h, { x: head.x, y: head.y + 6 * fit.scale });
        el.style.setProperty('--lead-x', `${(lead.start.x - (at.x - size.w / 2)).toFixed(1)}px`);
        el.style.setProperty('--lead-y', `${(lead.start.y - (at.y - size.h)).toFixed(1)}px`);
        el.style.setProperty('--lead-len', `${lead.len.toFixed(1)}px`);
        el.style.setProperty('--lead-angle', `${lead.angle.toFixed(3)}rad`);
      }
    }
    repositionSpeeches(headMap);
    positionAskCards(
      new Map([...laid.placements].map(([n, p]) => [n, { x: p.x, y: p.y }] as const)),
    );
  }

  /**
   * The light-trace: one quadratic arc from just under the speaker's bubble to the recipient's head,
   * bowed upward so it clears the furniture between them rather than cutting through the room. Sized
   * to the bounding box of the two anchors (plus the bow) so the SVG never covers the whole stage and
   * intercepts nothing — it is inert decoration over a canvas that owns the pointer.
   */
  function drawTether(from: Pt, to: Pt): SVGSVGElement {
    const bow = Math.min(120, Math.max(48, Math.hypot(to.x - from.x, to.y - from.y) * 0.28));
    const y0 = from.y - SPEECH_LIFT + 8; // leaves the bubble at its lower edge, not the head
    const cx = (from.x + to.x) / 2;
    const cy = Math.min(y0, to.y) - bow;
    const minX = Math.min(from.x, to.x) - 2;
    const minY = cy - 2;
    const w = Math.abs(to.x - from.x) + 4;
    const h = Math.max(y0, to.y) - minY + 4;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'lc-speech-trace');
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    svg.style.left = `${minX}px`;
    svg.style.top = `${minY}px`;
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${from.x} ${y0} Q${cx} ${cy} ${to.x} ${to.y}`);
    // The dash is the whole path length, so the CSS animation draws it on from the speaker's end.
    svg.appendChild(path);
    return svg;
  }

  // ── ephemeral speech: an act's body types out over the sender's head, then fades ───────────────────
  function positionSpeech(
    outer: HTMLDivElement,
    head: Pt,
    board: { x: number; y: number; w: number; h: number } | undefined,
    fullW: number,
  ) {
    // A bubble follows its speaker, and a speaker at the wall board puts it across the board face for
    // the whole landing — hiding the card, its sway and the flourish. While it would cover the board it
    // slides sideways to clear it (whole and readable — hiding it lost the sentence), and eases back
    // as the speaker walks off. Measured only when the head is near the board's span, so the common
    // frame pays a comparison, not a layout read.
    let dx = board
      ? bubbleShiftOffBoard(head, { w: outer.offsetWidth, h: outer.offsetHeight }, SPEECH_LIFT, board)
      : 0;
    // And it stays inside the scene: a speaker by a side wall would otherwise carry half the sentence
    // past the edge (lane 01M5977YVQ). Checked only near an edge — a bubble is at most SPEECH_MAX_W wide.
    const cx = head.x + dx;
    const inView =
      cx < SPEECH_MAX_W / 2 + 8 || cx > width - SPEECH_MAX_W / 2 - 8
        ? bubbleShiftIntoView(cx, fullW, width)
        : 0;
    dx += inView;
    // The tail stays over the speaker for the edge slide (the board's slide moves the whole bubble aside).
    outer.style.setProperty('--lc-speech-tail', `${inView}px`);
    // A bubble slid left off the right wall has its tail on the RIGHT, where "open ›" hangs — the
    // link moves to the left corner rather than sitting on the tail.
    outer.classList.toggle('is-tail-right', inView < 0);
    outer.style.transform = `translate(-50%, -100%) translate(${head.x + dx}px, ${head.y - SPEECH_LIFT}px)`;
  }

  /** Keep every live bubble anchored over its member (follows a walker; snaps after a reseat). */
  function repositionSpeeches(headMap: Map<string, Pt>) {
    const board = speeches.size ? boardAnchor(fit) : undefined;
    for (const [name, s] of speeches) {
      const head = headMap.get(name);
      if (head) positionSpeech(s.outer, head, board, s.w);
    }
  }

  function clearSpeech(who: string, s: Speech) {
    for (const c of s.cancels) c();
    s.outer.remove();
    if (speeches.get(who) === s) speeches.delete(who);
  }

  /**
   * A member said something. If they are already mid-sentence, it WAITS.
   *
   * The floor used to supersede: a second act from the same seat destroyed the first bubble wherever
   * its typewriter had got to. On a quiet room that is invisible, but seats speak in bursts — a
   * status_update, then the lane act, then the insight — and what a viewer actually saw was a line
   * appear, get two words in, and vanish (nick, 2026-09-04: "the 1st one will appear briefly and
   * then get replaced by the next one"). The act was on screen and unreadable, which is worse than
   * not showing it: the eye is drawn to the movement and then given nothing.
   *
   * So a bubble now owns the head until it has finished. The next act queues, the current one types
   * out, holds a short beat rather than its full generous read (`SPEECH_HOLD_QUEUED_MS` — the long
   * hold is for a line nobody is waiting behind), fades, and the next enters. Hovering still freezes
   * everything, because the handover rides the same fade the hover already pauses.
   *
   * The queue is bounded and drops from the FRONT — see `SPEECH_QUEUE_MAX`.
   */
  function showSpeech(
    who: string,
    raw: string,
    tone: string,
    id?: string,
    act?: string,
    addressee?: Addressee | null,
    marking?: SpeechMarking | null,
    lane?: string | null,
  ) {
    const u: Utterance = { raw, tone, id, act, addressee, marking, lane };
    if (!speeches.has(who)) {
      playSpeech(who, u);
      return;
    }
    // Drop the oldest unshown, never the newest: what is worth catching up on is the recent state.
    const q = queued.get(who) ?? [];
    queued.set(who, enqueueSpeech(q, u));
  }

  /** Hand the head to the next queued act, if any. Called only where a bubble ended on its own
   * schedule — a bubble torn down because the office is disposing has nothing to hand over to. */
  function drainSpeech(who: string) {
    const q = queued.get(who);
    const next = q?.shift();
    if (!q || q.length === 0) queued.delete(who);
    if (next) playSpeech(who, next);
  }

  /** Build and run one bubble: type out, hold, drift up and fade. Driven by timers/CSS (not the RAF
   * loop), so it animates even while the office rests; reduced-motion shows the text at once with no
   * typewriter. When the act's envelope `id` is known (and the host wired `onActClick`), the bubble is
   * a click-through to that act in the stream panel. */
  function playSpeech(who: string, u: Utterance) {
    const { raw, tone, id, act, addressee, marking, lane } = u;
    const { glance, full, clamped } = shapeSpeech(raw, act);
    const head = heads.get(who);
    // Nothing to say, or the sender left the floor while queued (offline / capped out of the render).
    // Their backlog goes with them — a bubble over an empty desk is not a catch-up, it is a ghost.
    if (!glance || !head) {
      queued.delete(who);
      return;
    }

    const outer = document.createElement('div');
    outer.className = 'lc-speech';
    // Bubbles accept the pointer so hovering expands the text and pauses the fade — even before the
    // (click-through) affordance is wired below.
    outer.style.pointerEvents = 'auto';
    const inner = document.createElement('div');
    inner.className = 'lc-speech__inner';
    if (id && options.onActClick) {
      outer.classList.add('is-clickable');
      outer.title = 'Show this in the stream';
      outer.addEventListener('click', () => {
        outer.classList.add('is-picked'); // a soft acknowledge pulse as focus hands off to the stream
        options.onActClick!(id);
      });
    }
    /* ── the bubble's colour is WHO, not WHAT ──────────────────────────────────────────────────
       `--lc-speech-tone` names an act tone for historical reasons and now carries the sender's
       identity hue: ring, tail, blush and glow all come off it, so every bubble a member speaks
       looks like that member and no other. See speech.ts `speechMark` for the full argument and
       for where the act went instead.

       Two values, because a colour that is both SEEN and READ needs two (format.ts, and the
       --lc-*-ink block in Live.css). `node.color` is `memberColor` — a FILL, and it spans luminance
       0.154–0.699 across the hue bands, so mixing it into the rich-token text colours would be
       readable for indigo and not for amber. `memberInk` is the same hue held at a luminance that
       clears AA on the paper, and it is what the text usages mix with.

       The receptionist is not in the node map (she is staff, not roster — receptionist.ts), so she
       falls through to the act tone and to her own stock in the CSS. That is the intended path, not
       a gap: she is the one speaker on the floor with no identity to paint. */
    const speaker = actors.nodes().get(who);
    inner.style.setProperty('--lc-speech-tone', speaker ? speaker.color : toneColor(tone));
    // Both are set on every bubble, never one of them: `--lc-speech-ink` has no `:root` definition
    // (it is runtime-parametric, which is what exempts it from `tokens:check`), so a bubble that set
    // only the tone would leave every text usage with an unresolved var() — and an unresolved
    // `color:` is not an error, CSS just drops the declaration and the span silently inherits. That
    // is the exact failure mode the --lc-type-* note in packages/web/AGENTS.md records costing three
    // of six tokens in #1104. The receptionist gets the act tone for both, which is what she had.
    inner.style.setProperty(
      '--lc-speech-ink',
      speaker ? memberInk(who, speaker.kind, speaker.hue) : 'var(--lc-paper-ink)',
    );
    if (marking) {
      inner.classList.add(`is-mark--${marking.mark}`);
      // The loud variant of `needs-human`: the tier actually holds its sender (ADR 147 §2), so
      // nothing that seat was doing moves again until a person answers.
      if (marking.holds) inner.classList.add('is-holding');
      /* A real element rather than a pseudo, for two reasons that both bit: `__inner`'s ::before
         and ::after are the bubble's tail, and hanging the badge off `__text::after` instead
         anchored it to the TEXT — so on a bubble with a recipient chip it landed halfway down the
         body instead of at the corner. As a child of `__inner` it sits against the bubble's own box
         and inherits the enter/fade transition, which a pseudo on the outer wrapper would not. */
      const badge = document.createElement('span');
      badge.className = 'lc-speech__mark';
      badge.textContent = SPEECH_MARK_GLYPH[marking.mark];
      badge.setAttribute('aria-hidden', 'true');
      inner.appendChild(badge);
    }

    /* ── the receptionist's bubble is HOUSE, not a member's ────────────────────────────────────
       Everything the room says about itself comes out of her mouth — where you are, what these
       people are, what the bubbles mean (welcome.ts). Until now that arrived wearing the same paper
       and the same tail as an agent's status update, which quietly made the house voice look like a
       eleventh seat: the one bubble on the floor that is NOT an attested member speaking was the one
       hardest to tell apart from one.
       Same argument as receptionist.ts's "staff, not roster" — no nameplate, no headcount, no roster
       row — carried into the one place she does appear as a speaker. She gets the brand mark rather
       than an identity hue, because the mark IS her identity: she speaks for musterd, not for a
       seat. */
    if (who === RECEPTIONIST_SPEAKER) {
      outer.classList.add('is-reception');
      const mark = document.createElement('span');
      mark.className = 'lc-speech__brand';
      // Static markup from a constant path (brand/chipMark.ts) — no interpolated content ever
      // reaches it. Same shape as the provider pin and the harness glyph above.
      mark.innerHTML = musterdChipSvg(13);
      inner.appendChild(mark);
    }
    // ── the recipient chip ────────────────────────────────────────────────────────────────────
    // A directed act names who it is aimed at, so the body can safely say "you". Team and broadcast
    // acts pass no addressee: the team is already the default audience, and a chip on every bubble
    // would be chrome. The chip carries MEANING, so unlike the tether it survives reduced-motion
    // and measurement mode.
    if (addressee) {
      const chip = document.createElement('span');
      // A set chip drops the single-name width clamp: at 3-4 names the clamp ellipsises, and a chip
      // that names the set and then hides part of it is the failure this whole path exists to end.
      chip.className =
        addressee.names.length > 1 ? 'lc-speech__to lc-speech__to--set' : 'lc-speech__to';
      chip.textContent = `→ ${addressee.label}`;
      inner.appendChild(chip);
    }
    const textEl = document.createElement('span');
    textEl.className = 'lc-speech__text';
    inner.appendChild(textEl);

    // ── rich token rendering ──────────────────────────────────────────────────────────────────
    // The bubble speaks the stream's rich-text vocabulary: **strong**, `code`, #refs, collapsed
    // ULIDs, SHAs, plus the lane/goal lead verb — each a styled span, not a flat text dump. The
    // typewriter reveals *across* tokens: prose slices in char by char, chips pop in whole the
    // moment the reveal reaches them (a little beat of delight, honest to the token's atomicity).
    const glanceTokens = speechTokens(glance);
    const fullTokens = clamped ? speechTokens(full) : glanceTokens;
    interface Rendered {
      node: Text | HTMLElement;
      text: string;
      chip: boolean;
    }
    /** (Re)build textEl from tokens; `revealed` = show everything at once (hover/finish/reduced). */
    const buildTokens = (tokens: SpeechToken[], revealed: boolean): Rendered[] => {
      textEl.textContent = '';
      const out: Rendered[] = [];
      for (const t of tokens) {
        if (t.kind === 'text') {
          const node = document.createTextNode(revealed ? t.text : '');
          textEl.appendChild(node);
          out.push({ node, text: t.text, chip: false });
        } else {
          const el = document.createElement('span');
          el.className = `lc-st lc-st-${t.kind}`;
          el.textContent = t.text;
          if (t.kind === 'id') el.title = t.title; // full ULID one hover away
          if (!revealed) el.classList.add('is-off');
          textEl.appendChild(el);
          out.push({ node: el, text: t.text, chip: true });
        }
      }
      return out;
    };
    /** Advance the reveal to `n` visible characters: prose slices, chips pop whole. */
    const reveal = (rendered: Rendered[], n: number) => {
      let cum = 0;
      for (const r of rendered) {
        const take = Math.max(0, Math.min(r.text.length, n - cum));
        if (r.chip) {
          if (take > 0) (r.node as HTMLElement).classList.remove('is-off');
        } else {
          (r.node as Text).nodeValue = r.text.slice(0, take);
        }
        cum += r.text.length;
      }
    };
    if (clamped) {
      // a quiet "there's more" chip — hovering the bubble reveals the full text
      const more = document.createElement('span');
      more.className = 'lc-speech__more';
      more.textContent = '⋯';
      inner.appendChild(more);
    }
    outer.appendChild(inner);
    /* ── "open ›": the act's record, said out loud ──────────────────────────────────────────────
       The whole bubble was already a click-through, but nothing on it said so (the product-frame
       mock drew the link, nick picked it, 2026-10-19). A lane act opens the lane's chain on the
       board — who asked, who claimed, which model, who accepted — and anything else opens its row
       in the log. A child of OUTER, not `__inner`: hovering makes the inner a scroll container that
       clips whatever hangs outside it, and the link is what a viewer leaning in is reaching for.
       Hung off the bottom edge, so it never takes a row from the sentence. */
    if (id && options.onActClick && !broadcast) {
      const toLane = lane && options.onLaneClick ? lane : null;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lc-speech__open';
      open.textContent = 'open ›';
      open.title = toLane ? 'Open this lane on the board' : 'Show this act in the log';
      open.setAttribute('aria-label', open.title);
      open.addEventListener('click', (e) => {
        e.stopPropagation();
        outer.classList.add('is-picked');
        if (toLane) options.onLaneClick!(toLane);
        else options.onActClick!(id);
      });
      outer.appendChild(open);
    }
    labelHost.appendChild(outer);

    // Measured with the whole glance in it: the typewriter starts it empty, so a width read now would
    // place a bubble that grows past the scene's edge (lane 01M5977YVQ). The reveal below rebuilds it.
    buildTokens(glanceTokens, true);
    const s: Speech = { outer, cancels: [], w: outer.offsetWidth };
    speeches.set(who, s);
    positionSpeech(outer, head, undefined, s.w);

    // ── the light-trace ───────────────────────────────────────────────────────────────────────
    // A soft arc from the bubble toward the recipient's desk, drawn once and fading as the bubble
    // settles: it makes the room read as wired together rather than as a set of separate speakers.
    // Pure delight, so it stands down wherever delight is not wanted — reduced motion, and STILL
    // (ADR 285) where a moving line would make the contrast sweep nondeterministic. A recipient who
    // isn't on the floor (offline, or capped out of the render) has no desk to point at, so the
    // chip stands alone.
    //
    // An ADR 254 eligible set names 2–4 seats, any one of whom discharges the act, so it gets a
    // trace to EACH of their desks rather than a picked one: the room shows the same ambiguity the
    // ledger holds. A sender inside their own set is skipped here for the same reason a self-
    // addressed member act drops its tether.
    const targets = addressee?.tether
      ? addressee.names.filter((n) => n !== who).map((n) => heads.get(n))
      : [];
    const drawn = targets.filter((t): t is NonNullable<typeof t> => t !== undefined);
    if (drawn.length > 0 && !reduced && !STILL) {
      for (const target of drawn) {
        const trace = drawTether(head, target);
        labelHost.appendChild(trace);
        s.cancels.push(() => trace.remove());
      }
      // The whoosh deliberately follows the tether's own gate (E4 spec §2): a sweep describing
      // motion that is not drawing would be a lie. Pan rides sender → addressee with the trace, and
      // stays ONE sweep however many traces drew — four whooshes for one act is noise, not weight.
      roomTone.moment('whoosh', screenPan(head.x, width), screenPan(drawn[0]!.x, width));
    }

    // enter on the next frame so the hidden initial state paints first → the CSS transition actually runs
    const raf = requestAnimationFrame(() => outer.classList.add('is-in'));
    s.cancels.push(() => cancelAnimationFrame(raf));

    // Hover = "let me read this": finish any in-flight typewriter, swap to the full text, and grow the
    // bubble smoothly. We measure the natural height after the swap and hand it to CSS as --lc-speech-h
    // so max-height can transition (height:auto can't). The outer transform is left untouched — it
    // updates per frame to follow a walker, so all growth happens on the inner element.
    let expand = () => {};
    let collapse = () => {};
    if (clamped) {
      expand = () => {
        buildTokens(fullTokens, true);
        outer.classList.add('is-expanded');
        // measure on the next frame so the expanded (clamp-removed) layout has painted
        // Capped at the room left above it: a bubble grows UP from the speaker's head, and a long
        // act on a back-row speaker ran under the asks bar laid over the stage's top (nick,
        // 2026-10-20). Past the cap it scrolls, as it already did past 40vh.
        requestAnimationFrame(() => {
          const room =
            inner.getBoundingClientRect().bottom - labelHost.getBoundingClientRect().top - SPEECH_TOP_CLEAR;
          const h = Math.max(SPEECH_MIN_H, Math.min(inner.scrollHeight, room));
          inner.style.setProperty('--lc-speech-h', `${h}px`);
        });
      };
      collapse = () => {
        outer.classList.remove('is-expanded');
        inner.style.removeProperty('--lc-speech-h');
        buildTokens(glanceTokens, true);
      };
    }

    // The dismiss countdown: begin() arms it, and it's cancelled while hovered (below) so a reader —
    // or a click — is never raced by the fade. Longer glances earn a longer base read.
    let hold: ReturnType<typeof setTimeout> | undefined;
    let counting = false; // true once the typewriter has finished and the fade timer is live
    const begin = () => {
      counting = true;
      if (STILL) return; // measurement mode: the bubble stays up, so the sweep measures a room that stops
      // Read the queue HERE, not at build time: an act can arrive while this bubble is still typing,
      // and the whole point is that it shortens this line's stay rather than cutting it off. Re-read
      // on every begin(), so a hover that re-arms the countdown also re-asks the question.
      const waiting = queued.get(who)?.length ?? 0;
      hold = setTimeout(
        () => {
          outer.classList.remove('is-in');
          outer.classList.add('is-out');
          const rm = setTimeout(() => {
            clearSpeech(who, s);
            // The handover, at the end of the fade rather than the start of it — two bubbles over
            // one head, one arriving as the other leaves, reads as the flicker this replaced.
            drainSpeech(who);
          }, SPEECH_OUT_MS);
          s.cancels.push(() => clearTimeout(rm));
        },
        speechHoldMs(glance.length, act, waiting),
      );
    };
    s.cancels.push(() => clearTimeout(hold));

    // typewriter state (a no-op under reduced motion — the whole glance shows at once)
    let done = reduced;
    let finish = () => {};

    // One hover contract for the whole life of the bubble: finish any in-flight typewriter, expand to
    // the full text, and freeze the fade. Leaving restores the glance and re-arms the countdown.
    outer.addEventListener('mouseenter', () => {
      if (!done) finish(); // complete the glance instantly, which also arms the countdown
      clearTimeout(hold);
      expand();
    });
    outer.addEventListener('mouseleave', () => {
      collapse();
      if (counting) begin();
    });

    if (reduced) {
      buildTokens(glanceTokens, true);
      begin();
      return;
    }

    const rendered = buildTokens(glanceTokens, false);
    const total = speechLength(glanceTokens);
    const caret = document.createElement('span');
    caret.className = 'lc-caret';
    textEl.appendChild(caret); // unrevealed nodes are empty/hidden, so the caret rides the frontier
    let i = 0;
    finish = () => {
      if (done) return;
      done = true;
      clearInterval(iv);
      caret.remove();
      buildTokens(glanceTokens, true);
      begin();
    };
    const iv = setInterval(() => {
      i += 1;
      reveal(rendered, i);
      if (i >= total) finish();
    }, typeCadence(total));
    s.cancels.push(() => clearInterval(iv));
  }

  function drawCues(c: CanvasRenderingContext2D = ctx) {
    if (!cues.length) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const cue of cues) drawCue(c, cue, fit.scale);
  }

  /** Idle frame: blit the baked buffer, then any cues on top. */
  function drawStatic() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0);
    drawCues();
    prevUnits = null; // the canvas now holds the baked frame, which no measured frame describes
  }

  /** What one frame paints from, read once: the wall board ages its stickies off `performance.now()`,
   *  so the measure pass and the paint pass of one frame must read the same snapshot. */
  function frameInputs() {
    return {
      nodes: actors.nodes(),
      poses: actors.poses(),
      fx: actors.sceneFx(),
      board: wallBoardNow(),
    };
  }
  type FrameInputs = ReturnType<typeof frameInputs>;

  /** One pass of the room's paint sequence onto `c`, every unit through `units`. */
  function paintRoom(
    c: CanvasRenderingContext2D,
    units?: UnitHook,
    f: FrameInputs = frameInputs(),
  ) {
    const anchors = renderScene(
      c,
      fit,
      placements,
      f.nodes,
      f.poses,
      clock,
      teamName,
      lightEnv,
      pet,
      f.fx,
      recep,
      f.board,
      teamWorkingHours,
      { sprites, dpr, welcome: welcomeRoom.paint, units, rendered },
    );
    if (units) units.run(() => drawCues(c));
    else drawCues(c);
    return anchors;
  }

  /** Active frame: full depth-sorted redraw with live poses, labels following, cues on top. */
  function drawDynamic() {
    if (dirtyRects) {
      drawDamaged();
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    const anchors = paintRoom(ctx);
    positionLabels(anchors.heads);
  }

  /*
   * Dirty-rect repaint (./damage.ts). The room measures every unit of its paint sequence into a
   * recorder, diffs that against the last painted frame, and repaints only the rects that changed —
   * or the whole canvas on the first frame, after a resting blit, past the damage ceiling, and on the
   * periodic safety repaint that heals anything a measurement missed.
   */
  let lastFullAt = 0;
  let repaintPx = 0;
  let fullRepaints = 0;
  let partialRepaints = 0;
  let skippedRepaints = 0;
  let measureCtx: CanvasRenderingContext2D | null = null;
  let measureFont = '';
  function measureText(font: string, text: string): number {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return 0.6 * 10 * text.length;
    if (font !== measureFont) {
      measureCtx.font = font;
      measureFont = font;
    }
    return measureCtx.measureText(text).width;
  }
  /** Paint one frame's plan onto `c`. False when the paint sequence did not match the measured one. */
  function applyPlan(
    c: CanvasRenderingContext2D,
    plan: RepaintPlan,
    units: Unit[],
    f: FrameInputs,
  ): boolean {
    if (plan.kind === 'none') return true;
    /* Every frame starts from the 2D defaults, which is what the recorder measured against. Without
       this a frame inherits whatever the last one left (round line joins, a stroke colour), so a
       frame's pixels depended on its predecessor — and the stage's first frame differed from every
       frame after it, at the wall board's corners. */
    resetCtxState(c);
    if (plan.kind === 'full') {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      c.beginPath(); // the recorder starts each frame with no path; so does the stage
      paintRoom(c, undefined, f);
      return true;
    }
    const rects = plan.rects;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    for (const r of rects) c.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.clip();
    for (const r of rects) c.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.beginPath();
    let i = 0;
    paintRoom(
      c,
      {
        run(draw) {
          if (mustRun(units[i++], rects)) draw();
        },
      },
      f,
    );
    c.restore();
    return i === units.length;
  }

  /*
   * DEV ONLY — the dirty-rect parity check (`__office.dirtyParity`). While it runs, every frame's plan
   * is also applied to an offscreen MIRROR that receives exactly what the stage receives, and a whole
   * frame is painted into a second offscreen canvas; the two are compared byte for byte. Both are
   * offscreen canvases of one kind, so a difference is the partial repaint's and not the backend's.
   * `import.meta.env.DEV` is static, so none of this reaches a production bundle.
   */
  let parity: {
    mirror: CanvasRenderingContext2D;
    full: CanvasRenderingContext2D;
    frames: number;
    partial: number;
    mismatched: number;
    differing: number;
    maxDelta: number;
    beyond: number;
    worstFrame: number;
    series: number[];
    first: { frame: number; x: number; y: number; plan: string } | null;
  } | null = null;
  function checkParity(plan: RepaintPlan, units: Unit[], f: FrameInputs) {
    const p = parity!;
    applyPlan(p.mirror, plan, units, f);
    applyPlan(p.full, { kind: 'full' }, units, f);
    p.frames++;
    if (plan.kind === 'rects') p.partial++;
    const a = p.mirror.getImageData(0, 0, canvas.width, canvas.height).data;
    const b = p.full.getImageData(0, 0, canvas.width, canvas.height).data;
    let bad = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i]! - b[i]!);
      if (!d) continue;
      bad++;
      if (d > 1) p.beyond++;
      if (d > p.maxDelta) p.maxDelta = d;
      if (!p.first) {
        const px = i >> 2;
        p.first = {
          frame: p.frames,
          x: px % canvas.width,
          y: Math.floor(px / canvas.width),
          plan: plan.kind,
        };
      }
    }
    if (bad) p.mismatched++;
    p.differing += bad;
    if (bad > p.worstFrame) p.worstFrame = bad;
    p.series.push(bad);
  }
  function dirtyParity(on: boolean): DirtyParity | null {
    if (!on) {
      const p = parity;
      parity = null;
      if (!p) return null;
      const { frames, partial, mismatched, differing, maxDelta, first, beyond, worstFrame } = p;
      return {
        frames,
        partial,
        mismatched,
        differing,
        maxDelta,
        first,
        beyond,
        worstFrame,
        series: p.series,
      };
    }
    const surface = (): CanvasRenderingContext2D => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      return c.getContext('2d', { willReadFrequently: true })!;
    };
    parity = {
      mirror: surface(),
      full: surface(),
      frames: 0,
      partial: 0,
      mismatched: 0,
      differing: 0,
      maxDelta: 0,
      beyond: 0,
      worstFrame: 0,
      series: [],
      first: null,
    };
    prevUnits = null; // the mirror starts blank, so its first frame must be whole
    return null;
  }

  function drawDamaged() {
    recorder ??= makeRecorder({ width: canvas.width, height: canvas.height, measure: measureText });
    const rec = recorder;
    rec.reset([dpr, 0, 0, dpr, 0, 0]);
    const units: Unit[] = [];
    const f = frameInputs();
    const anchors = paintRoom(
      rec.ctx,
      {
        run(draw) {
          rec.begin();
          draw();
          units.push(rec.end());
        },
      },
      f,
    );
    const now = performance.now();
    /* The parity check pauses the safety net: a missed damage then builds up where it can be seen,
       instead of being wiped every few seconds and passing as residue. */
    const due = !(import.meta.env.DEV && parity) && now - lastFullAt > SAFETY_REPAINT_MS;
    const plan = due
      ? ({ kind: 'full' } as const)
      : planRepaint(prevUnits, units, canvas.width, canvas.height);
    prevUnits = units;
    if (plan.kind === 'none') skippedRepaints++;
    else if (plan.kind === 'full') {
      lastFullAt = now;
      fullRepaints++;
      repaintPx += canvas.width * canvas.height;
    } else {
      partialRepaints++;
      repaintPx += plan.area;
    }
    // A sequence that came out a different length is not the one that was measured: paint the
    // next frame whole rather than trust this one's rects.
    if (!applyPlan(ctx, plan, units, f)) prevUnits = null;
    if (import.meta.env.DEV && parity) checkParity(plan, units, f);
    positionLabels(anchors.heads);
  }

  /**
   * Is the room *alive* — is there body motion the scene has to keep drawing even with nobody walking?
   *
   * A member at their desk who is `working` breathes and types, so their frame changes every tick. This is
   * the one deliberate perf trade in the character work (the Rive rig anticipated it: "if we later want
   * always-on breathing, it's a deliberate perf trade recorded then"). It is bounded three ways: the loop
   * is capped to the ambient ~20fps when this is the *only* thing happening, it stops dead on a hidden tab
   * or under reduced-motion, and a room where nobody is working still rests on the baked frame — which is
   * exactly the state ADR 086 was protecting.
   */
  function living(): boolean {
    if (reduced) return false;
    // The same predicate the renderer types on and the room-tone `working[]` is collected by
    // (E2 spec §2's park invariant): keyed on activity while the renderer keyed on posture, a
    // posture-working seat with stale activity froze mid-typing on the park frame — and the sound
    // layer would have kept typing after the room visually idled.
    //
    // It now reads the pose too (`workingAtDesk`), because a desk is only alive once its owner has
    // sat down at it. A member still walking in keeps the loop running on their walk, and their sit
    // blend is itself reported as motion, so the loop cannot park between "seated" and `sit > 0.9`.
    //
    // ADR 660: and it reads the PULSE — a seated `working` seat with no live tool-call pulse is drawn
    // still (no typing, static screen), so it must not keep the loop awake either; the room parks
    // within fifteen seconds of the last call, and `pulse()` wakes it on the next.
    const poses = actors.poses();
    const now = Date.now();
    for (const n of actors.nodes().values())
      if (workingAtDesk(n, poses.get(n.name)?.sit) && pulseLive(n.pulse, now)) return true;
    return false;
  }

  /** Paint one resting frame with no loop running — the office holds a still frame instead of burning rAF. */
  function paintResting() {
    drawStatic();
  }

  let disposed = false; // set in dispose(); gates the ambient scheduler's re-arm

  // — the loop runs while walks or cues are in flight; otherwise the office rests on a still frame —
  let raf = 0;
  let last = 0;
  let acc = 0; // wall time accrued since the last drawn frame — coalesced under the ambient FPS cap
  let phase = 0; // coalescer carry: where this tick sits against the budget (see coalesceStep)
  let wasActive = false;
  // Render counters for a capture harness (OfficeHandle.stats). Under broadcast, `draws` tracks the
  // capture fps while `ticks` tracks rAF — the gap is the waste the draw-rate cap removes.
  let ticks = 0;
  let draws = 0;
  // Broadcast only: the DOM animations this cadence has paused and now owns (./domCadence.ts).
  const heldAnims = new WeakSet<object>();
  let beats = 0; // drift-heartbeat frames — the only counter that moves in a parked room
  const since = performance.now();
  function tick(now: number) {
    ticks++;
    // Frame-rate coalescing: viewers cap ambient-only motion to ~20fps (ADR 086 Phase 2). Broadcast
    // coalesces *every* stretch to the capture fps so paint matches encode (no #368 judder, no full-rAF
    // waste). `dt` accumulates either way, so walk maths stay correct with fewer samples.
    const inAfterglow = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    const noRealMotion = actors.ambientOnly() || !actors.active();
    const ambientOnly = noRealMotion && cues.length === 0 && !inAfterglow;
    const capped = shouldCoalesceDraw(broadcast, ambientOnly);
    const rafMs = last ? now - last : 1000 / 60;
    acc += rafMs;
    last = now;
    if (capped) {
      // Nearest-tick with carry, not "first tick past the budget": on the capture box the rAF runs
      // at about the budget itself, and the strict rule dropped a quarter of the frames (2026-09-16).
      const step = coalesceStep(
        phase,
        rafMs,
        ambientFrameBudgetMs(broadcast, AMBIENT_FRAME_MS, captureFps),
      );
      phase = step.phase;
      if (!step.draw) {
        raf = requestAnimationFrame(tick); // too soon for the next coalesced frame — keep the loop, skip the draw
        return;
      }
    } else {
      phase = 0; // an uncapped stretch paints every rAF; the carry restarts when coalescing resumes
    }
    draws++;
    const dt = Math.min(0.05, acc / 1000);
    // The DOM props (steam, motes, twinkles, fan, banner) advance by the wall time this frame covers
    // and only now, so the software compositor composes one frame per draw, not sixty a second.
    if (broadcast) stepDomAnimations(document.getAnimations(), acc, heldAnims);
    acc = 0;
    clock += dt;
    // Replay on open runs the walkers at tempo until the replayed walks have all landed; everything
    // else in the room (pet, lights, bubbles) keeps real time, so only the catch-up is fast.
    drainReplay();
    const walking = actors.step(dt * tempo);
    flourishFreshPins();
    if (tempo !== 1 && !actors.active()) tempo = 1;
    if (walking) noticePassersBy(); // a sleeping dog wakes to watch whoever is walking past it
    const petActive = stepPet(pet, dt); // false once it's asleep — the pet never keeps the room awake
    // The receptionist wakes for a present member and looks up while any check-in beat holds. Like
    // the pet, she never keeps an empty room awake: asleep returns false and the room bakes still.
    const anyonePresent = [...actors.nodes().values()].some((n) => n.presence !== 'offline');
    const recepActive = stepReceptionist(recep, dt, anyonePresent, actors.checkInHolds() > 0, {
      team: teamName,
      nowMs: Date.now(),
    });
    welcomeRoom.step(Date.now(), clock); // the Welcome Wagon's beats land here (lane 01M3F81DD9)
    const welcomeActive = welcomeRoom.active();
    pushOccupancy(now);
    for (let i = cues.length - 1; i >= 0; i--) {
      const c = cues[i]!;
      c.t += dt / CUE_SECS;
      if (c.t >= 1) cues.splice(i, 1);
    }
    // Anchor the afterglow window to the *end* of motion, not to emit-time: a walk-help/handoff often
    // outlasts AFTERGLOW_MS, so keep `lastActive` fresh while anything is moving. Then the settle tail
    // measures from the frame the last walk/cue clears — the Rive character eases into idle rather than
    // freezing the instant a long walk ends (#5).
    if (walking || cues.length) lastActive = now;
    const alive = living();
    if (walking || alive || petActive || recepActive || welcomeActive) {
      drawDynamic();
    } else {
      if (wasActive) bake(); // walkers just re-seated (or the pet/receptionist dozed off) — refresh
      drawStatic();
    }
    wasActive = walking || alive || petActive || recepActive || welcomeActive;
    // Keep animating while anything moves *or* while the room is alive (someone at a desk breathing and
    // typing — capped to ~20fps above). When the last walk/cue clears and nobody is working, we draw one
    // final settled frame and park: the frame stays on-canvas until the next act or presence change.
    // Afterglow: a brief tail past the last motion so a character eases into idle instead of freezing
    // mid-gesture — `actors.step` also reports its own blends, so a member never stops half-out of a chair.
    const settling = lastActive > 0 && now - lastActive < AFTERGLOW_MS;
    if (
      (walking || cues.length || settling || alive || petActive || welcomeActive) &&
      !reduced &&
      !suspended &&
      VISIBLE()
    ) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      last = 0;
      acc = 0;
      // The loop is parking, so occupancy stops updating — hand the sound layer a final snapshot
      // with `working: []` as the floor of the park invariant (E2 spec §2): a parked room must not
      // keep typing off its last live snapshot.
      pushOccupancy(now, true);
      // …and hand the room over to the slow heartbeat, so a quiet office breathes instead of freezing.
      ensureDrift();
    }
  }
  /* The drift heartbeat. Armed whenever the rAF loop is NOT running and the room is genuinely on
     screen; cleared the instant the loop takes over, so the two never draw the same frame twice. */
  let driftTimer: ReturnType<typeof setInterval> | null = null;
  function stopDrift() {
    if (driftTimer) clearInterval(driftTimer);
    driftTimer = null;
  }
  function ensureDrift() {
    if (driftTimer || raf || reduced || STILL || suspended || disposed || !VISIBLE()) return;
    driftTimer = setInterval(() => {
      // Re-check every tick, not just at arm time: a tab can hide, a panel collapse or a real act
      // wake the loop between two beats of a 250ms timer, and a drift frame drawn over a live rAF
      // frame is a double paint nobody asked for.
      if (raf || reduced || STILL || suspended || disposed || !VISIBLE()) {
        stopDrift();
        return;
      }
      clock += DRIFT_FRAME_MS / 1000;
      beats++;
      drawDynamic();
    }, DRIFT_FRAME_MS);
  }

  function ensureLoop() {
    if (!raf && !reduced && !suspended && VISIBLE()) {
      stopDrift(); // the real loop supersedes the heartbeat
      last = 0;
      acc = 0;
      raf = requestAnimationFrame(tick);
    }
  }

  /** Is anything actually happening right now? One home — two doors used to spell this out separately. */
  const alive = () =>
    living() || actors.active() || cues.length > 0 || (!reduced && welcomeRoom.active());
  /*
   * Coming back to a room that stopped being watched. There are two doors — the tab becoming visible
   * again and the panel re-expanding — and they ask the SAME question: the loop if the room is alive,
   * the slow breath if it is not. #1430 answered it twice and they disagreed; the collapse door
   * painted one resting frame and left a quiet office frozen for the rest of the session while the
   * visibility door resumed the breath. So neither door decides any more: they both come here.
   */
  function reengage() {
    if (alive()) ensureLoop();
    else ensureDrift();
  }

  // ── Ambient micro-choreography scheduler (ADR 086 Phase 2) ──────────────────────────────────────────
  // A timer (not the RAF loop) that, in a genuinely quiet room, sends one idle desk member on a slow
  // coffee-stroll every ~15–25s. Self-generated visual filler: it emits no acts, and any real act cancels
  // it and pushes the next slot out. Off entirely under reduced-motion / hidden tab.
  let ambientTimer: ReturnType<typeof setTimeout> | null = null;
  /** No real motion in flight (no walks, no cues, past the afterglow tail) — safe to inject a beat. */
  /**
   * The dog notices people. Called each frame something is walking: if anyone on the move passes close to
   * the sleeping dog, it lifts its head and watches them by. Cheap by construction — it only looks at
   * members who are actually moving, and `petNotice` bails immediately unless the dog is asleep.
   */
  function noticePassersBy(): void {
    const moving: { lx: number; ly: number }[] = [];
    for (const pose of actors.poses().values())
      if (pose.moving) moving.push({ lx: pose.lx, ly: pose.ly });
    if (moving.length) petNotice(pet, moving);
  }

  // ── occupancy → room tone ──────────────────────────────────────────────────────────────────────
  // The scene tells the sound engine who is near whom, so the murmur only plays when two members
  // actually share a zone and pans toward them (life/sound design §2.2). One-way and throttled: the
  // engine never reads the scene, and a push every couple of seconds is plenty for a layer whose
  // events are 2.5–8s apart.
  let occAt = 0;
  /** When the last act cue landed — the "recent act rate" nudge in `density` (E2 spec §2). */
  let actPulseAt = 0;
  /** FNV-ish name hash (same idiom as seating's) — a desk's audio seed is as stable as its chair. */
  const audioSeed = (name: string): number => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h;
  };
  function pushOccupancy(now: number, parked = false): void {
    if (!parked && now - occAt < 2000) return;
    occAt = now;
    const toX = (lx: number, ly: number): number => {
      const sx = project(lx, ly, fit).x;
      return Math.max(-1, Math.min(1, (sx / width) * 2 - 1));
    };
    // Group present members by shared zone: a pod (desk slots), a leisure zone, or the nook.
    const zones = new Map<string, { lx: number; ly: number }[]>();
    const actorPoses = actors.poses(); // read once — `working[]` below needs each member's sit blend
    // Desks that may type, tap and creak (E2 spec §2/§3) — collected by `workingAtDesk`, so the ears
    // agree with the typing the eyes see: posture (never activity, which lags) AND a body that has
    // sat down in that chair. The room used to type from the desk of a member who was still walking
    // toward it (nick, 2026-09-04). Forced empty on the park frame: the parked room is exactly the
    // room that should be quiet.
    const working: { x: number; seed: number }[] = [];
    let present = 0;
    for (const [name, pl] of placements) {
      const node = actors.nodes().get(name);
      if (!node || node.presence === 'offline') continue;
      present++;
      let zone: string | null = null;
      let at: { lx: number; ly: number } | null = null;
      if (pl.kind === 'desk') {
        const slot = DESK_SLOTS[pl.slot];
        if (slot) {
          // Bench neighbours and the two window desks are proximity zones of their own — two bench
          // sitters are exactly the "near each other" pair the room tone listens for.
          zone = slot.kind === 'pod' ? `pod-${slot.pod}` : slot.kind;
          at = { lx: slot.lx, ly: slot.ly };
          // Typing is heard only while it is seen: the seat's pulse gates the room tone too (ADR 660).
          if (!parked && workingAtDesk(node, actorPoses.get(name)?.sit) && pulseIntensity(node.pulse, Date.now()) > 0) {
            working.push({ x: toX(slot.lx, slot.ly), seed: audioSeed(name) });
          }
        }
      } else if (pl.kind === 'leisure') {
        const spot = LEISURE_SPOTS[pl.spot];
        if (spot) {
          zone = spot.zone;
          at = { lx: spot.lx, ly: spot.ly };
        }
      } else if (pl.kind === 'nook') {
        zone = 'lounge';
        at = { lx: 700, ly: 190 };
      }
      if (zone && at) {
        const list = zones.get(zone) ?? [];
        list.push(at);
        zones.set(zone, list);
      }
    }
    const pairs: { x: number }[] = [];
    for (const members of zones.values()) {
      if (members.length >= 2) {
        const mid = members.slice(0, 2);
        pairs.push({ x: toX((mid[0]!.lx + mid[1]!.lx) / 2, (mid[0]!.ly + mid[1]!.ly) / 2) });
      }
    }
    // Work intensity: the working share of who is present, nudged up while acts are actually
    // landing (a fading pulse, gone after a quiet minute). Tempo and mix only — never gain.
    const share = present > 0 ? working.length / present : 0;
    // Wall clock, not the rAF timestamp `now` — `actPulseAt` is stamped with Date.now().
    const actNudge = Math.max(0, 0.25 * (1 - (Date.now() - actPulseAt) / 60_000));
    const ctx: LifeContext = {
      pairs,
      // An asleep dog is a quiet dog — it neither pads nor jingles.
      dog: pet.mode === 'sleep' ? null : { x: toX(pet.lx, pet.ly), walking: pet.mode === 'walk' },
      working,
      density: Math.min(1, share + (working.length > 0 ? actNudge : 0)),
      // The same envelope the daylight overlay and the wall clock read — audio and window light
      // can never disagree, and `?light=HH` overrides audio too.
      daylight: lightEnv.daylight,
      hours: lightEnv.hours,
    };
    roomTone.setOccupancy(ctx);
  }

  /** Open-floor spots just beside each working member's chair — where the pet sits to supervise. */
  function workingSideSpots(): { lx: number; ly: number }[] {
    const out: { lx: number; ly: number }[] = [];
    for (const [name, pl] of placements) {
      if (pl.kind !== 'desk') continue;
      if (actors.nodes().get(name)?.activity !== 'working') continue;
      const slot = DESK_SLOTS[pl.slot];
      if (!slot) continue;
      const f = FWD[slot.dir];
      // beside the chair: back from the desk to the chair, then out perpendicular to the facing
      out.push({
        lx: slot.lx - f[0] * CHAIR_OFF + f[1] * 46,
        ly: slot.ly - f[1] * CHAIR_OFF - f[0] * 46,
      });
    }
    return out;
  }

  /**
   * A coffee-stroll, with the dog sometimes tagging along to the nook and sitting with them while they
   * pour. Whether the dog comes is *its* business: the stroll's own success is what's reported back, so a
   * dog that stays put can never cost a member their walk.
   */
  function coffeeStroll(who: string, slot: number): boolean {
    if (!actors.ambientWalk(who)) return false;
    if (roll(teamName, slot, 'pet-follow') < 0.5)
      petFollow(pet, COFFEE_STAND, slotRng(teamName, slot, 'pet-follow-walk'));
    return true;
  }

  /**
   * A water errand (spec L2), the coffee-stroll's sibling: the dog sometimes tags along to the cooler and
   * sits with them while the bottle fills (~5 s). Seeded on the shared slot, so two viewers of the same team
   * see the same dog make the same trip; the member's errand is what's reported back either way.
   */
  function waterStroll(who: string, slot: number): boolean {
    if (!actors.errandWater(who)) return false;
    if (roll(teamName, slot, 'pet-follow-water') < 0.4)
      petFollow(pet, COOLER_STAND, slotRng(teamName, slot, 'pet-follow-water-walk'));
    return true;
  }

  function quiet(): boolean {
    return (
      !actors.active() &&
      cues.length === 0 &&
      !(lastActive > 0 && performance.now() - lastActive < AFTERGLOW_MS)
    );
  }
  /** The shared beat log — the E1 falsifier: what the slot lattice decided, and whether this browser
   * could play it. Two visible viewers over the same interval must log the same slots, actors, and
   * beats in the same order; `played` is the one honest per-browser field (a locally busy room skips
   * a beat, bounded to that one slot). Read from CDP via the `window.__office` handle. */
  const ambientLog: AmbientLogEntry[] = [];
  function logAmbient(e: AmbientLogEntry): void {
    ambientLog.push(e);
    if (ambientLog.length > 200) ambientLog.shift();
  }
  function scheduleAmbient() {
    /* `STILL` sits beside `reduced` rather than inside `fireAmbient`: the point is that no timer is
       left ARMED, not merely that the beat is skipped when it lands. A scheduler that keeps
       re-arming and declining still re-enters the page's timer set, and the next reader wonders why
       a "held" room has a pending callback. Same reason `disposed` is checked here. */
    if (reduced || disposed || STILL) return;
    if (ambientTimer) clearTimeout(ambientTimer);
    // Armed to the next slot boundary, not a random delay: the wall-clock lattice is the scheduling
    // quantum (E1 spec §2), so every viewer of this team wakes at the same instants. The +5ms nudge
    // keeps a timer that fires a hair early from landing in the old slot and drawing stale rolls.
    ambientTimer = setTimeout(fireAmbient, AMBIENT_SLOT_MS - (Date.now() % AMBIENT_SLOT_MS) + 5);
  }
  function fireAmbient() {
    ambientTimer = null;
    if (disposed) return; // office torn down between the timer arming and firing — don't re-arm or wake

    // Only stir a calm, visible room; otherwise let this slot pass and wait for the next one. The
    // decision itself is pure over roster-derived inputs (stanley's E1 review item): local scene
    // state may veto PLAYING a beat, but it can never change WHICH beat every viewer chose.
    const slot = slotAt(Date.now());
    const nodes = actors.nodes();
    // The pool is pure over placements + nodes (ambientSeed.ts): seated members for gestures, the
    // non-working ones for errands, and chat pairs with nobody working (ADR 464 §3.1).
    const pool = ambientPool(placements, nodes);
    const decision = decideAmbient(teamName, slot, pool);
    // A floor walk (ADR 686) needs only that nobody else is on their feet. A gesture or a cue's
    // afterglow holding `quiet()` false would otherwise spend the floor's slot on a room that looked
    // still, which is exactly the gap the floor exists to close.
    const floorMayPlay = 'floor' in decision && decision.floor === true && !actors.walkingAny() && cues.length === 0;
    if (!reduced && !suspended && VISIBLE() && (quiet() || floorMayPlay)) {
      let played = false;
      if (decision.kind === 'pet') {
        // The pet's beat: it wakes, stretches, pads to a fresh nap spot (a sunbeam by day, a rug by
        // night, occasionally a working member's side) and curls back up.
        played = petBeat(pet, {
          daylight: lightEnv.daylight,
          hours: lightEnv.hours,
          workSpots: workingSideSpots(),
          rng: slotRng(teamName, slot, 'pet-beat'),
        });
        logAmbient({ slot, kind: 'pet', played });
        if (played) ensureLoop();
      } else if (decision.kind === 'pair') {
        // The pair beat: two neighbours turn and talk — the one beat with two subjects, so it is
        // decided above the per-member pick.
        played = actors.deskChat(decision.a, decision.b, slotRng(teamName, slot, 'chat'));
        logAmbient({ slot, kind: 'pair', pair: [decision.a, decision.b], played });
        if (played) ensureLoop();
      } else if (decision.kind === 'meet') {
        // The aisle meet (nick, 2026-10-12): two idle members get up, meet between their desks, talk,
        // and go back — the room reading as a team rather than parallel solo workers.
        played = actors.aisleMeet(decision.a, decision.b, slotRng(teamName, slot, 'meet'));
        // A meet that cannot happen here (the two would never reach each other) still walks: the
        // first of them goes for coffee instead. The walk floor counts a decided meet as a walk, so a
        // meet that played nothing would leave the room still for a floor and a half.
        if (!played) played = coffeeStroll(decision.a, slot);
        logAmbient({ slot, kind: 'meet', pair: [decision.a, decision.b], played });
        if (played) ensureLoop();
      } else if (decision.kind === 'member') {
        played = playAmbientBeat(
          decision.who,
          slot,
          pool.errands?.includes(decision.who) ?? true,
          'beat',
          decision.walk === true,
        );
        logAmbient({ slot, kind: 'member', who: decision.who, played });
        if (played) ensureLoop();
      }
      // The companion (ADR 617): one more seated member's in-place gesture beside a beat that PLAYED —
      // never a walk, and never on its own, so it can only share a wake the room was already paying for.
      if (played && decision.kind !== 'none' && decision.companion) {
        // The room notices (nick, 2026-10-15): when the beat is something MOVING nearby — the dog off
        // to a sunbeam, two colleagues meeting in the aisle, someone heading for coffee — the companion
        // swivels to watch it go by instead of fidgeting. Otherwise, a seated gesture of their own.
        const c = decision.companion;
        const target = movingNear(decision, c);
        const ok =
          (target !== null && actors.notice(c, target, slotRng(teamName, slot, 'notice'))) ||
          playAmbientBeat(c, slot, false, 'companion-beat');
        logAmbient({ slot, kind: 'companion', who: c, played: ok });
      }
    }
    scheduleAmbient();
  }

  /** How far a seated member will turn to watch something go by, in floor units — about two pods. */
  const NOTICE_RANGE = 280;
  /** Where the slot's beat is moving, if it is moving and near enough for `who` to notice (ADR 617). */
  function movingNear(d: AmbientDecision, who: string): { lx: number; ly: number } | null {
    const poses = actors.poses();
    const me = poses.get(who);
    if (!me) return null;
    let at: { lx: number; ly: number } | null = null;
    if (d.kind === 'pet') at = { lx: pet.lx, ly: pet.ly };
    else if (d.kind === 'meet') {
      const a = poses.get(d.a);
      const b = poses.get(d.b);
      if (a && b) at = { lx: (a.lx + b.lx) / 2, ly: (a.ly + b.ly) / 2 };
    } else if (d.kind === 'member' && actors.walking(d.who)) at = poses.get(d.who) ?? null;
    if (!at || Math.hypot(at.lx - me.lx, at.ly - me.ly) > NOTICE_RANGE) return null;
    return at;
  }

  /**
   * One ambient beat for one idle desk member: a weighted pick over the beats they can actually play —
   * the chair beats (swivel/roll) need casters under them, a sip needs a mug on that desk — with the
   * coffee-stroll staying in the mix at ~1 in 5. Weighted rather than uniform so the broad, always-valid
   * beats (stretch/glance/scratch/chin/lean) carry the room and the chair theatrics stay occasional.
   */
  function playAmbientBeat(
    who: string,
    slot: number,
    mayErrand = true,
    purpose = 'beat',
    /** The walk floor chose this beat (`WALK_FLOOR_SLOTS`): play an errand, never a seated gesture. */
    walkOnly = false,
  ): boolean {
    const pl = placements.get(who);
    const deskSlot = pl?.kind === 'desk' ? pl.slot : null;
    const casters = deskSlot !== null; // every desk chair rolls now (the `stool` kind is gone)
    const mug = deskSlot !== null && deskHasProp(deskSlot, 'coffee');
    const water = deskSlot !== null && deskHasProp(deskSlot, 'water');
    // A seated LEISURE spot (couch, meeting chair, waiting chair) is a different body: already
    // reclined with its hands in its lap, and with no desk, no casters and no mug to work against.
    // So it swaps the desk's `lean` — which would recline someone who is already reclined — for
    // `settle`, and leans the weights toward the broad, deskless beats (nick, 2026-08-31).
    const lounging = pl?.kind === 'leisure' && (LEISURE_SPOTS[pl.spot]?.sit ?? 0) > 0;
    const beats: Array<[number, () => boolean]> = [
      [15, () => actors.gestureBeat(who, GESTURE.stretch)],
      [lounging ? 20 : 15, () => actors.gestureBeat(who, GESTURE.glance)],
      [14, () => actors.gestureBeat(who, GESTURE.scratch)],
      [lounging ? 18 : 14, () => actors.gestureBeat(who, GESTURE.chin)],
      [14, () => actors.gestureBeat(who, lounging ? GESTURE.settle : GESTURE.lean)],
      /* The 2026-09-14 variation pass (nick). Four more solo beats, weighted BELOW the original five:
       * the old set carries the room's baseline rhythm and these are the ones you notice, which only
       * works while they stay the minority. `behindHead` and `pocketPhone` want a backrest and a lap,
       * so they sit out the deskless leisure spots where the body is already reclined with its hands
       * down — `shoulders` and `rubEyes` work anywhere a torso does. */
      [11, () => actors.gestureBeat(who, GESTURE.shoulders)],
      [10, () => actors.gestureBeat(who, GESTURE.rubEyes)],
      ...(lounging
        ? []
        : ([
            [10, () => actors.gestureBeat(who, GESTURE.behindHead)],
            [9, () => actors.gestureBeat(who, GESTURE.pocketPhone)],
          ] as Array<[number, () => boolean]>)),
      // The errands — real trips with a point to them, so they stay the occasional highlight.
      // A WORKING member gets none of them (ADR 464 §3.1): they stay at their desk, and the
      // micro-gestures above keep them from reading as a statue.
      ...(mayErrand
        ? ([
            [15, () => coffeeStroll(who, slot)],
            [9, () => actors.errandPhone(who, slotRng(teamName, slot, 'phone'))], // gets up, takes a call, paces, comes back
            // A meal is the one errand the dog cares about: it drops whatever it was doing and follows the
            // plate to the lounge to sit and stare at it. Not every time — a dog that never misses a meal is
            // a mechanism, and the beat reads better when you notice it happening rather than expect it.
            [
              7,
              () => {
                const seat = actors.errandFridge(who, slotRng(teamName, slot, 'fridge'));
                if (!seat) return actors.gestureBeat(who, GESTURE.glance); // lounge full → cheap fallback
                if (roll(teamName, slot, 'pet-beg') < 0.65)
                  petBeg(pet, seat, slotRng(teamName, slot, 'pet-beg-walk'));
                return true;
              },
            ],
          ] as Array<[number, () => boolean]>)
        : []),
    ];
    if (water && mayErrand) beats.push([8, () => waterStroll(who, slot)]);
    if (mug) beats.push([14, () => actors.gestureBeat(who, GESTURE.sip)]);
    if (casters)
      beats.push(
        [9, () => actors.gestureBeat(who, GESTURE.swivel)],
        [5, () => actors.gestureBeat(who, GESTURE.roll)],
      );
    if (walkOnly && mayErrand) {
      // The floor's beat is a trip, not a fidget: the same weighted pick, over the errands only. Water
      // needs a bottle on that desk, so a lounging member draws from the other three.
      const errands: Array<[number, () => boolean]> = [
        [15, () => coffeeStroll(who, slot)],
        [9, () => actors.errandPhone(who, slotRng(teamName, slot, 'phone'))],
        [7, () => actors.errandFridge(who, slotRng(teamName, slot, 'fridge')) !== null],
      ];
      if (water) errands.push([8, () => waterStroll(who, slot)]);
      // A floor walk must WALK. A trip this browser cannot start (the lounge full for the fridge, say)
      // falls back to the coffee run, which needs nothing but a free path. Which errand plays can then
      // differ between viewers for one slot; that someone walks cannot.
      beats.splice(
        0,
        beats.length,
        ...errands.map(([w, play]) => [w, () => play() || coffeeStroll(who, slot)] as [number, () => boolean]),
      );
    }
    let total = 0;
    for (const [w] of beats) total += w;
    // `purpose` keeps a companion's roll apart from the slot's own beat, so the two never mirror.
    let r = roll(teamName, slot, purpose) * total;
    for (const [w, play] of beats) {
      r -= w;
      if (r <= 0) return play();
    }
    return false;
  }

  /** The walkers' speed multiplier: 1 live, REPLAY_TEMPO while a replay is landing. */
  let tempo = 1;
  /**
   * Walks handed to `replay`, played by the FRAME LOOP — never from inside `update()`. #2429 played
   * them right after `setHomes`, before the rest of the update had built the frame (bake, heads,
   * labels), and fifty's acceptance found the room not filling whenever a walk was in the window
   * (2026-10-12). The first frame after the roster is placed drains this; each walk is emitted in
   * its own try so one bad event can only lose itself, not the room.
   */
  let replayPending: readonly (OfficeEvent & { at?: number })[] | null = null;
  function drainReplay(): void {
    if (!replayPending || actors.poses().size === 0) return; // nobody placed yet — the roster is still on its way
    const evs = replayPending;
    replayPending = null;
    tempo = REPLAY_TEMPO;
    replaying = true;
    for (const ev of evs) {
      replayAt = ev.at ?? null;
      try {
        emit(ev);
      } catch (err) {
        if (import.meta.env.DEV) console.error('office replay: event dropped', ev, err);
      }
    }
    replaying = false;
    replayAt = null;
    if (!actors.active()) tempo = 1; // nobody of theirs is in the room — nothing to catch up on
  }
  /** Latest pulse per member (ADR 660) — kept here because `update` replaces the node objects. */
  const pulses = new Map<string, SeatPulse>();

  function pulse(member: string, p: SeatPulse) {
    pulses.set(member, p);
    const n = actors.nodes().get(member);
    if (!n) return;
    n.pulse = p;
    // A parked room (no acts, nobody walking) must start moving when a seat starts working.
    if (!reduced) ensureLoop();
  }

  function update(next: OfficeData) {
    for (const n of next.nodes) {
      const p = pulses.get(n.name);
      if (p) n.pulse = p;
    }
    const nextOnline = new Set(
      next.nodes.filter((n) => n.presence === 'online').map((n) => n.name),
    );
    const presenceLine = onlineNames.size > 0 ? captionForPresence(onlineNames, nextOnline) : null;
    onlineNames = nextOnline;
    teamName = next.teamName ?? 'revive';
    teamWorkingHours = next.teamWorkingHours ?? null;
    you = interactiveLabels ? (next.you ?? null) : null;
    // The wall's tack holes come with the board (`projectWallBoard`, lane 01M50WEBTC): one cork for everyone.
    wallBoard = next.wallBoard ?? null;
    // The board's owners are the base layer under what the room watches (lane 01M50TZDDM).
    if (next.laneOwners && next.laneOwners !== seededOwners) {
      seededOwners = next.laneOwners;
      laneOwners.seed(next.laneOwners);
    }
    placements = assignSeats(next.nodes, new Set(next.gathered ?? []));
    const byName = new Map(next.nodes.map((n) => [n.name, n]));
    syncAsks(next.asks ?? [], byName);
    // Who is NEW (lane 01M3F81DD9) — fed BEFORE setHomes, because a first arrival's walk-in (the box,
    // the longer pause at the mark) is built inside it.
    const arrivals = welcomeRoom.onRoster(next.nodes, Date.now());
    if (welcomeRoom.active()) armWagonTimer();
    // "{name} just walked in" would say it twice — the welcome writes its own line for a newcomer.
    if (presenceLine && !arrivals.some((a) => a.online && a.name === presenceLine.who))
      pushRail(presenceLine);
    // The overhead lights follow occupancy: on while anyone's online on the floor, off once the room empties.
    occupied = next.nodes.some((n) => n.presence === 'online');
    refreshLightEnv(); // fold the new occupancy (+ current clock) into the lighting before we bake
    // Animate presence changes (walk in/out, drift) unless reduced-motion asked for stillness.
    actors.setHomes(placements, byName, !reduced);
    if (replayPending) ensureLoop(); // the queued replay drains on the next frame, now that people are placed
    // The pulse is read ONCE, above the motion gate: the door's sound plays under reduced-motion
    // (audio is not motion, E3 spec §2); only the visual glow stays gated.
    // A newcomer's walk-in already rang the door in their colour (welcomeRoom) — the plain cue stands down.
    const welcomedAtDoor = arrivals.some((a) => a.online);
    if (actors.takeDoorPulses() > 0 && !welcomedAtDoor) {
      roomTone.moment('door', screenPan(project(ENTRANCE.lx, ENTRANCE.ly, fit).x, width));
      if (!reduced) pushDoorCue(); // the entrance "opens" as someone comes/goes
    }
    // Someone just walked in: the dog goes to meet them at the door. Arrivals only — nobody, dog included,
    // gets up to see you leave. This outranks whatever nap it had planned, which is the whole point of it.
    if (!reduced && actors.takeArrivals() > 0) petGreet(pet);
    bake();
    // Under reduced motion there is no loop to start — a pending welcome must never stand in for the
    // resting repaint (it is stepped by armWagonTimer instead).
    if (actors.active() || cues.length || (!reduced && welcomeRoom.active())) ensureLoop();
    else paintResting(); // no motion → hold a still frame (Rive-aware; not the code-drawn buffer)
  }

  function pushCue(name: string, color: string, glyph: Cue['glyph'], urgent = false) {
    actPulseAt = Date.now(); // an act just landed — the density nudge's clock (E2 spec §2)
    const at = heads.get(name);
    if (!at) return;
    cues.push({ at: { x: at.x, y: at.y + 20 }, color, glyph, t: 0, urgent });
  }

  /** The acceptance celebration burst — a one-shot confetti puff over a member's head. */
  function pushConfetti(name: string, tint?: string, from?: Pt | null) {
    const at = from ?? heads.get(name);
    if (!at) return;
    cues.push({
      at: { x: at.x, y: at.y },
      color: '#5cd49a',
      glyph: '',
      t: 0,
      urgent: false,
      kind: 'confetti',
      ...(tint ? { tint } : {}),
    });
  }

  /** Seeds of lanes an acceptor just closed (their done-pin is an acceptance, not a self-close). */
  const acceptedPins = new Set<number>();
  /** The cards the pin walks had pinned on the previous frame — a seed that is new this frame was
   *  pinned this frame, which is the instant the flourish plays. */
  let prevPinned = new Set<number>();
  /** The accept flourish (spec 2026-10-13 L3): a puff of paper over the "done" column as the card lands.
   *  The board's done column is the last of six equal slices of its face. */
  function pushBoardConfetti() {
    const a = boardAnchor(fit);
    const col = (WALL_COLUMNS.indexOf('done') + 0.5) / WALL_COLUMNS.length;
    cues.push({
      at: { x: a.x + a.w * col, y: a.y + a.h * 0.7 },
      color: '#5cd49a',
      glyph: '',
      t: 0,
      urgent: false,
      kind: 'confetti',
    });
  }
  /** Called once a frame after the walkers step: plays the flourish for each accepted card that was
   *  pinned this frame. Skipped while a replay is landing — a replayed cue would celebrate old news. */
  function flourishFreshPins(): void {
    const now = new Set<number>();
    for (const [seed, at] of pinLanded) if (clock - at > 2) pinLanded.delete(seed);
    for (const p of actors.pinnedSeeds()) {
      now.add(p.seed);
      if (prevPinned.has(p.seed)) continue;
      pinLanded.set(p.seed, clock); // every card that lands swings once
      if (p.state === 'done' && acceptedPins.delete(p.seed) && tempo === 1) pushBoardConfetti();
    }
    prevPinned = now;
  }

  /** The `count` nearest drawn members to `name` (excluding them) within one pod's reach — the desk
   * neighbors who plausibly noticed. Head positions are already screen-space, so plain distance works. */
  function nearestNeighbors(name: string, count: number, from?: Pt | null): string[] {
    const at = from ?? heads.get(name);
    if (!at) return [];
    return [...heads.entries()]
      .filter(([n]) => n !== name)
      .map(([n, p]) => ({ n, d: Math.hypot(p.x - at.x, p.y - at.y) }))
      .filter((e) => e.d < 190 * fit.scale)
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map((e) => e.n);
  }

  /** A broadcast sweep rolling out from the announcer. */
  function pushWave(name: string, color: string) {
    const at = heads.get(name);
    if (!at) return;
    cues.push({
      at: { x: at.x, y: at.y + 20 },
      color,
      glyph: '',
      t: 0,
      urgent: false,
      kind: 'wave',
    });
  }

  /** A quiet mustard relationship between two Members for a meaningful directed Act. */
  function pushThread(from: string, to: string, color = toneColor('accent')) {
    const start = heads.get(from);
    const end = heads.get(to);
    if (!start || !end || cues.some((cue) => cue.kind === 'thread' && cue.source === from)) return;
    cues.push({
      at: { x: start.x, y: start.y + 18 },
      to: { x: end.x, y: end.y + 18 },
      color,
      glyph: '',
      t: 0,
      urgent: false,
      kind: 'thread',
      source: from,
    });
  }

  /** A nameplate's resting tilt in degrees: stable per name, within ±0.8°. */
  function plateTilt(name: string): number {
    return +((((laneSeed(name) >>> 3) % 17) - 8) * 0.1).toFixed(1);
  }

  /** The entrance glows as a member walks in or out. */
  function pushDoorCue(color = '#cfe7ee') {
    const p = project(ENTRANCE.lx, ENTRANCE.ly, fit);
    cues.push({ at: { x: p.x, y: p.y }, color, glyph: '', t: 0, urgent: false, kind: 'door' });
  }

  function emit(ev: OfficeEvent) {
    // A real act always preempts ambient filler: cancel any in-flight coffee-stroll and push the next
    // ambient slot out past this act, so ambient never delays real choreography or a speech bubble.
    if (!reduced) {
      // Only the ACTING member's ambient yields to their act (lane 01M5B02V4A); everyone else's
      // stroll or wave plays out. An event with no actor (a caption, a board pulse) yields nothing.
      const actor = (ev as { who?: unknown; from?: unknown }).who ?? (ev as { from?: unknown }).from;
      if (typeof actor === 'string') actors.cancelAmbient(actor);
      scheduleAmbient();
    }
    if (ev.kind === 'caption') {
      pushRail(ev.caption);
      return;
    }
    // Speech is legible content, not motion — it plays even under reduced-motion (typewriter off there).
    if (ev.kind === 'speech') {
      showSpeech(ev.who, ev.text, ev.tone, ev.id, ev.act, ev.addressee, ev.marking, ev.lane);
      // An ask lands with acoustic weight in the room (E3 spec §2): one soft held tone, panned to
      // the asked member's desk when directed, soft-centre for a team ask. Stateless by design.
      if (ev.act === 'ask') {
        // `ask` is deliberately not an ELIGIBLE_ACT (envelope.ts), so an ask's addressee is always
        // the single routed member — the first name is the only name.
        const at = ev.addressee ? heads.get(ev.addressee.names[0]!) : undefined;
        roomTone.moment('askbell', at ? screenPan(at.x, width) : 0);
      }
      return;
    }
    // The fanfare emits ABOVE the motion gate (E3 spec §2): the celebration sound plays under
    // reduced-motion; the confetti and glances below stay gated with the rest of the choreography.
    if (ev.kind === 'accept' && ev.of && ev.of !== ev.who && heads.has(ev.of)) {
      roomTone.moment('fanfare', screenPan(heads.get(ev.of)!.x, width));
    }
    if (reduced) return;
    switch (ev.kind) {
      case 'screen-pulse':
        pushCue(ev.who, toneColor(ev.tone), '');
        break;
      // `to` is a list on the three ELIGIBLE_ACTS: one name normally, 2-4 for an ADR 254 set. Each
      // name gets the identical treatment a single recipient gets — the room must not rank them,
      // because the ledger does not (nick, 2026-09-02).
      case 'note':
        pushCue(ev.from, toneColor(ev.tone), '');
        for (const to of ev.to) {
          pushCue(to, toneColor(ev.tone), '');
          pushThread(ev.from, to, toneColor(ev.tone));
        }
        break;
      case 'walk-help': {
        // The sender walks to EVERY name, one desk after another: `actors.walk` queues per call —
        // one trip in flight plus three pending, so a set at the MAX_ELIGIBLE cap of four fits
        // exactly, WITH NO HEADROOM. A sender who already has a walk running loses the tail of a
        // four-name set to the backlog guard, silently. Measured in the browser 2026-09-02: the
        // /office-preview script re-fires faster than an ~8.5s round trip drains, so from its
        // second loop on the guard refuses legs — including the single-recipient `Ada -> Bo` walk
        // that predates eligible sets entirely. That makes it a property of the queue depth and the
        // act rate, not of this fan-out; on /live, acts arrive far enough apart that it has room.
        // The fallback cue fires only if NO leg could play — one unreachable desk among several is
        // not a failed act, it is a shorter trip.
        let walked = false;
        for (const req of helpWalks(ev)) {
          pushThread(ev.from, req.to);
          if (actors.walk(ev.from, req)) walked = true;
        }
        if (walked) setWalkTag(ev.from, walkTag('help', null));
        if (!walked) {
          pushCue(ev.from, '#f4cf52', ev.tier === 'urgent' ? '!' : '', ev.tier === 'urgent');
        }
        break;
      }
      case 'walk-handoff':
        pushThread(ev.from, ev.to, toneColor('handoff'));
        if (actors.walk(ev.from, { kind: 'handoff', to: ev.to, urgent: false })) {
          setWalkTag(ev.from, walkTag('handoff', ev.to));
        } else {
          pushCue(ev.from, '#7fc8d8', '↦');
        }
        break;
      case 'walk-claim':
        // Claiming a lane (nick, 2026-10-09): to the wall board, think, take the card, carry it home.
        if (!replaying) laneOwners.note(ev.lane, ev.who);
        if (actors.claim(ev.who, laneSeed(ev.lane))) {
          const t = ev.title.length > 28 ? `${ev.title.slice(0, 27)}…` : ev.title;
          setWalkTag(ev.who, walkTag('claim', t || null));
        } else {
          pushCue(ev.who, '#8fb0e6', '');
        }
        break;
      case 'walk-pin':
        // A lane finished or submitted (nick, 2026-10-12): the owner carries the card back to the wall
        // board and pins it under its new column. Falls back to the in-place ✓ when they are not in the
        // room to make the trip.
        {
          // Who resolves a lane is not always who owns it: the acceptor's accept closes it, and the daemon
          // sends the resolve as THEM (spec 2026-10-13 §3). So only a submit names the owner, and a done
          // pin by anyone but the known owner is an acceptance — it earns the flourish at the board (L3).
          const accepted = ev.state === 'done' && laneOwners.closedByOther(ev.lane, ev.who);
          if (ev.state === 'awaiting_acceptance' && !replaying) laneOwners.note(ev.lane, ev.who);
          const seed = laneSeed(ev.lane);
          if (actors.pin(ev.who, seed, ev.state)) {
            if (accepted) acceptedPins.add(seed); // the flourish waits for the card to land (`flourishFreshPins`)
            const t = ev.title.length > 28 ? `${ev.title.slice(0, 27)}…` : ev.title;
            setWalkTag(ev.who, walkTag(ev.state === 'done' ? 'pin' : 'submit', t || null));
          } else {
            pushCue(ev.who, '#5cd49a', '✓');
            // No walk to wait for: flourish at once so an acceptor out of the room does not lose the cue.
            if (accepted && tempo === 1) pushBoardConfetti();
          }
        }
        break;
      case 'walk-deliver': {
        // Submitted to a named acceptor (nick, 2026-10-12): the owner carries the card to the acceptor's
        // desk and hands it over; this replaces the submit's board pin when both play. When either of
        // them is out of the room the pin walk (already queued) stands, so only a thread is drawn.
        // The carrier is the lane's owner, not the ask's sender: a re-routed ask (ADR 545) comes from
        // whoever re-routed it (lane 01M4V774MK).
        const carrier = laneOwners.carrier(ev.lane, ev.from);
        pushThread(carrier, ev.to, toneColor('handoff'));
        if (actors.deliver(carrier, ev.to, laneSeed(ev.lane))) {
          setWalkTag(carrier, walkTag('deliver', ev.to));
        }
        break;
      }
      case 'megaphone':
        // Broadcast staging: the announcer raises a megaphone, a wave sweeps the room, and every other
        // present member gets a brief "heard it" pulse.
        pushCue(ev.from, '#f4cf52', '📣');
        pushWave(ev.from, '#f4cf52');
        for (const name of heads.keys()) if (name !== ev.from) pushCue(name, '#f4cf52', '');
        break;
      case 'accept':
        pushCue(ev.who, '#5cd49a', '✓');
        // The celebration (liveliness ladder inc 1, nick 2026-08-19): a directed accept lands on the
        // CELEBRANT — whose work was accepted — as confetti over their head, a green thread from the
        // acceptor, and the nearest desk neighbors turning for a beat. Event choreography only:
        // one cue lifetime, no re-arming, nothing for ?still to hold.
        if (ev.of && ev.of !== ev.who && heads.has(ev.of)) {
          pushThread(ev.who, ev.of, '#5cd49a');
          pushCue(ev.of, '#5cd49a', '✓');
          pushConfetti(ev.of);
          for (const name of nearestNeighbors(ev.of, 2)) {
            if (name !== ev.who) actors.gestureBeat(name, GESTURE.glance);
          }
        }
        break;
      case 'decline':
        pushCue(ev.who, '#f3776a', '');
        break;
      case 'wait':
        pushCue(ev.who, '#88a9cf', '');
        break;
      case 'resolve':
        pushCue(ev.who, '#5cd49a', '✓');
        break;
      case 'steer': {
        // Interrupt-class (ADR 103): a room-wide magenta sweep everyone feels, and — when the steer
        // names a member — an urgent redirect run over to them. If the target is gone (or it's a team
        // steer), the sweep plus a bold urgent marker at the sender carry it.
        const col = toneColor('steer');
        pushWave(ev.from, col);
        if (ev.to && actors.walk(ev.from, { kind: 'help', to: ev.to, urgent: true })) {
          setWalkTag(ev.from, walkTag('steer', ev.to));
        } else {
          pushCue(ev.from, col, '↪', true);
        }
        break;
      }
      case 'challenge': {
        // An epistemic "justify?" — a question mark over the challenger, mirrored over the challenged
        // party when it's directed. Urgent only when flagged (bolder ring + glyph then).
        const col = toneColor('challenge');
        pushCue(ev.from, col, '?', ev.urgent);
        for (const to of ev.to) pushCue(to, col, '?', ev.urgent);
        break;
      }
      case 'defer':
        // A plan mutation on a Goal — the board shifts, so it pulses out across the room in the lane
        // family rather than sitting as a single-seat cue.
        pushCue(ev.who, toneColor('lane'), '');
        pushWave(ev.who, toneColor('lane'));
        break;
    }
    lastActive = performance.now(); // arm the afterglow tail (#5) off this real act
    ensureLoop();
  }

  const onResize = () => {
    sizeCanvases();
    bake();
    if (!raf) paintResting(); // repaint the resting frame at the new size
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  const onVisibility = () => {
    // ensureLoop's own suspended/reduced guards apply — a collapsed office stays parked on tab-focus.
    if (document.visibilityState !== 'visible') {
      stopDrift(); // a hidden tab draws nothing at all, heartbeat included
      return;
    }
    reengage(); // back on screen: the loop if anything is happening, the slow breath if not
  };
  document.addEventListener('visibilitychange', onVisibility);

  refreshLightEnv(); // seat the natural-light wash + veil from the PST clock before the first bake
  sizeCanvases();
  bake();
  drawStatic();
  scheduleAmbient(); // start the idle coffee-stroll timer (no-op under reduced-motion)
  ensureDrift(); // and the slow breath, for the stretches where the loop is parked

  // Track the real PST sun: re-read the clock every minute and rebake only when the veil/lamp state moves.
  const lightTimer = setInterval(() => {
    if (refreshLightEnv()) {
      bake();
      if (!raf) paintResting();
    }
  }, LIGHT_TICK_MS);

  /**
   * Render the CURRENT scene state twice into two fresh offscreen canvases — once direct, once
   * through a fresh sprite cache — and compare the bytes. The gate
   * (`scripts/perf/scene-pixel-check.mjs`) drives this over CDP; the app never calls it.
   *
   * DEV ONLY. It is gate machinery, and a viewer must not carry it — the ADR 151 total-JS budget
   * caught exactly that, 0.3 KB over, the first time this shipped. `import.meta.env.DEV` is static
   * in a production build, so the whole body and `spriteCrops` below drop out of the bundle. The
   * gate therefore runs against `vite dev`, which paints with the same code.
   *
   * Both renders read the same poses, the same clock and the same lighting synchronously, so `t` is
   * not a confound: any difference is the cache's doing.
   */
  function spriteParity(only?: string): SpriteParity {
    const paint = (c: CanvasRenderingContext2D, o: RenderOpts = {}): void => {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      renderScene(
        c,
        fit,
        placements,
        actors.nodes(),
        actors.poses(),
        clock,
        teamName,
        lightEnv,
        pet,
        actors.sceneFx(),
        recep,
        wallBoardNow(),
        teamWorkingHours,
        o,
      );
    };
    const surface = (): CanvasRenderingContext2D => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      return c.getContext('2d')!;
    };
    const direct = surface();
    const cached = surface();
    setScenePalette(resolveScenePalette());
    paint(direct);
    paint(cached, {
      sprites: makeSpriteCache({ dpr }),
      dpr,
      ...(only !== undefined ? { spriteOnly: only } : {}),
    });
    const da = direct.getImageData(0, 0, canvas.width, canvas.height).data;
    const db = cached.getImageData(0, 0, canvas.width, canvas.height).data;
    const histogram = new Array<number>(256).fill(0);
    const cell = 120;
    const gridW = Math.ceil(canvas.width / cell);
    const gridH = Math.ceil(canvas.height / cell);
    const grid = new Array<number>(gridW * gridH).fill(0);
    const at = (i: number): { x: number; y: number; direct: number[]; sprite: number[] } => {
      const px = i / 4;
      return {
        x: px % canvas.width,
        y: Math.floor(px / canvas.width),
        direct: [...da.slice(i, i + 4)],
        sprite: [...db.slice(i, i + 4)],
      };
    };
    let differing = 0;
    let beyondRounding = 0;
    let maxDelta = 0;
    let first: SpriteParity['first'] = null;
    let worst: SpriteParity['worst'] = null;
    /*
     * Compare what is VISIBLE, which is the premultiplied pixel plus its alpha — not the raw bytes
     * `getImageData` hands back.
     *
     * Those bytes are UNPREMULTIPLIED, and unpremultiplying is unstable as alpha goes to zero: at
     * alpha 1/255 the stored colour is one 8-bit step of premultiplied value, so recovering it
     * multiplies the rounding by 255. The first run of this gate reported maxDelta 255 on 161k
     * pixels and the deltas clustered on 255, 128, 85, 64, 51, 42 — 255/n for small n, which is that
     * arithmetic and nothing else. A pixel at alpha 1 that reads [0,0,0] against [255,255,0] is the
     * same invisible pixel twice. Comparing premultiplied values is comparing what a viewer gets.
     */
    for (let i = 0; i < da.length; i += 4) {
      const aa = da[i + 3]!;
      const ab = db[i + 3]!;
      let d = Math.abs(aa - ab);
      for (let k = 0; k < 3; k++) {
        d = Math.max(
          d,
          Math.abs(Math.round((da[i + k]! * aa) / 255) - Math.round((db[i + k]! * ab) / 255)),
        );
      }
      if (d === 0) continue;
      differing++;
      histogram[d] = (histogram[d] ?? 0) + 1;
      if (d > 1) {
        beyondRounding++;
        // The map shows only what is BEYOND one step: a blit composites where the direct path does
        // not, so a one-step difference is everywhere and localizes nothing.
        const px = i / 4;
        const gx = Math.floor((px % canvas.width) / cell);
        const gy = Math.floor(Math.floor(px / canvas.width) / cell);
        grid[gy * gridW + gx] = (grid[gy * gridW + gx] ?? 0) + 1;
      }
      if (d > maxDelta) {
        maxDelta = d;
        worst = at(i);
      }
      if (!first) first = at(i);
    }
    return {
      equal: differing === 0,
      total: da.length / 4,
      differing,
      beyondRounding,
      maxDelta,
      histogram,
      first,
      worst,
      grid,
      gridW,
      gridH,
      cell,
    };
  }

  /** DEBUG (gate only): magnified crops of the same region, painted direct and through a cache. */
  function spriteCrops(cx: number, cy: number, r: number, zoom = 8): Record<string, string> {
    const paint = (o: RenderOpts = {}): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);
      renderScene(
        g,
        fit,
        placements,
        actors.nodes(),
        actors.poses(),
        clock,
        teamName,
        lightEnv,
        pet,
        actors.sceneFx(),
        recep,
        wallBoardNow(),
        teamWorkingHours,
        o,
      );
      return c;
    };
    setScenePalette(resolveScenePalette());
    const crop = (src: HTMLCanvasElement): string => {
      const c = document.createElement('canvas');
      c.width = 2 * r * zoom;
      c.height = 2 * r * zoom;
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#101014';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(src, cx - r, cy - r, 2 * r, 2 * r, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    };
    return {
      direct: crop(paint()),
      sprite: crop(paint({ sprites: makeSpriteCache({ dpr }), dpr })),
    };
  }

  /**
   * DEBUG (gate only): the whole frame, painted direct and through a fresh cache, plus a DIFF a person
   * can read — the direct frame dimmed to grey, with every pixel more than one step out painted red,
   * brighter for a bigger delta. One-step differences are left grey on purpose: a blit composites
   * where the direct path does not, so they are everywhere and localize nothing (see spriteParity).
   * DEV only, like its siblings, so it costs the viewer bundle nothing.
   */
  function spriteImages(): { direct: string; sprite: string; diff: string } {
    const paint = (o: RenderOpts = {}): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, width, height);
      renderScene(
        g,
        fit,
        placements,
        actors.nodes(),
        actors.poses(),
        clock,
        teamName,
        lightEnv,
        pet,
        actors.sceneFx(),
        recep,
        wallBoardNow(),
        teamWorkingHours,
        o,
      );
      return c;
    };
    setScenePalette(resolveScenePalette());
    const a = paint();
    const b = paint({ sprites: makeSpriteCache({ dpr }), dpr });
    const w = canvas.width;
    const h = canvas.height;
    const da = a.getContext('2d')!.getImageData(0, 0, w, h).data;
    const db = b.getContext('2d')!.getImageData(0, 0, w, h).data;
    const d = document.createElement('canvas');
    d.width = w;
    d.height = h;
    const dg = d.getContext('2d')!;
    const out = dg.createImageData(w, h);
    for (let i = 0; i < da.length; i += 4) {
      // Same premultiplied comparison as spriteParity, so the picture and the numbers agree.
      const aa = da[i + 3]!;
      const ab = db[i + 3]!;
      let delta = Math.abs(aa - ab);
      for (let k = 0; k < 3; k++) {
        delta = Math.max(
          delta,
          Math.abs(Math.round((da[i + k]! * aa) / 255) - Math.round((db[i + k]! * ab) / 255)),
        );
      }
      const grey = Math.round(
        (0.3 * da[i]! + 0.59 * da[i + 1]! + 0.11 * da[i + 2]!) * (aa / 255) * 0.35,
      );
      const red = delta > 1 ? Math.min(255, 110 + delta * 8) : 0;
      out.data[i] = red || grey;
      out.data[i + 1] = red ? 0 : grey;
      out.data[i + 2] = red ? 0 : grey;
      out.data[i + 3] = 255;
    }
    dg.putImageData(out, 0, 0);
    return {
      direct: a.toDataURL('image/png'),
      sprite: b.toDataURL('image/png'),
      diff: d.toDataURL('image/png'),
    };
  }

  ensureLoop(); // a room with anyone working is alive from the first frame (no-op under reduced-motion)

  return {
    ...(import.meta.env.DEV ? { spriteParity, spriteCrops, spriteImages, dirtyParity } : {}),
    update,
    emit,
    pulse,
    replay: (evs) => {
      if (reduced || STILL || evs.length === 0) return;
      replayPending = evs;
      ensureLoop(); // a frame drains it once someone is placed; a parked room would otherwise never start
    },
    stats: () => ({
      ticks,
      draws,
      beats,
      since,
      welcomes: welcomeRoom.started(),
      repaint: {
        px: repaintPx,
        stagePx: canvas.width * canvas.height,
        full: fullRepaints,
        partial: partialRepaints,
        skipped: skippedRepaints,
      },
    }),
    ambientLog: () => [...ambientLog],
    floorSamples: () =>
      [...actors.poses()].map(([name, p]) => ({
        name,
        lx: p.lx,
        ly: p.ly,
        walkable: walkable(p.lx, p.ly),
        hit: solidHit(p.lx, p.ly),
        sit: p.sit,
      })),
    setSettingsSpot: ({ enabled, flagged }: { enabled: boolean; flagged: boolean }) => {
      if (!hoursSpot) return;
      hoursSpot.hidden = !enabled;
      hoursSpot.classList.toggle('is-flagged', flagged);
      hoursSpot.setAttribute(
        'aria-label',
        flagged ? 'Open settings — a channel pairing waits for you' : 'Open settings',
      );
    },
    setLinked: (names: string | readonly string[] | null) => {
      // A class toggle only — the ring is CSS, so linking costs no frame (ADR 464). Several at once
      // when a Now goal row lights everyone on that goal.
      const on = new Set(names === null ? [] : typeof names === 'string' ? [names] : names);
      for (const [who, el] of labels) el.classList.toggle('is-linked', on.has(who));
    },
    setSuspended: (on: boolean) => {
      // A stream never parks (ADR 157). The broadcast route has no collapse control, so this only ever
      // fires from a host surface that shouldn't be able to freeze the outgoing frame anyway.
      if (suspendIgnored(broadcast, on)) return;
      if (on === suspended) return;
      suspended = on;
      if (on) {
        // Park the loop now — no CPU behind a collapsed panel. Ambient beats self-skip via the
        // `fireAmbient` guard; the timer keeps its cadence so nothing needs re-arming on resume.
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
        acc = 0;
        stopDrift(); // no heartbeat behind a collapsed panel either — the rule is "stop when UNSEEN"
      } else {
        // One fresh frame immediately (light + poses may have moved while parked) → instant
        // re-expand; the loop only re-engages if the room is actually alive.
        refreshLightEnv();
        bake();
        // One fresh frame NOW so the re-expand is instant — the heartbeat's first tick is 250ms out,
        // and a rAF frame is a frame away; neither is soon enough to hide behind.
        paintResting();
        reengage();
      }
    },
    pokeGesture: (kind = 1) => {
      // The only door a gesture id comes through as a plain number — `/office-preview?beat=<n>` hands
      // it straight from the URL. Everything inside is typed `IdleGesture`; this is where a number
      // becomes one, or is refused. An errand overlay (browse/fill/eat/pour/call) has no scheduler
      // window, and before this guard it reached `gestureBeat` with `dur: undefined` and froze that
      // member for the rest of the session.
      if (!isIdleGesture(kind)) return null;
      // Same path as the ambient scheduler's gesture beat, but on demand — try idle desk members until
      // one accepts (gestureBeat rejects a small/walking/already-gesturing member).
      for (const who of actors.idleDeskMembers()) {
        if (actors.gestureBeat(who, kind)) {
          ensureLoop();
          return who;
        }
      }
      return null;
    },
    pokeErrand: (kind) => {
      // The errand twin of pokeGesture: play the full fridge/water/coffee arc now, on the first idle
      // member who can (a 25s fridge sequence is unverifiable if you have to wait the scheduler out).
      // Water keeps the scheduler's own gate — the bottle comes off *their desk*, so a deskless
      // (leisure) member or a desk without the prop can't play it.
      for (const who of actors.idleDeskMembers()) {
        if (kind === 'water') {
          const pl = placements.get(who);
          if (pl?.kind !== 'desk' || !deskHasProp(pl.slot, 'water')) continue;
        }
        const played =
          kind === 'fridge'
            ? actors.errandFridge(who)
            : kind === 'water'
              ? actors.errandWater(who)
              : kind === 'phone'
                ? actors.errandPhone(who)
                : coffeeStroll(who, slotAt(Date.now()));
        if (played) {
          ensureLoop();
          return who;
        }
      }
      return null;
    },
    dispose: () => {
      disposed = true;
      sprites?.clear();
      cancelAnimationFrame(raf);
      stopDrift(); // the heartbeat outlives nothing
      clearInterval(lightTimer); // stop the PST lighting clock
      if (railTimer) clearInterval(railTimer); // stop the caption rail
      options.onCaption?.(null);
      clearInterval(welcomeTimer); // stop the receptionist welcome
      if (wagonTimer) clearInterval(wagonTimer); // stop the Welcome Wagon's off-loop clock
      if (ambientTimer) clearTimeout(ambientTimer); // stop the idle-beat scheduler
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [who, s] of [...speeches]) clearSpeech(who, s); // cancel timers + remove bubbles
      // Torn down, not finished — nothing is owed a turn. `clearSpeech` deliberately does not drain
      // (see `drainSpeech`), so the backlog is dropped here rather than replayed into a dead room.
      queued.clear();
      for (const name of plateExpand.keys()) clearExpandTimer(name);
      plateExpand.clear();
      plateRO?.disconnect();
      for (const el of labels.values()) el.remove();
      labels.clear();
      for (const t of askSettleTimers.values()) clearTimeout(t);
      askSettleTimers.clear();
      for (const c of askCards.values()) c.el.remove();
      askCards.clear();
      ambientHost.remove(); // removes the day-cycle wash, steam, and the animated desk props
      boardSpot?.remove();
      hoursSpot?.remove();
      canvas.remove();
    },
  };
}
