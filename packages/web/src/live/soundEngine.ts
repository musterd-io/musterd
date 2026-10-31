// The WebAudio engines — a tiny synth that gives every live act its own short, musical cue, and the
// room-tone bed underneath it. **This module is loaded lazily** (see the façades in `sound.ts`): it
// is the biggest thing on /live that a viewer with sound off never needs, so it is not allowed on the
// eager graph the byte budget measures (packages/web/AGENTS.md, ADR 183).
//
// No audio assets: each act is a handful of scheduled oscillator notes drawn from a consonant
// pentatonic set, so even a burst of simultaneous arrivals stays pleasant rather than noisy. The
// engines are opt-in (default OFF) and only ever build their AudioContext from the enabling click,
// which is what browser autoplay policy requires. Because the façade imports this module *from* that
// click, the context is built one microtask late — legal because activation is STICKY once the user
// has interacted, not transient, and `start`/`ensureContext` resume a context born suspended anyway.
//
// The preference keys, their persistence, and the pure logic (which event fires, under what gate,
// with what pan) all live in `sound.ts`. Nothing here reads localStorage: an engine only exists
// because a façade already decided it should be on, and told it so.

import { EMPTY_LIFE, type LifeContext } from './sound';
import {
  CHIME_BARS,
  chordBars,
  chordOffsets,
  gestureFor,
  jitterStrike,
  keyboardFor,
  keypressPlan,
  lifeGapFor,
  type Moment,
  type MomentDetail,
  rollOffsets,
  momentPan,
  panFor,
  pickLifeEvent,
  pickWorkDesk,
  shouldChime,
  chimeDelay,
  isStep,
  shouldPlayStep,
} from './soundLife';

/** One scheduled note: a frequency, a start offset (s), a length (s), a waveform, and a peak gain. */
interface Note {
  freq: number;
  /** delay from the cue's start, seconds */
  t: number;
  /** duration, seconds */
  dur: number;
  type: OscillatorType;
  gain: number;
}

// The low end of the chimes' C-major pentatonic (`CHIME_BARS`) — the stream's gestures sit under the bars.
const C4 = 261.63;
const D4 = 293.66;
const E4 = 329.63;
const G4 = 392.0;
const C5 = 523.25;

const tri: OscillatorType = 'triangle';
const sine: OscillatorType = 'sine';

/**
 * The five gestures (sound identity spec §2.3), as the stream's own cue table — one recipe per
 * gesture, keyed by gesture not act; `gestureFor` maps an act onto one, and the acts it maps to
 * null (message, status_update, wait, defer, resolve, end) are silent here by design: the office
 * shows them and the eye is enough. All in the chimes' pentatonic scale, so a cue beside a chord
 * is consonant. `done` is not in this table: a lane done is the shelf chimes (a bar voice), and
 * `chime('accept')` strikes a bar below.
 */
/** Exported for the sound tests only — the engine is the one reader. */
/**
 * Recorded takes (ADR 776, lane 01M67CQQQK): short CC0 clips from BigSoundBank, trimmed and mono, one
 * or more per voice as `sounds/office-sound-<voice>-<n>.mp3`. Only URLs live in this chunk; the bytes
 * are fetched when the room tone starts, and a voice falls back to its synth recipe until they land.
 */
