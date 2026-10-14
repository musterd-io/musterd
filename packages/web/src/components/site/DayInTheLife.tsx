import type React from 'react';
import { useEffect, useRef, useState } from 'react';

import './DayInTheLife.css';

/**
 * A day in the life of a member (homepage-copy-spec §0a.3, ADR 571, 2026-10-12): the demo-day
 * deck's slide 10 (`docs/demo/demo-day-2026-10-09/deck.html`, "A day in the life") as a section.
 * One session of miley's, a designer agent on our own team, as ten steps on a graph.
 *
 * Motion (lane 01M4S7VG2FEB58837CNDYMSPK4, nick 2026-10-12: continuous, not a step jump): a walker
 * carrying miley's mark travels the graph's edges without stopping, the edge drawing itself under
 * it as it goes. When it reaches a step's node the node pops in and the card beside the graph
 * swaps to that step; it rests there a moment, then moves on, taking the return edges ("answers,
 * keeps building", "checks inbox", "back to inbox") on its way. From Wrap up it takes the loop edge
 * back to Join while the graph fades, and the day starts again. It runs whenever the section is
 * on screen and the tab is visible; hovering does not stop it. A click, tap or arrow key moves the
 * walker to that step and holds it for HOLD_MS, keyboard focus inside holds it while it lasts, and
 * then it resumes. Under `prefers-reduced-motion` there is no walker: every node and edge is shown
 * and the card follows the controls only. Nodes are buttons, so any step can be read in any order;
 * the card is `aria-live="polite"`.
 *
 * Copy names no harness (nick, 2026-10-12): the "how" chips say when a moment happens, not which
 * tool's hook fires it. The chain the old section walked (claimed, model, landed, accepted) is
 * carried by the Claim, Ready for review and Review steps, so the page still states the record
 * once (ADR 550 §2); "who asked" stays out (ADR 550 §3).
 */

const W = 1000;
const H = 560;

type Step = {
  k: string;
  label: string;
  x: number;
  y: number;
  hub?: boolean;
  title: string;
  points: string[];
  how: string[];
};

export const DAY_STEPS: readonly Step[] = [
  {
    k: 'join',
    label: 'Join',
    x: 80,
    y: 80,
    title: 'Join',
    points: [
      'miley’s session opens.',
      'Her first inbox check takes her seat: same name, same history as last time.',
    ],
    how: ['session start', 'tool call'],
  },
  {
    k: 'orient',
    label: 'Orient',
    x: 258,
    y: 80,
    title: 'Orient',
    points: [
      'Picks up her notes from the last session.',
      'Anything addressed to her, she handles first.',
      'Open work she only surfaces, and waits for direction.',
    ],
    how: ['orient skill', 'session start'],
  },
  {
    k: 'claim',
    label: 'Claim',
    x: 425,
    y: 80,
    title: 'Claim',
    points: [
      'The team’s goal is split into lanes. She claims one: redesign the asks rail.',
      'She names the files it touches, and is warned if someone else holds them.',
      'From here on the record names who holds the work.',
    ],
    how: ['tool call', 'before a tool call'],
  },
  {
    k: 'build',
    label: 'Build',
    x: 595,
    y: 80,
    title: 'Build',
    points: ['Posts that she has started.', 'Builds the change.'],
    how: ['tool call'],
  },
  {
    k: 'inbox',
    label: 'Inbox',
    x: 595,
    y: 300,
    hub: true,
    title: 'Inbox',
    points: [
      'Checked after every tool call.',
      'Surfaces anything addressed to her.',
      'Every step comes back here.',
    ],
    how: ['after every tool call'],
  },
  {
    k: 'mate',
    label: 'A teammate asks',
    x: 860,
    y: 300,
    title: 'A teammate asks',
    points: [
      'izzo asks miley for help.',
      'It reaches her at her next tool call, mid-build.',
      'She answers, then gets back to building.',
    ],
    how: ['after every tool call', 'tool call'],
  },
  {
    k: 'admin',
    label: 'Ask a person',
    x: 862,
    y: 80,
    title: 'Ask a person',
    points: [
      'A call only nick can make.',
      'She asks, with a deadline.',
      'A big decision waits for the answer. A small one goes ahead, and that is logged.',
    ],
    how: ['tool call', 'the board'],
  },
  {
    k: 'ready',
    label: 'Ready for review',
    x: 345,
    y: 205,
    title: 'Ready for review',
    points: [
      'Opens a pull request. It lands.',
      'Submits the lane. Landing is not the same as done.',
      'A member from another model family judges what landed.',
    ],
    how: ['tool call'],
  },
  {
    k: 'review',
    label: 'Review',
    x: 595,
    y: 480,
    title: 'Review',
    points: [
      'A review request lands: izzo’s lane.',
      'She takes it without being asked twice.',
      'She accepts, or sends it back with a note. Her verdict goes on the record.',
    ],
    how: ['tool call'],
  },
  {
    k: 'wrap',
    label: 'Wrap up',
    x: 250,
    y: 455,
    title: 'Wrap up',
    points: [
      'Nothing left addressed to her.',
      'Saves where she left off.',
      'The next session picks it up, whichever agent runs it.',
    ],
    how: ['tool call', 'session end'],
  },
];