const SAMPLE_URLS = import.meta.glob('./sounds/office-sound-*.mp3', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const TAKES: Record<string, string[]> = {};
for (const [path, url] of Object.entries(SAMPLE_URLS)) {
  const m = /office-sound-([a-z]+)-\d+\.mp3$/.exec(path);
  if (m) (TAKES[m[1]!] ??= []).push(url);
}
/** Each take's level on the LIFE bus, matched to the peak of the synth voice it replaces (measured on
 *  the soundboard render, 2026-10-30), so swapping the source did not also change the mix. */
const TAKE_GAIN: Record<string, number> = {
  door: 0.0069,
  sip: 0.018,
  eat: 0.021,
  bark: 0.037, // -6 dB (nick, 2026-10-30: too loud)
  pant: 0.012, // a breath, not a bark: ~5 dB under it at the clip's higher peak (-5 dBFS vs -12)
  jingle: 0.041,
  nameplate: 0.0073,
  board: 0.011,
};

export const CUES: Record<string, Note[]> = {
  // A question: two notes rising a fourth, the second held, unresolved — the bell on the asked desk.
  question: [
    { freq: G4, t: 0, dur: 0.26, type: sine, gain: 0.09 },
    { freq: C5, t: 0.13, dur: 0.7, type: sine, gain: 0.09 },
  ],
  // A redirect: one low note damped short, the mallet's thud left in. The one allowed to be tense.
  redirect: [{ freq: C4, t: 0, dur: 0.12, type: tri, gain: 0.09 }],
  // Passing hands: one note here, the answer a third up over there, 300 ms later.
  // The answer's 0.3 s stands only on the stream; the room emits the two notes as separate moments
  // (`handoffSend` / `handoffAnswer`, inc 2) and the engine strips the offset there.
  handoff: [
    { freq: E4, t: 0, dur: 0.34, type: sine, gain: 0.08 },
    { freq: G4, t: 0.3, dur: 0.5, type: sine, gain: 0.08 },
  ],
  // An arrival: two bars up on the door cousin. (Departure is the same two down, scene-only.)
  arrive: [
    { freq: D4, t: 0, dur: 0.5, type: sine, gain: 0.07 },
    { freq: E4, t: 0.09, dur: 0.8, type: sine, gain: 0.07 },
  ],
};
/**
 * Broadcast master gain, linear — the ADR 228 §1.6 calibration number, measured not guessed.
 *
 * The engines are tuned for headphones at a desk, and rendered through the real hosted pipeline
 * (Fly performance-4x, null sink → ffmpeg aac, 2026-08-04) the whole mix integrated at
 * **−42.8 LUFS (LRA 1.8 LU)** — real audio, ~25 dB under where even deliberate ambience should sit
 * on a stream; a viewer at normal volume hears roughly nothing. ×4 (+12 dB) lands the bed near
 * −30 LUFS: clearly audible, still unmistakably background (this is ambience, not program — do NOT
 * normalize it toward −14 LUFS speech loudness). Retune HERE, never by scattering factors through
 * the synths — the LIFE_GAIN lesson. /live is untouched: this applies only via enableForBroadcast.
 */
const BROADCAST_MASTER_GAIN = 4;

/**
 * The bar voice — the one instrument of the musterd layer (sound identity spec §2.2). A struck bar:
 * a sine fundamental, one inharmonic partial at ×2.76 (what makes it a bar and not a keyboard
 * preset), a breath of lowpassed noise for the mallet, soft 8 ms attack, a 1.5–2.5 s decay. Every
 * strike is jittered (±4 cents, ±8 % gain, ±15 % decay) so no two are bit-identical. Shared by both
 * engines: the stream's `chime('accept')` and the room's `laneDone`/`goalDone` are the same bars.
 */
function strikeBar(ctx: AudioContext, out: AudioNode, at: number, freq: number, gain: number, decay: number): void {
  const s = jitterStrike(freq, gain, decay);
  const voice = (f: number, g: number, d: number, type: OscillatorType) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(g, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + d);
    o.connect(env).connect(out);
    o.start(at);
    o.stop(at + d + 0.05);
  };
  voice(s.freq, s.gain, s.decay, 'sine');
  voice(s.freq * 2.76, s.gain * 0.22, s.decay * 0.35, 'sine');
  // the mallet: a 30 ms breath of low noise, well under the tone
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(s.gain * 0.3, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
  src.connect(lp).connect(g).connect(out);
  src.start(at);
  src.stop(at + 0.05);
}

export class FirehoseSound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Throttle the cues (broadcast only — /live's tuning is unchanged and out of scope). */
  private throttled = false;
  private lastCueAt = -Infinity;
  /** Applied to the master bus when the graph is (re)built — see BROADCAST_MASTER_GAIN. */
  private masterScale = 1;

  /** Toggle sound. The façade owns the preference and its persistence; this is the audio half. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.ensureContext();
  }

  /**
   * Turn sound on for a capture. `/broadcast` only (ADR 228).
   *
   * Separate from `setEnabled` deliberately, rather than a `persist?: boolean` parameter: a stream
   * source must never rewrite the preference a human set on this machine, and the call site should
   * say so in its own name (the façade is what holds that line).
   */
  enableForBroadcast(): void {
    this.enabled = true;
    this.throttled = true;
    this.masterScale = BROADCAST_MASTER_GAIN;
    this.ensureContext();
    if (this.master) this.master.gain.value = 0.85 * this.masterScale;
  }

  private ensureContext(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      // master bus → gentle lowpass for warmth → speakers
      const master = this.ctx.createGain();
      master.gain.value = 0.85 * this.masterScale;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3600;
      master.connect(lp).connect(this.ctx.destination);
      this.master = master;
    }
    // A context created/resumed off a click starts running; resume() covers an auto-suspended one.
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Play the cue for an act. No-op unless enabled and the audio graph is live. */
  chime(act: string): void {
    if (!this.enabled) return;
    if (this.throttled) {
      const now = Date.now();
      if (!shouldChime(now, this.lastCueAt)) return;
      this.lastCueAt = now;
    }
    this.ensureContext();
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running') return;
    const gesture = gestureFor(act);
    if (gesture === null) return; // folded into the room (§2.4): the office shows it
    if (gesture === 'done') {
      strikeBar(ctx, master, ctx.currentTime + 0.005, CHIME_BARS[5]!, 0.09, 1.8);
      return;
    }
    const notes = CUES[gesture]!;
    const start = ctx.currentTime + 0.005;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      const g = ctx.createGain();
      const t0 = start + n.t;
      // Click-free envelope: fast attack, exponential decay to (near) silence.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
      osc.connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + n.dur + 0.03);
    }
  }
}

/** Process-wide singleton, reached only through the `firehoseSound` façade in `sound.ts`. */
export const firehoseEngine = new FirehoseSound();

// ── room tone ────────────────────────────────────────────────────────────────────────────────────
//
// The sound of the office *being there*, as opposed to the sound of things happening in it. It is a
// separate engine behind a separate switch because it answers a different question: the act cues
// above tell you something arrived, this one tells you the room is inhabited. Somebody who wants a
// quiet room with audible arrivals — or a lived-in room with no pings — should get exactly that, and
// one toggle cannot serve both.
//
// Synthesised, like the cues: no audio assets, so it costs the byte budget nothing but the code (the
// packages/web perf contract). Three layers, from continuous to sparse:
//
//   1. AIR — filtered noise, the building's ventilation. The bed everything else sits on.
//   2. HUM  — a pair of very low, slightly detuned sines. Below conscious hearing on laptop speakers
//             and clearly missing when you take it away, which is exactly what room tone is.
//   3. LIFE — the sparse events: a run of keys somewhere, a murmured exchange too far away to parse,
//             a mug set down, a chair, the odd chat-app ping at someone else's desk. These are what
//             make it an OFFICE rather than an air conditioner. Every one of them is parameter-
//             jittered per play — a loop you can predict is a loop you will turn off within the hour.
//
// It is quiet on purpose ("light ambient office noise" — nick, 2026-07-28), and it stops dead on a
// hidden tab: an idle cost is paid by every viewer forever, and one left running in a background tab
// is the most annoying possible version of this feature.

/** Ceiling on the whole bed. Low enough to sit under a podcast, loud enough to miss when it stops. */
const ROOM_GAIN = 0.075;
// The gap between sparse events now lives in sound.ts (`LIFE_GAP` / `lifeGapFor`): it scales with
// work density, and the scaling is logic the tests hold still without an AudioContext.
/**
 * Makeup gain on the whole LIFE layer, and the reason it needs one.
 *
 * Every life event is band-limited noise: a bandpass on white noise throws away all but a sliver of
 * the spectrum, so its envelope value (`0.07` for a keystroke) multiplies a signal that is *already*
 * 20–40 dB down. The AIR bed is a wide 380 Hz lowpass, where most of the energy survives. Written
 * without compensation the two layers are not on the same scale at all, and the first version of this
 * feature shipped inaudible: rendered offline through this exact graph, the bed peaked at −35 dBFS
 * while a keystroke peaked at −58.9 and a murmured syllable at −75.5 — 24 and 40 dB *under* the
 * ventilation that was supposed to sit behind them (nick, 2026-07-29: "im not sure if I hear any of
 * the added life audio"). They were there; the bed was burying them.
 *
 * So the layer gets its own bus and the per-event gains stay *relative* (a keystroke louder than a
 * mug, a mug louder than nothing), with this one number carrying the makeup. Retune the layer here,
 * never by scattering factors through five synths. Target: events peak a few dB ABOVE the bed, which
 * is what a foreground sound in a real room does.
 *
 * As re-measured through the same offline graph, peaks against a −33.7 dBFS bed: keystroke −25,
 * murmur −25, chime −30, mug −30, creak −31. **Those readings carry about ±3 dB** — each render draws
 *
 * 2026-07-30, typing rebuild: re-rendered through the same chain shapes (stereo OfflineAudioContext,
 * so absolute numbers shifted — the bed read −40.2 in that render; only the DELTAS are comparable).
 * The old single-transient keystroke sat **+13.5 dB over the bed**, which was the "too loud". The
 * two-transient press now lands at bed +0.4 (thock) and +1.3 (release click) — at the bed, which is
 * where a keyboard three desks away belongs. The new events reuse the existing shapes at or below
 * the old mug/creak envelope numbers and inherit this calibration.
 * a fresh random noise buffer, and the peak of a narrowband noise burst wanders that much. A control
 * sweep confirmed the harness itself tracks gain at ~6 dB per doubling, so differences of that order
 * are real and anything smaller is not. Do not tune this layer to a finer resolution than that.
 */