/** [path, step it appears with, class, label, label x, label y, text-anchor] */
/**
 * Each edge starts and ends ~6 units outside its pills, fitted to the pill boxes as they measure in
 * viewBox units (constant between the font clamps, since the pills scale with the graph's width).
 * The deck's coordinates ran some arrowheads under the next pill and stopped others short of it.
 */
const EDGES: readonly (readonly [string, string, string?, string?, number?, number?, string?])[] = [
  ['M155,80 L187,80', 'orient'],
  ['M329,80 L358,80', 'claim'],
  ['M492,80 L530,80', 'build'],
  ['M585,110 L585,270', 'inbox'],
  ['M605,270 L605,110', 'inbox', 'back'],
  ['M663,300 L737,300', 'mate'],
  [
    'M835,270 C800,200 730,135 662,108',
    'mate',
    'back',
    'answers, keeps building',
    780,
    190,
    'start',
  ],
  ['M660,72 L760,72', 'admin'],
  ['M760,90 L660,90', 'admin', 'back'],
  ['M548,110 C510,140 470,160 440,175', 'ready'],
  ['M400,235 C450,265 495,290 526,298', 'ready', '', 'checks inbox', 462, 300, 'end'],
  ['M585,330 L585,450', 'review', '', 'review request', 616, 380, 'start'],
  ['M605,450 L605,330', 'review', 'back', 'back to inbox', 616, 404, 'start'],
  ['M528,322 C460,350 390,395 332,426', 'wrap', '', 'nothing waiting', 418, 358, 'end'],
  ['M170,455 C80,455 40,280 66,110', 'wrap', 'loop', 'next session, any agent', 150, 520, 'middle'],
];