const LIFE_GAIN = 34;


/** The whoosh's length, seconds — `--lc-dur-5` (600ms), the `lc-trace-draw` timing, so the pan
 *  sweep lands with the visual (E4 spec: one number, pinned). */
const WHOOSH_S = 0.6;

export class RoomTone {
  enabled = false;
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  /** The LIFE layer's own bus (see `LIFE_GAIN`) — sparse events land here, never straight on `bus`. */
  private lifeBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;
  /** Broadcast mode — see `enableForBroadcast`. Set before `start()`, never cleared. */
  private broadcast = false;
  /** What the scene last told us about who is near whom. Starts empty: an empty office is quiet. */
  private occupancy: LifeContext = EMPTY_LIFE;
  /** When the last milestone moment played — the E3 burst throttle's clock. */
  private lastMomentAt = -Infinity;
  private lastStepAt = -Infinity;
  /** Decoded recorded takes by voice (ADR 776); empty until `loadTakes` resolves. */
  private takes = new Map<string, AudioBuffer[]>();
  private takesLoading = false;


  /** Toggle the bed. The façade owns the preference and its persistence; this is the audio half. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.start();
    else this.stop();
  }

  /**
   * Turn the bed on for a capture, without the visibility gate (ADR 228).
   *
   * The gate exists so a bed left running in a background tab is not the most annoying possible
   * version of this feature. A capture box has no tab and no listener whose attention could wander
   * — it is the same reason broadcast already ignores `prefers-reduced-motion`. Non-theoretical:
   * headless and embedded Chrome surfaces have been observed reporting `document.hidden === true`
   * for their whole lifetime, which would suspend the bed for the entire stream.
   */
  enableForBroadcast(): void {
    this.broadcast = true;
    this.enabled = true;
    this.start();
  }

  /** The viewer asked for sound in a background tab too (the /live button's third state). */
  private background = false;

  /** Lift or restore the hidden-tab gate, and act on it now — the tab may already be hidden. */
  setBackground(on: boolean): void {
    this.background = on;
    this.onVisibility();
  }

  /** Visibility, as broadcast (or a viewer who chose background sound) sees it: never hidden. */
  private isHidden(): boolean {
    return !this.broadcast && !this.background && document.hidden;
  }

  /** The scene pushes who is near whom (and where the dog is). One-way by design — see LifeContext. */
  setOccupancy(ctx: LifeContext): void {
    this.occupancy = ctx;
  }

  private start(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.loadTakes(this.ctx);
    if (this.bus) return; // already built and running

    const ctx = this.ctx;
    const bus = ctx.createGain();
    // Faded in over a second and a half. Room tone that snaps on announces itself as an effect; the
    // whole illusion is that it was always there and you only just noticed.
    bus.gain.setValueAtTime(0.0001, ctx.currentTime);
    // The broadcast master gain rides the same bed ramp — one number, applied at the one bus.
    bus.gain.exponentialRampToValueAtTime(
      ROOM_GAIN * (this.broadcast ? BROADCAST_MASTER_GAIN : 1),
      ctx.currentTime + 1.5,
    );
    bus.connect(ctx.destination);
    this.bus = bus;

    // 1 · AIR. One second of noise on a loop, rolled off hard — what is left after a lowpass this low
    // has no seam to hear, so a one-second buffer does the work of a recorded minute.
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuffer(ctx);
    air.loop = true;
    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = 380;
    airLp.Q.value = 0.4;
    const airGain = ctx.createGain();
    // Turned down from 0.5 (nick, 2026-07-29: "turn down the ambient white noise slightly") — the
    // ventilation recedes to a bed and the LIFE events above it carry the room instead.
    airGain.gain.value = 0.34;
    air.connect(airLp).connect(airGain).connect(bus);
    air.start();
    this.sources.push(air);

    // A slow swell across the bed, so the ventilation breathes instead of sitting at one level. Well
    // under a cycle a minute: perceptible as life, never as a wobble.
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.03;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0.12;
    swell.connect(swellDepth).connect(airGain.gain);
    swell.start();
    this.sources.push(swell);

    // 2 · HUM. Two low sines a few cents apart — the beat between them is the "big room" cue, and it
    // is the detune doing that work, not the pitch.
    for (const [f, g] of [
      [57.5, 0.1],
      [58.9, 0.08],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = ctx.createGain();
      gain.gain.value = g;
      osc.connect(gain).connect(bus);
      osc.start();
      this.sources.push(osc);
    }

    // 3 · LIFE, on its own bus so the band-limited events can be lifted clear of the wideband bed.
    const lifeBus = ctx.createGain();
    lifeBus.gain.value = LIFE_GAIN;
    lifeBus.connect(bus);
    this.lifeBus = lifeBus;
    this.armLife();

    // A bed left playing to a tab nobody is looking at is the worst version of this feature.
    // (A broadcast capture has no watcher to gate on, so it never registers the listener at all.)
    if (!this.watching && !this.broadcast) {
      this.watching = true;
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    // `visibilitychange` only fires on a CHANGE, so the listener alone never catches the case where
    // the tab is *already* hidden when the bed starts — a preference restored on a background tab,
    // or a viewer who switched away between the click and the context opening. Check the state we
    // are actually in, rather than waiting for it to be announced.
    if (this.isHidden()) void ctx.suspend();
  }

  private onVisibility = (): void => {
    if (!this.ctx || !this.enabled) return;
    if (this.isHidden()) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    // Fade out before tearing down, or the whole bed ends on a click.
    const end = ctx.currentTime + 0.7;
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setValueAtTime(Math.max(bus.gain.value, 0.0001), ctx.currentTime);
    bus.gain.exponentialRampToValueAtTime(0.0001, end);
    const sources = this.sources;
    this.sources = [];
    this.bus = null;
    this.lifeBus = null;
    for (const s of sources) s.stop(end + 0.05);
    setTimeout(() => bus.disconnect(), 900);
  }

  /** One second of white noise, built once and reused by every layer that needs a hiss. */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /**
   * A placed room milestone (E3): fanfare at the celebrant, the door opening, an ask's weight.
   * On the LIFE bus so it inherits the bed's calibration; throttled so a burst of accepts plays
   * once (dropped, never queued); the ×0.75 stereo squeeze happens HERE and nowhere else —
   * `pan` arrives raw [-1, 1] from `screenPan` at the emit site.
   */
  moment(name: Moment, pan: number, panTo?: number, detail?: MomentDetail): void {
    const ctx = this.ctx;
    const bus = this.lifeBus;
    if (!ctx || !bus || ctx.state !== 'running' || this.isHidden()) return;
    const now = Date.now();
    if (isStep(name)) {
      if (!shouldPlayStep(now, this.lastStepAt)) return;
      this.lastStepAt = now;
    } else {
      const delay = chimeDelay(name, now, this.lastMomentAt);
      if (delay === null) return;
      this.lastMomentAt = now + delay;
      if (delay > 0) {
        // a chime behind another: queued a beat back, never dropped (lane 01M625KHCN)
        setTimeout(() => this.voice(name, pan, panTo, detail), delay);
        return;
      }
    }
    this.voice(name, pan, panTo, detail);
  }

  /** Play `name` now — the half of `moment` after the gate. */
  private voice(name: Moment, pan: number, panTo?: number, detail?: MomentDetail): void {
    const ctx = this.ctx;
    const bus = this.lifeBus;
    if (!ctx || !bus || ctx.state !== 'running') return;
    const panNode = ctx.createStereoPanner?.();
    const out = panNode ?? ctx.createGain();
    if (panNode) panNode.pan.value = momentPan(pan);
    // The whoosh is the one voice that animates its pan node: it sweeps toward `panTo` over the
    // trace's own duration, so ear and eye arrive together (E4 spec). Other voices ignore panTo.
    if (panNode && name === 'whoosh' && panTo !== undefined) {
      panNode.pan.setValueAtTime(momentPan(pan), ctx.currentTime + 0.02);
      panNode.pan.linearRampToValueAtTime(momentPan(panTo), ctx.currentTime + 0.02 + WHOOSH_S);
    }
    out.connect(bus);
    setTimeout(() => out.disconnect(), 4000);
    switch (name) {
      case 'door': return this.doorMoment(ctx, out);
      case 'whoosh': return this.whoosh(ctx, out); // welcome wagon foley only (inc 3)
      case 'plateOpen': return this.plateTick(ctx, out, true);
      case 'plateClose': return this.plateTick(ctx, out, false);
      case 'boardOpen': return this.boardPaper(ctx, out, true);
      case 'boardClose': return this.boardPaper(ctx, out, false);
      case 'ring': return this.ring(ctx, out);
      case 'ratchet': return this.ratchet(ctx, out);
      case 'rattle': return this.rattle(ctx, out);
      case 'doorbell': return this.cueNotes(ctx, out, CUES['arrive']!, 0.014); // retuned: the door cousin
      case 'pop': return this.pop(ctx, out);
      // sound tied to motion (lane 01M5XS6KAD)
      case 'stepPlank': return this.click(ctx, out, ctx.currentTime + 0.01, 110 + Math.random() * 50, 0.05, 0.07);
      case 'stepTile': return this.click(ctx, out, ctx.currentTime + 0.01, 1300 + Math.random() * 500, 0.035, 0.04);
      case 'creak': return this.creak(ctx, out);
      case 'sipAt': return this.sip(ctx, out, 1);
      case 'bottle': return this.sip(ctx, out, 0.72);
      case 'eatAt': return this.eating(ctx, out);
      case 'machine': return this.machine(ctx, out);
      // the musterd voice (sound identity spec §2.2–2.3)
      case 'laneDone': return this.laneDone(ctx, out, detail);
      case 'goalDone': return this.goalDone(ctx, out);
      case 'question': return this.cueNotes(ctx, out, CUES['question']!, 0.018);
      case 'redirect': return this.cueNotes(ctx, out, CUES['redirect']!, 0.02);
      case 'handoffSend': return this.cueNotes(ctx, out, [CUES['handoff']![0]!], 0.016);
      case 'handoffAnswer': return this.cueNotes(ctx, out, [{ ...CUES['handoff']![1]!, t: 0 }], 0.016);
      case 'arrive': return this.cueNotes(ctx, out, CUES['arrive']!, 0.014);
      case 'leave': return this.cueNotes(ctx, out, [...CUES['arrive']!].reverse().map((n, i) => ({ ...n, t: i * 0.09 })), 0.014);
      default: {
        // Every Moment has a voice: a name added to the union without one fails to compile here.
        const unvoiced: never = name;
        return unvoiced;
      }
    }
  }

  /** A lane done: one bar of the shelf chimes, or a small rolled chord sized by the lane's chain.
   *  The bar is the lane's own (`barForLane` at the emit site); the chord climbs from it. ~3× a
   *  keystroke: a struck bar across a room. */
  private laneDone(ctx: AudioContext, out: AudioNode, detail?: MomentDetail): void {
    const bar = detail?.bar ?? 5;
    const voices = detail?.voices ?? 1;
    const bars = chordBars(bar, voices);
    const offsets = chordOffsets(voices);
    const t0 = ctx.currentTime + 0.02;
    bars.forEach((b, i) => strikeBar(ctx, out, t0 + offsets[i]!, CHIME_BARS[b]!, 0.022, 1.8)); // 0.03 → 0.022 (inc 3, measured +13 dB over keys; ~+10 now)
  }

  /** A goal done: the whole scale rolled once, bottom to top, the top bar allowed to ring out. The
   *  only time all eight sound, and the loudest thing the room ever plays. */
  private goalDone(ctx: AudioContext, out: AudioNode): void {
    const offsets = rollOffsets();
    const t0 = ctx.currentTime + 0.02;
    // 0.028 / 0.034 → 0.02 / 0.024 (inc 3): the roll measured +21 dB over a keystroke; ~+18 now.
    CHIME_BARS.forEach((f, i) => strikeBar(ctx, out, t0 + offsets[i]!, f, i === CHIME_BARS.length - 1 ? 0.024 : 0.02, i === CHIME_BARS.length - 1 ? 2.6 : 1.6));
  }

  /** A gesture's notes played as a placed desk bell on the LIFE bus: the recipe's shape at the
   *  room's scale (`peak` is the sine's envelope on this bus — 0.018 is the old askbell's). */
  private cueNotes(ctx: AudioContext, out: AudioNode, notes: readonly Note[], peak: number): void {
    const top = Math.max(...notes.map((n) => n.gain));
    const start = ctx.currentTime + 0.02;
    for (const n of notes) {
      const s = jitterStrike(n.freq, (n.gain / top) * peak, n.dur);
      const osc = ctx.createOscillator();
      osc.type = n.type;
      osc.frequency.value = s.freq;
      const g = ctx.createGain();
      const t0 = start + n.t;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(s.gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.decay);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + s.decay + 0.03);
    }
  }

  /** The front-desk phone (lane 01M3F81DD9): a two-tone trill, twice. Quiet — it is across the room. */
  private ring(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 6; i++) {
        const t = t0 + r * 0.42 + i * 0.045;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(i % 2 ? 1180 : 940, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.018, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.05);
      }
    }
  }

  /** The label maker: three ratchet clicks, the last one lower — ka-chunk. */
  private ratchet(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.01;
    [1400, 1320, 760].forEach((f, i) => this.click(ctx, out, t0 + i * 0.07, f, 0.03, 0.04));
  }

  /** Small wheels on a wooden floor: a short run of soft, uneven ticks. */
  private rattle(ctx: AudioContext, out: AudioNode): void {
    let t = ctx.currentTime + 0.01;
    for (let i = 0; i < 9; i++) {
      this.click(ctx, out, t, 300 + Math.random() * 120, 0.012, 0.03);
      t += 0.09 + Math.random() * 0.03;
    }
  }


  /** A chair taking (or losing) somebody's weight (lane 01M5XS6KAD): a narrow noise band gliding
   *  down over 0.4 s, at a third of the gain the timer creak had — it lands on a visible sit, which is
   *  what keeps it from reading as a cue (see LIFE_EVENTS' removal note). */
  private creak(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 7;
    bp.frequency.setValueAtTime(520, t0);
    bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.45);
  }

  /** The espresso machine at the island (lane 01M5XS6KAD; re-voiced 2026-10-30, lane 01M65FSKR7).
   *  The first voice — a steady 58 Hz sawtooth under a flat 2.4 kHz hiss — was mains hum and
   *  tape hiss, the sound of a bad A/V cable (nick: "too much like some a/v static"). A machine is
   *  made of events, not a held tone: the switch clunks, a vibratory pump buzzes in pulses and
   *  labours up a little as the pressure builds, coffee trickles into the cup, and it ends on a
   *  few drips. Nothing in it is steady, which is what keeps it from reading as noise on the line. */
  private machine(ctx: AudioContext, out: AudioNode): void {
    // Every level halved, -6 dB (nick, 2026-10-30: too loud).
    const t0 = ctx.currentTime + 0.02;
    const pumpOn = t0 + 0.12;
    const pumpOff = t0 + 1.9;
    // 1 · the switch: one low clunk, then the pump answers it.
    this.click(ctx, out, t0, 210, 0.025, 0.07);
    // 2 · the pump: a buzzing square in the body's band (not the 50/60 Hz floor a hum lives on),
    //     beaten by a fast tremolo so it rattles instead of droning, and rising slightly under load.
    const pump = ctx.createOscillator();
    pump.type = 'square';
    pump.frequency.setValueAtTime(96, pumpOn);
    pump.frequency.linearRampToValueAtTime(112, pumpOff);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = 420;
    body.Q.value = 1.4;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.0001, pumpOn);
    pg.gain.exponentialRampToValueAtTime(0.015, pumpOn + 0.08);
    pg.gain.setValueAtTime(0.015, pumpOff - 0.12);
    pg.gain.exponentialRampToValueAtTime(0.0001, pumpOff);
    const rattle = ctx.createOscillator();
    rattle.frequency.value = 13;
    const depth = ctx.createGain();
    depth.gain.value = 0.006; // ±40% of the pump's level: a rattle, not a vibrato
    rattle.connect(depth).connect(pg.gain);
    pump.connect(body).connect(pg).connect(out);
    pump.start(pumpOn);
    rattle.start(pumpOn);
    pump.stop(pumpOff + 0.05);
    rattle.stop(pumpOff + 0.05);
    // 3 · the pour: a thin trickle — narrow, low-mid, wobbling — that starts once the pump has
    //     built pressure and stops a moment after it.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const stream = ctx.createBiquadFilter();
    stream.type = 'bandpass';
    stream.frequency.value = 1100;
    stream.Q.value = 4;
    const sg = ctx.createGain();
    const pourOn = t0 + 0.55;
    sg.gain.setValueAtTime(0.0001, pourOn);
    sg.gain.exponentialRampToValueAtTime(0.007, pourOn + 0.25);
    sg.gain.setValueAtTime(0.007, pumpOff - 0.1);
    sg.gain.exponentialRampToValueAtTime(0.0001, pumpOff + 0.15);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 5.5;
    const wd = ctx.createGain();
    wd.gain.value = 180; // the stream's pitch wanders ±180 Hz — liquid, not a fixed band
    wobble.connect(wd).connect(stream.frequency);
    src.connect(stream).connect(sg).connect(out);
    src.start(pourOn);
    wobble.start(pourOn);
    src.stop(pumpOff + 0.2);
    wobble.stop(pumpOff + 0.2);
    // 4 · the drips: a few short rising blips after the pump stops, spaced out like the last of
    //     the cup — the cue that it was liquid all along.
    for (const [dt, f] of [
      [0.12, 820],
      [0.42, 980],
      [0.85, 760],
    ] as const) {
      const at = pumpOff + dt;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 1.6, at + 0.04);
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.0001, at);
      dg.gain.exponentialRampToValueAtTime(0.0035, at + 0.006);
      dg.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      o.connect(dg).connect(out);
      o.start(at);
      o.stop(at + 0.08);
    }
  }

  /** The confetti pop: one bright click, then a sparkle of three high ticks. */
  private pop(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.01;
    this.click(ctx, out, t0, 900, 0.05, 0.05);
    for (let i = 0; i < 3; i++) this.click(ctx, out, t0 + 0.08 + i * 0.05, 2600 + i * 400, 0.01, 0.02);
  }

  /** Fetch and decode every recorded take once. A failure leaves that voice on its synth recipe. */
  private loadTakes(ctx: BaseAudioContext): void {
    if (this.takesLoading) return;
    this.takesLoading = true;
    for (const [voice, urls] of Object.entries(TAKES)) {
      void Promise.all(
        urls.map((u) =>
          fetch(u)
            .then((r) => r.arrayBuffer())
            .then((b) => ctx.decodeAudioData(b)),
        ),
      )
        .then((bufs) => this.takes.set(voice, bufs))
        .catch(() => {});
    }
  }

  /** Play one recorded take of `voice`, picked at random and nudged in pitch so repeats differ.
   *  False when no take is loaded, so the caller plays its synth recipe instead. */
  private take(ctx: AudioContext, out: AudioNode, voice: string, scale = 1): boolean {
    const bufs = this.takes.get(voice);
    if (!bufs?.length) return false;
    const src = ctx.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)]!;
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const g = ctx.createGain();
    g.gain.value = (TAKE_GAIN[voice] ?? 0.01) * scale;
    src.connect(g).connect(out);
    src.start(ctx.currentTime + 0.01);
    return true;
  }

  /** A nameplate under the viewer's own hand (E4): one felt-pad tick, pitched a touch up on open
   *  and down on close — siblings, not twins. Closer than the room, so smaller than the room. */
  private plateTick(ctx: AudioContext, out: AudioNode, open: boolean): void {
    if (this.take(ctx, out, 'nameplate', open ? 1 : 0.8)) return;
    const base = open ? 640 : 480;
    this.click(ctx, out, ctx.currentTime + 0.01, base * (0.94 + Math.random() * 0.12), 0.035, 0.05);
  }

  /** The board overlay (E4): a brief paper swell — rising on open, falling and shorter on close. */
  private boardPaper(ctx: AudioContext, out: AudioNode, open: boolean): void {
    if (this.take(ctx, out, 'board', open ? 1 : 0.8)) return;
    const t0 = ctx.currentTime + 0.02;
    const dur = open ? 0.28 + Math.random() * 0.08 : 0.18 + Math.random() * 0.06;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(open ? 700 : 1100, t0);
    bp.frequency.exponentialRampToValueAtTime(open ? 1200 : 600, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.03, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }



  /** The welcome wagon's toss (welcomeRoom; the directed-act whoosh left in inc 3): lowpassed air with a gentle arc over the trace's 600ms, its pan
   *  swept by `moment` above. Quiet by design — it accompanies a line, it is not the line. */
  private whoosh(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t0);
    lp.frequency.exponentialRampToValueAtTime(1900 + Math.random() * 400, t0 + WHOOSH_S * 0.55);
    lp.frequency.exponentialRampToValueAtTime(500, t0 + WHOOSH_S);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.026, t0 + WHOOSH_S * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + WHOOSH_S);
    src.connect(lp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + WHOOSH_S + 0.03);
  }
  /** The door (E3): a low latch click, the closer arm's short sigh, then a few steps from that side. */
  private doorMoment(ctx: AudioContext, out: AudioNode): void {
    if (this.take(ctx, out, 'door')) return;
    const t0 = ctx.currentTime + 0.02;
    // Halved (inc 3): the door is foley under the arrive/leave cousin now, −6 dB across the board.
    this.click(ctx, out, t0, 320 + Math.random() * 120, 0.04, 0.05); // the latch
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t0 + 0.08);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.022, t0 + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55); // the closer's sigh
    src.connect(lp).connect(g).connect(out);
    src.start(t0 + 0.08);
    src.stop(t0 + 0.6);
    let at = t0 + 0.45;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
      this.click(ctx, out, at, 110 + Math.random() * 60, 0.035, 0.07); // steps from the door's side
      at += 0.4 + Math.random() * 0.12;
    }
  }


  /** Schedule the next sparse event, and re-arm from it. One timer, always. The gap tightens with
   *  work density — a full sprint hums about twice as often as a quiet room (E2 spec §4). */
  private armLife(): void {
    clearTimeout(this.timer);
    const [lo, hi] = lifeGapFor(this.occupancy.density);
    const wait = lo + Math.random() * (hi - lo);
    this.timer = setTimeout(() => {
      if (this.bus && this.ctx?.state === 'running' && !this.isHidden()) this.life();
      this.armLife();
    }, wait * 1000);
  }

  /** Pick one of the room's small noises and play it, somewhere off to one side. */
  private life(): void {
    const ctx = this.ctx;
    const bus = this.lifeBus;
    if (!ctx || !bus) return;
    // Placed across the stereo field, never dead centre: everything in an office happens at somebody
    // else's desk, and a sound in the middle of your head is a sound you made.
    const now = Date.now();
    const name = pickLifeEvent(Math.random(), this.occupancy, now);
    if (name === null) return; // nothing the room could honestly make a sound of
    const pan = ctx.createStereoPanner?.();
    const out = pan ?? ctx.createGain();
    // Positioned events pan to where they are on screen: work sounds to the working desk that makes
    // them (E2 spec §3), chatter to the pair, the dog to the dog; the rest land somewhere off to one
    // side, the way the layer always has.
    const desk = pickWorkDesk(name, Math.random(), this.occupancy, now);
    const at = desk ? desk.x * 0.75 : panFor(name, this.occupancy);
    if (pan) pan.pan.value = at ?? (Math.random() * 2 - 1) * 0.75;
    out.connect(bus);
    // Long enough for the longest murmur or typing run to finish before its channel goes away.
    setTimeout(() => out.disconnect(), 9000);

    // Every branch jitters its own parameters, so even the same event twice in a row never plays the
    // same twice (nick, 2026-07-29: "very dynamic and variable so they don't get old").
    switch (name) {
      case 'keys': return this.keys(ctx, out, desk?.seed);
      case 'murmur': return this.murmur(ctx, out, false);
      case 'whisper': return this.murmur(ctx, out, true);
      case 'tap': return this.tap(ctx, out, 0.9);
      case 'softTap': return this.tap(ctx, out, 0.35);
      case 'stapler': return this.stapler(ctx, out);
      case 'drawer': return this.drawer(ctx, out);
      case 'footsteps': return this.footsteps(ctx, out);
      case 'sip': return this.sip(ctx, out, 1);
      case 'water': return this.sip(ctx, out, 0.72);
      case 'blow': return this.blow(ctx, out);
      case 'eating': return this.eating(ctx, out);
      case 'paws': return this.paws(ctx, out);
      case 'jingle': return this.jingle(ctx, out);
      case 'yawn': return this.blow(ctx, out, true);
      case 'bark': return this.bark(ctx, out);
      case 'pant': return this.pant(ctx, out);
      case 'nightair': return this.nightair(ctx, out);
    }
  }

  /** Somebody typing, a few desks away: a run of keypresses at a human, uneven rate. Sometimes a
   *  quick flurry, sometimes a long thought typed out — with a thinking pause in the middle of the
   *  long ones. A uniform run is what the ear learns first. One `Keyboard` per run (see
   *  `keyboardFor`), two transients per key (see `keypressPlan`) — and the whole thing sits at the
   *  bed's level now, not 9 dB over it, which was the "too loud" half of the complaint. */
  private keys(ctx: AudioContext, out: AudioNode, deskSeed?: number): void {
    // A placed burst plays the desk's own keyboard (E2 spec §3) — the same seed every time, so a
    // desk sounds like itself across bursts. An unplaced one draws a stranger's, as it always has.
    const kb = keyboardFor(deskSeed ?? Math.floor(Math.random() * 0xffffffff));
    const long = Math.random() < 0.3;
    const n = long ? 14 + Math.floor(Math.random() * 12) : 4 + Math.floor(Math.random() * 9);
    const pauseAt = long ? 5 + Math.floor(Math.random() * (n - 8)) : -1;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      for (const tr of keypressPlan(kb)) {
        this.click(ctx, out, at + tr.at, tr.freq * (0.94 + Math.random() * 0.12), tr.gain, tr.dur);
      }
      at += 0.055 + Math.random() * 0.075; // the jitter IS the humanity
      if (i === pauseAt) at += 0.5 + Math.random() * 1.1; // rereading the sentence
    }
  }

  /** One soft sine strike with a fast attack and a long ring — the body of a notification note.
   *  The room tone's ONLY remaining user is the dog's collar (`jingle`), which fires 6–11 of these
   *  45 ms apart up at 2400–4000 Hz: a rattle, not a note. The two-note figure that used to share
   *  this primitive (`chime`) was removed for colliding with the act cues — see the note on
   *  LIFE_EVENTS in soundLife.ts. Anything new built on `ping` has to clear that same bar. */
  private ping(ctx: AudioContext, out: AudioNode, at: number, freq: number, gain: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + 0.55);
  }

  /** Two people talking a few desks away — too far to make out a word, which is the point. Band-passed
   *  noise shaped into syllables, two voice registers trading short phrases; phrase count, syllable
   *  count, register, contour and pacing all jittered, so no two conversations are alike. */
  private murmur(ctx: AudioContext, out: AudioNode, whisper: boolean): void {
    // A whisper is the same exchange with the voice taken out of it: quieter, and pushed into a
    // tighter, breathier band — the shape of consonants carrying without pitch.
    const level = whisper ? 0.45 : 1;
    let at = ctx.currentTime + 0.05;
    const phrases = 2 + Math.floor(Math.random() * 2);
    for (let ph = 0; ph < phrases; ph++) {
      // alternate speakers: one higher register, one lower
      // Formant centre, not vocal-fold pitch: what carries through a room is the resonance band
      // around 300–650 Hz, and centring the band on a 130 Hz fundamental put nearly all the energy
      // below where the muffling lowpass could shape it (it was also the quietest event by 17 dB).
      // Two registers, an upper and a lower speaker, so an exchange has two people in it.
      const base = ph % 2 === 0 ? 460 + Math.random() * 190 : 310 + Math.random() * 130;
      const voice = whisper ? base * 1.5 : base;
      const syllables = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < syllables; i++) {
        const dur = 0.09 + Math.random() * 0.11;
        this.voiceBurst(ctx, out, at, voice * (0.9 + Math.random() * 0.35), dur, level);
        at += dur + 0.02 + Math.random() * 0.06;
      }
      at += 0.25 + Math.random() * 0.55; // the beat where the other one answers
    }
  }

  /** One spoken syllable, heard through the room: a noise burst through a gliding bandpass (the pitch
   *  contour of speech) then a hard lowpass (the wall between you and the words). */
  private voiceBurst(ctx: AudioContext, out: AudioNode, at: number, freq: number, dur: number, level = 1): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Wide (Q 1.6, was 4.5): a narrow band on noise is a whistle, and it also starved the event of
    // nearly all its energy. A broad formant band reads as a voice and leaves the lowpass below
    // something to actually muffle.
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(freq, at);
    bp.frequency.exponentialRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), at + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime((0.075 + Math.random() * 0.028) * level, at + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(lp).connect(g).connect(out);
    src.start(at);
    src.stop(at + dur + 0.03);
  }

  /** A mug, a stapler, something set down on a desk. `body` picks how heavy it lands. */
  private tap(ctx: AudioContext, out: AudioNode, body: number): void {
    // 0.12 → 0.05 → 0.086 (sound identity inc 3): at 0.108 a pen tap sat 4× a keystroke, the level
    // the keystroke itself was cut from; 0.05 measured only +1.3 dB over keys, so ×1.72 (+4.7 dB)
    // brings it to +6 dB — twice a keystroke, like a step or a sip.
    this.click(ctx, out, ctx.currentTime + 0.02, 260 + Math.random() * 420, 0.086 * body, 0.13);
  }


  /** A stapler: the soft press of the arm, then the sharp ka-CHUNK of the staple setting. Two
   *  transients with the weight on the second, which is the opposite of a keypress — that reversal
   *  is what keeps them from reading as the same object. */
  private stapler(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    // 0.05 + 0.14 → 0.03 + 0.07 (inc 3): the ka-CHUNK was the loudest noise in the room, 5× keys.
    this.click(ctx, out, t0, 380 + Math.random() * 120, 0.03, 0.04);
    this.click(ctx, out, t0 + 0.07 + Math.random() * 0.03, 900 + Math.random() * 300, 0.07, 0.05);
  }

  /** A wooden drawer: a low slide swelling over a third of a second, ended by a hard stop. The slide
   *  is a noise swell with NO attack transient — the stop is the only edge, which is what makes it a
   *  drawer and not a knock followed by a hiss. */
  private drawer(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    const dur = 0.3 + Math.random() * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(180 + Math.random() * 80, t0);
    bp.frequency.exponentialRampToValueAtTime(260 + Math.random() * 80, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + dur * 0.6); // 0.1 → 0.05 (inc 3): 2× keys
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
    this.click(ctx, out, t0 + dur, 200 + Math.random() * 100, 0.11, 0.06); // the stop
  }

  /** Somebody walking past: paced pairs of soft low thuds. The pan drift across the field is the
   *  whole effect — footsteps that stay in one place are a woodpecker. */
  private footsteps(ctx: AudioContext, out: AudioNode): void {
    const steps = 4 + Math.floor(Math.random() * 4);
    const pace = 0.42 + Math.random() * 0.14;
    const from = (Math.random() * 2 - 1) * 0.7;
    const dir = Math.random() < 0.5 ? 1 : -1;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < steps; i++) {
      // Per-step pan: a small chain per thud, drifting across the field as they cross the room.
      const pan = ctx.createStereoPanner?.();
      const leg: AudioNode = pan ?? ctx.createGain();
      if (pan) pan.pan.value = Math.max(-1, Math.min(1, from + dir * (i / steps) * 0.6));
      leg.connect(out);
      this.click(ctx, leg, at, 110 + Math.random() * 60, 0.09, 0.07);
      at += pace * (0.92 + Math.random() * 0.16);
    }
  }

  /** A sip — coffee at full body, water lower and wetter via `body`. A short liquid intake, then the
   *  tiny swallow underneath it. */
  private sip(ctx: AudioContext, out: AudioNode, body: number): void {
    // the water bottle (body < 1) keeps its synth recipe until it has a recording of its own
    if (body >= 1 && this.take(ctx, out, 'sip')) return;
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.5;
    bp.frequency.setValueAtTime(1400 * body, t0);
    bp.frequency.exponentialRampToValueAtTime(900 * body, t0 + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.055, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.2);
    this.click(ctx, out, t0 + 0.22 + Math.random() * 0.05, 240 * body, 0.05, 0.06); // the swallow
  }

  /** Blowing on a hot coffee — or, with `long`, a yawn: a breath swell through a slow-opening
   *  lowpass, no transient anywhere. The absence of an edge IS the sound. */
  private blow(ctx: AudioContext, out: AudioNode, long = false): void {
    const t0 = ctx.currentTime + 0.02;
    const dur = long ? 0.9 + Math.random() * 0.4 : 0.45 + Math.random() * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t0);
    // A yawn's jaw opens the tract wider than pursed lips ever do — same gesture, bigger sweep.
    lp.frequency.exponentialRampToValueAtTime(long ? 1600 : 1100, t0 + dur * 0.45);
    lp.frequency.exponentialRampToValueAtTime(420, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(long ? 0.05 : 0.065, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /** Somebody eating at their desk: soft irregular crunches at an uneven rate — the irregularity is
   *  what separates chewing from machinery. */
  private eating(ctx: AudioContext, out: AudioNode): void {
    if (this.take(ctx, out, 'eat')) return;
    const bites = 3 + Math.floor(Math.random() * 4);
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < bites; i++) {
      this.click(ctx, out, at, 700 + Math.random() * 500, 0.045 + Math.random() * 0.02, 0.05 + Math.random() * 0.03);
      at += 0.28 + Math.random() * 0.3;
    }
  }

  /** The dog's paws on the boards — much softer and rounder than human footsteps, and quicker. */
  private paws(ctx: AudioContext, out: AudioNode): void {
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i++) {
      this.click(ctx, out, at, 190 + Math.random() * 80, 0.035, 0.035);
      at += 0.16 + Math.random() * 0.05;
    }
  }

  /** A collar shake: a quick cluster of tiny bright transients — the tag against the buckle. */
  private jingle(ctx: AudioContext, out: AudioNode): void {
    if (this.take(ctx, out, 'jingle')) return;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 6 + Math.floor(Math.random() * 5); i++) {
      this.ping(ctx, out, at, 2400 + Math.random() * 1600, 0.006 + Math.random() * 0.004);
      at += 0.045 + Math.random() * 0.04;
    }
  }

  /** One quiet bark — a short voiced burst with a fast pitch drop. Kept soft on purpose: this dog is
   *  across the room, and its rarity is set in LIFE_EVENTS, not here. */
  private bark(ctx: AudioContext, out: AudioNode): void {
    if (this.take(ctx, out, 'bark')) return;
    const t0 = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.8;
    bp.frequency.setValueAtTime(620 + Math.random() * 120, t0);
    bp.frequency.exponentialRampToValueAtTime(320, t0 + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    src.connect(bp).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + 0.2);
  }

  /** The dog panting, a few breaths: recorded only (nick approved both takes, 2026-10-31). There
   *  is no synth recipe here — breath from filtered noise is the whisper family, and that was
   *  "very creepy" — so until the take lands, the dog is quiet. */
  private pant(ctx: AudioContext, out: AudioNode): void {
    this.take(ctx, out, 'pant');
  }

  /** Night air for the late shift (E2 spec §4): a distant cricket-ish pulse train — a few tremolo'd
   *  high pips, very quiet, very sparse. Deliberately under everything else: it is the sound of the
   *  building being empty around the one lit desk, not a nature documentary. */
  private nightair(ctx: AudioContext, out: AudioNode): void {
    const f = 3800 + Math.random() * 700;
    let at = ctx.currentTime + 0.02;
    for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
      this.ping(ctx, out, at, f * (0.98 + Math.random() * 0.04), 0.0035 + Math.random() * 0.002);
      at += 0.07 + Math.random() * 0.04;
    }
  }

  /** One short filtered noise burst — the shared shape behind a keystroke and a mug on a desk. */
  private click(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    gain: number,
    dur = 0.045,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    // Q 2.2 → 1.6 and attack 4 → 8 ms (inc 3, spec §2.5): a wider band and a slower edge take the
    // click out of every transient in the room — warm means the edges are rounded, not quieter.
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(at);
    src.stop(at + dur + 0.03);
  }
}

/** Process-wide singleton, reached only through the `roomTone` façade in `sound.ts`. */
export const roomToneEngine = new RoomTone();