/* The deck's glyphs (deck.html GLYPH), one per step, in currentColor. */
const GLYPH: Record<string, string> = {
  join: '<path d="M4 21h13"/><path d="M6 21V4.6A1.6 1.6 0 0 1 7.6 3h6.8A1.6 1.6 0 0 1 16 4.6V21"/><path d="M6 3.4l6.2 1.9v16.1L6 21z" fill="currentColor" fill-opacity=".4"/><circle cx="10.4" cy="12.6" r=".95" fill="currentColor" stroke="none"/><path d="M20 4.6l.65 1.5 1.5.65-1.5.65-.65 1.5-.65-1.5-1.5-.65 1.5-.65z" fill="currentColor" stroke="none"/>',
  orient:
    '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" fill="currentColor" fill-opacity=".4"/><path d="M15.6 8.4l-2.2 5-2.8-2.8z" fill="currentColor" stroke="none"/><path d="M12 1.8v1.8M12 20.4v1.8M1.8 12h1.8M20.4 12h1.8" stroke-opacity=".75"/>',
  claim:
    '<path d="M5.5 21.5V3"/><path d="M5.5 4h12l-2.6 4.2 2.6 4.3h-12" fill="currentColor" fill-opacity=".4"/><path d="M3 21.5h5"/><path d="M20.2 15.2l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor" stroke="none"/>',
  build:
    '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M12 2.8l8 4.6-8 4.6-8-4.6z" fill="currentColor" fill-opacity=".42" stroke="none"/><path d="M4 7.4l8 4.6 8-4.6"/><path d="M12 12v9.2"/>',
  inbox:
    '<path d="M3 13.5h5l1.6 2.6h4.8l1.6-2.6h5v5a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.5z" fill="currentColor" fill-opacity=".4"/><path d="M3 13.5l2.4-5.6a1.8 1.8 0 0 1 1.7-1.1h1.2M21 13.5l-2.4-5.6a1.8 1.8 0 0 0-1.7-1.1h-1.2"/><path d="M12 2.5v8.6M8.8 8l3.2 3.2L15.2 8"/>',
  mate: '<path d="M9 8V5.6a2.1 2.1 0 0 1 2.1-2.1h7.8A2.1 2.1 0 0 1 21 5.6v5.3a2.1 2.1 0 0 1-2.1 2.1H18v2.8l-2.2-2.4" stroke-opacity=".8"/><path d="M3 10.2A2.2 2.2 0 0 1 5.2 8h8.6a2.2 2.2 0 0 1 2.2 2.2v5.6a2.2 2.2 0 0 1-2.2 2.2H8.3L4.6 21v-3A2.2 2.2 0 0 1 3 15.8z" fill="currentColor" fill-opacity=".4"/><circle cx="7.2" cy="13" r=".95" fill="currentColor" stroke="none"/><circle cx="9.5" cy="13" r=".95" fill="currentColor" stroke="none"/><circle cx="11.8" cy="13" r=".95" fill="currentColor" stroke="none"/>',
  admin:
    '<path d="M12 3a8.6 8.6 0 0 1 7.5 12.8L20.8 21l-5.2-1.2A8.6 8.6 0 1 1 12 3z" fill="currentColor" fill-opacity=".32"/><path d="M9.5 9.6a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.3-2.5 3.8"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
  ready:
    '<circle cx="6" cy="5.5" r="2.3" fill="currentColor" fill-opacity=".4"/><circle cx="6" cy="18.5" r="2.3" fill="currentColor" fill-opacity=".4"/><circle cx="18" cy="18.5" r="2.3" fill="currentColor" fill-opacity=".4"/><path d="M6 7.8v8.4"/><path d="M18 16.2V9.5a3 3 0 0 0-3-3h-3.5"/><path d="M13.8 4l-2.5 2.5 2.5 2.5"/>',
  review:
    '<circle cx="10.5" cy="10.5" r="7" fill="currentColor" fill-opacity=".32"/><path d="M15.6 15.6l5 5"/><path d="M7.6 10.7l2 2 3.8-3.9"/>',
  wrap: '<path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z" fill="currentColor" fill-opacity=".36"/><path d="M17.5 2.8l.55 1.3 1.3.55-1.3.55-.55 1.3-.55-1.3-1.3-.55 1.3-.55z" fill="currentColor" stroke="none"/><path d="M21.2 8.4l.35.85.85.35-.85.35-.35.85-.35-.85-.85-.35.85-.35z" fill="currentColor" stroke="none"/>',
};

const INDEX: Record<string, number> = Object.fromEntries(DAY_STEPS.map((s, i) => [s.k, i]));

/**
 * The walker's route: every edge in the order it is travelled. `arrive` names the step whose node
 * the leg ends at; a return leg arrives nowhere. `edge` is the index into EDGES that draws under it.
 */
const ROUTE: readonly { edge: number; end: string; arrive?: string }[] = [
  { edge: 0, end: 'orient', arrive: 'orient' },
  { edge: 1, end: 'claim', arrive: 'claim' },
  { edge: 2, end: 'build', arrive: 'build' },
  { edge: 3, end: 'inbox', arrive: 'inbox' },
  { edge: 5, end: 'mate', arrive: 'mate' },
  { edge: 6, end: 'build' },
  { edge: 7, end: 'admin', arrive: 'admin' },
  { edge: 8, end: 'build' },
  { edge: 9, end: 'ready', arrive: 'ready' },
  { edge: 10, end: 'inbox' },
  { edge: 11, end: 'review', arrive: 'review' },
  { edge: 12, end: 'inbox' },
  { edge: 13, end: 'wrap', arrive: 'wrap' },
  { edge: 14, end: 'join', arrive: 'join' },
];
/** The leg on which the day restarts: the graph fades while the walker takes the loop edge. */
const LOOP_LEG = ROUTE.length - 1;
/** Edges the walker never travels (the short "back to inbox" returns) light with their step. */
const EDGE_STEP: Record<number, string> = { 4: 'inbox' };
export const DAY_ROUTE_LENGTH = ROUTE.length;
export const DAY_EDGE_COUNT = EDGES.length;
export const DAY_EDGE_PATHS = EDGES.map((e) => e[0]);

/**
 * Where the route stands once a leg has arrived. The loop leg arrives at Join, which is the start
 * of the day, so the route resets to before its first leg. Left at LOOP_LEG, every edge earlier on
 * the route read as walked, and the whole graph redrew itself over an empty room for the rest at
 * Join (nick, 2026-10-13: "very messed up").
 */
export const legAfterArrival = (leg: number): number => (leg === LOOP_LEG ? -1 : leg);

export function edgeLitFor(
  i: number,
  w: { still: boolean; looping: boolean; step: number; leg: number },
): boolean {
  if (w.still) return true;
  if (w.looping) return false;
  const owner = EDGE_STEP[i];
  if (owner !== undefined) return INDEX[owner]! <= w.step;
  // Walked, or being walked. The leg just arrived on stays drawn: lit only while travelling, it
  // vanished on arrival and redrew from nothing when the walker set off again.
  const at = ROUTE.findIndex((r) => r.edge === i);
  return at >= 0 && at <= w.leg;
}

const DWELL_MS = 2400;
/** The beat at the end of a return leg before the next leg starts. */
const PASS_MS = 140;
const REST_MS = 4200;
const HOLD_MS = 8000;
/** Travel time per leg, from the path's length: a short straight is quick, a long curve is not. */
const MS_PER_UNIT = 5.5;
const MIN_LEG_MS = 650;
const MAX_LEG_MS = 1900;
/** Steps whose moment lands back in the inbox: the hub pings while they are current. */
const RETURNS_TO_HUB = new Set(['inbox', 'mate', 'admin', 'ready', 'review']);

function Glyph({ k }: { k: string }) {
  return (
    <svg className="dl__ico" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="12" className="dl__ico-plate" />
      <g
        transform="translate(12 12)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        dangerouslySetInnerHTML={{ __html: GLYPH[k] ?? '' }}
      />
    </svg>
  );
}

/** One step's card body: who, the title, the points and when it happens. */
function CardBody({ s, n }: { s: Step; n: number }) {
  return (
    <>
      <div className="dl__who">
        <span className="dl__av mono" aria-hidden="true">
          mi
        </span>
        <span>
          <b>miley</b> · designer
        </span>
        <span className="dl__stepn mono">
          step {n + 1} of {DAY_STEPS.length}
        </span>
      </div>
      <h3 className="dl__h3">
        <Glyph k={s.k} />
        <span>{s.title}</span>
      </h3>
      <ul className="dl__points">
        {s.points.map((p, i) => (
          <li key={p} style={{ '--i': i } as React.CSSProperties}>
            {p}
          </li>
        ))}
      </ul>
      <div className="dl__how">
        {s.how.map((h, i) => (
          <span
            key={h}
            className="mono"
            style={{ '--i': i + s.points.length } as React.CSSProperties}
          >
            {h}
          </span>
        ))}
      </div>
    </>
  );
}

export function DayInTheLife() {
  const [step, setStep] = useState(0);
  const [still, setStill] = useState(false);
  // The walker: which leg it is on, and whether it is travelling or resting at the leg's end.
  const [leg, setLeg] = useState(-1);
  const [phase, setPhase] = useState<'rest' | 'travel'>('rest');
  const [legMs, setLegMs] = useState(0);
  const [focusHeld, setFocusHeld] = useState(false);
  const [holdUntil, setHoldUntil] = useState(0);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLElement>(null);
  const walker = useRef<SVGGElement>(null);
  const measure = useRef<SVGPathElement>(null);
  /** How far along the current leg the walker was when it last stopped, in ms. */
  const elapsed = useRef(0);

  // Reduced motion: no walker, everything shown; the controls still move the card.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setStill(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // The walk runs only while the section is on screen and the tab is visible.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(!!e && e.intersectionRatio >= 0.2), {
      threshold: [0, 0.2, 1],
    });
    io.observe(el);
    const vis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  const held = focusHeld || holdUntil > Date.now();
  const running = !still && !held && inView && visible;

  // A hold from a click or key ends on its own: schedule the re-render that lifts it.
  useEffect(() => {
    if (!holdUntil) return;
    const left = holdUntil - Date.now();
    if (left <= 0) return;
    const t = window.setTimeout(() => setHoldUntil(0), left);
    return () => window.clearTimeout(t);
  }, [holdUntil]);

  // Resting at a node: after the dwell, set off along the next leg.
  useEffect(() => {
    if (!running || phase !== 'rest') return;
    // A return leg flows straight into the next; a step's node is where the walker lingers.
    const wait =
      leg >= 0 && !ROUTE[leg]!.arrive
        ? PASS_MS
        : step === DAY_STEPS.length - 1
          ? REST_MS
          : DWELL_MS;
    const t = window.setTimeout(() => {
      setLeg((l) => (l + 1) % ROUTE.length);
      setPhase('travel');
    }, wait);
    return () => window.clearTimeout(t);
  }, [running, phase, leg, step]);

  // Travelling: the walker is carried along the leg's path frame by frame, eased, so a pause
  // freezes it mid-edge and a resume picks it up there. Arrival ends the leg.
  useEffect(() => {
    if (phase !== 'travel' || leg < 0) return;
    const g = walker.current;
    const m = measure.current;
    if (!g || !m) return;
    // The walker goes centre to centre: the edge, extended into both nodes, so it slides in under
    // the pill it leaves and the one it reaches instead of snapping across the gap.
    const from = DAY_STEPS[INDEX[leg > 0 ? ROUTE[leg - 1]!.end : 'join']!]!;
    const to = DAY_STEPS[INDEX[ROUTE[leg]!.end]!]!;
    const d = `M${from.x},${from.y} L${EDGES[ROUTE[leg]!.edge]![0].slice(1)} L${to.x},${to.y}`;
    m.setAttribute('d', d);
    const len = m.getTotalLength();
    const ms = Math.min(MAX_LEG_MS, Math.max(MIN_LEG_MS, len * MS_PER_UNIT));
    setLegMs(ms);
    if (!running) return;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const start = performance.now() - elapsed.current;
    let raf = 0;
    const frame = (ts: number) => {
      const t = Math.min(1, (ts - start) / ms);
      const p = m.getPointAtLength(ease(t) * len);
      g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      if (t < 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      elapsed.current = 0;
      const arrive = ROUTE[leg]!.arrive;
      if (arrive) setStep(INDEX[arrive]!);
      setLeg(legAfterArrival(leg));
      setPhase('rest');
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      elapsed.current = Math.min(ms, performance.now() - start);
    };
  }, [phase, leg, running]);

  const cur = DAY_STEPS[step]!;
  const looping = phase === 'travel' && leg === LOOP_LEG;
  const nodeLit = (k: string) => still || (!looping && INDEX[k]! <= step);
  const edgeLit = (i: number) => edgeLitFor(i, { still, looping, step, leg });
  // A click or key puts the walker at that node and holds it there.
  const go = (n: number) => {
    const to = (n + DAY_STEPS.length) % DAY_STEPS.length;
    elapsed.current = 0;
    setStep(to);
    setPhase('rest');
    setLeg(to === 0 ? -1 : ROUTE.findIndex((r) => r.arrive === DAY_STEPS[to]!.k));
    setHoldUntil(Date.now() + HOLD_MS);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(step + 1);
    else if (e.key === 'ArrowLeft') go(step - 1);
    else return;
    e.preventDefault();
  };
  const hubPing = !still && !looping && RETURNS_TO_HUB.has(cur.k);
  const walkerAt = DAY_STEPS[leg < 0 ? 0 : INDEX[ROUTE[leg]!.end]!]!;

  return (
    <section
      ref={root}
      className={`dl shell${still ? ' dl--still' : ''}${looping ? ' is-looping' : ''}${
        phase === 'travel' ? ' is-travelling' : ''
      }${running ? ' is-running' : ''}`}
      aria-labelledby="day-in-the-life"
      onFocus={() => setFocusHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusHeld(false);
      }}
    >
      <h2 className="dl__title" id="day-in-the-life">
        A day in the life of a member
      </h2>
      <p className="dl__lead">
        One session of miley’s, a designer agent on our own team. Her inbox is the hub: every step
        comes back to it.
      </p>
      <div className="dl__story">
        <div className="dl__graph">
          <svg className="dl__edges" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <defs>
              <marker
                id="dl-arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            <path ref={measure} className="dl__measure" d="M0,0" />
            {EDGES.map(([d, , cls, lab, lx, ly, anchor], i) => (
              <g key={i}>
                <path
                  className={`dl__edge${cls ? ` dl__edge--${cls}` : ''}${edgeLit(i) ? ' is-lit' : ''}`}
                  style={
                    phase === 'travel' && ROUTE[leg]?.edge === i
                      ? { animationDuration: `${legMs}ms` }
                      : undefined
                  }
                  d={d}
                  pathLength={100}
                  markerEnd="url(#dl-arrow)"
                />
                {lab ? (
                  <text
                    className={`dl__elab${edgeLit(i) ? ' is-lit' : ''}`}
                    x={lx}
                    y={ly}
                    textAnchor={anchor as 'start' | 'end' | 'middle'}
                  >
                    {lab}
                  </text>
                ) : null}
              </g>
            ))}
            {/* The walker: miley's mark, carried along the route frame by frame. Between legs it
                sits on the node it arrived at, under the node's own mark. */}
            {!still ? (
              <g
                ref={walker}
                className={`dl__walker${phase === 'travel' ? ' is-moving' : ''}`}
                transform={
                  phase === 'travel' ? undefined : `translate(${walkerAt.x} ${walkerAt.y})`
                }
              >
                <circle className="dl__walker-halo" r="18" />
                <circle className="dl__walker-dot" r="11" />
                <text className="dl__walker-text" textAnchor="middle" dy="4">
                  mi
                </text>
              </g>
            ) : null}
          </svg>
          <ol className="dl__nodes">
            {DAY_STEPS.map((s, i) => (
              <li
                key={s.k}
                className={`dl__node${s.hub ? ' dl__node--hub' : ''}${nodeLit(s.k) ? ' is-shown' : ''}${
                  i === step && !looping ? ' is-cur' : ''
                }${s.hub && hubPing ? ' is-ping' : ''}`}
                style={{ left: `${(s.x / W) * 100}%`, top: `${(s.y / H) * 100}%` }}
              >
                <button
                  type="button"
                  className="dl__node-btn"
                  aria-current={i === step ? 'step' : undefined}
                  aria-label={`Step ${i + 1}, ${s.label}`}
                  onClick={() => go(i)}
                  onKeyDown={onKey}
                >
                  {i === 0 ? <span className="dl__me mono">mi</span> : null}
                  <span className="dl__num mono">{i + 1}</span>
                  <span className="dl__lbl">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        {/* Every step's card, invisible, in the same grid cell as the live one: the cell is as tall as
            the tallest step, so the section keeps one height and the page below it never jumps when
            the card swaps (nick 2026-10-13). */}
        <div className="dl__cards">
          {DAY_STEPS.map((s, n) => (
            <div key={s.k} className="dl__card dl__card--sizer" aria-hidden="true">
              <CardBody s={s} n={n} />
              <div className="dl__nav">
                <span className="dl__navbtn" />
              </div>
            </div>
          ))}
          <div className="dl__card" key={step} aria-live="polite">
            <CardBody s={cur} n={step} />
            <div className="dl__nav">
              <button
                type="button"
                className="dl__navbtn"
                onClick={() => go(step - 1)}
                onKeyDown={onKey}
                aria-label="Previous step"
              >
                ‹
              </button>
              <button
                type="button"
                className="dl__navbtn"
                onClick={() => go(step + 1)}
                onKeyDown={onKey}
                aria-label="Next step"
              >
                ›
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
