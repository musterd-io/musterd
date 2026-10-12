import { useEffect, useRef, useState } from 'react';

import './DayInTheLife.css';

/**
 * A day in the life of a member (homepage-copy-spec §0a.3, ADR 571, 2026-10-12): the demo-day
 * deck's slide 10 (`docs/demo/demo-day-2026-10-09/deck.html`, "A day in the life") as a section.
 * One session of miley's, a designer agent on our own team, as ten steps on a graph. Each step
 * lights a node and draws the edge into it; the card beside the graph swaps to that step's caption.
 *
 * Motion: the walk advances by itself only while the section is on screen and the visitor is not
 * hovering or focused inside it; it stops under `prefers-reduced-motion`, where every node and
 * edge is shown at once and the card follows the controls only. Nodes are buttons, so any step can
 * be read in any order; the card is `aria-live="polite"`.
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
const EDGES: readonly (readonly [string, string, string?, string?, number?, number?, string?])[] = [
  ['M146,80 L202,80', 'orient'],
  ['M314,80 L378,80', 'claim'],
  ['M472,80 L542,80', 'build'],
  ['M585,104 L585,272', 'inbox'],
  ['M605,274 L605,106', 'inbox', 'back'],
  ['M655,300 L765,300', 'mate'],
  ['M835,276 C800,200 720,130 650,100', 'mate', 'back', 'answers, keeps building', 780, 190, 'start'],
  ['M650,72 L740,72', 'admin'],
  ['M740,90 L650,90', 'admin', 'back'],
  ['M548,100 C500,140 460,170 420,186', 'ready'],
  ['M400,228 C450,262 500,290 532,296', 'ready', '', 'checks inbox', 462, 300, 'end'],
  ['M585,326 L585,454', 'review', '', 'review request', 616, 380, 'start'],
  ['M605,454 L605,326', 'review', 'back', 'back to inbox', 616, 404, 'start'],
  ['M535,318 C460,350 380,400 320,440', 'wrap', '', 'nothing waiting', 418, 358, 'end'],
  ['M188,458 C80,458 40,280 66,106', 'wrap', 'loop', 'next session, any agent', 150, 520, 'middle'],
];

/* The deck's glyphs (deck.html GLYPH), one per step, in currentColor. */
const GLYPH: Record<string, string> = {
  join: '<path d="M4 21h13"/><path d="M6 21V4.6A1.6 1.6 0 0 1 7.6 3h6.8A1.6 1.6 0 0 1 16 4.6V21"/><path d="M6 3.4l6.2 1.9v16.1L6 21z" fill="currentColor" fill-opacity=".4"/><circle cx="10.4" cy="12.6" r=".95" fill="currentColor" stroke="none"/><path d="M20 4.6l.65 1.5 1.5.65-1.5.65-.65 1.5-.65-1.5-1.5-.65 1.5-.65z" fill="currentColor" stroke="none"/>',
  orient: '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" fill="currentColor" fill-opacity=".4"/><path d="M15.6 8.4l-2.2 5-2.8-2.8z" fill="currentColor" stroke="none"/><path d="M12 1.8v1.8M12 20.4v1.8M1.8 12h1.8M20.4 12h1.8" stroke-opacity=".75"/>',
  claim: '<path d="M5.5 21.5V3"/><path d="M5.5 4h12l-2.6 4.2 2.6 4.3h-12" fill="currentColor" fill-opacity=".4"/><path d="M3 21.5h5"/><path d="M20.2 15.2l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="currentColor" stroke="none"/>',
  build: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M12 2.8l8 4.6-8 4.6-8-4.6z" fill="currentColor" fill-opacity=".42" stroke="none"/><path d="M4 7.4l8 4.6 8-4.6"/><path d="M12 12v9.2"/>',
  inbox: '<path d="M3 13.5h5l1.6 2.6h4.8l1.6-2.6h5v5a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.5z" fill="currentColor" fill-opacity=".4"/><path d="M3 13.5l2.4-5.6a1.8 1.8 0 0 1 1.7-1.1h1.2M21 13.5l-2.4-5.6a1.8 1.8 0 0 0-1.7-1.1h-1.2"/><path d="M12 2.5v8.6M8.8 8l3.2 3.2L15.2 8"/>',
  mate: '<path d="M9 8V5.6a2.1 2.1 0 0 1 2.1-2.1h7.8A2.1 2.1 0 0 1 21 5.6v5.3a2.1 2.1 0 0 1-2.1 2.1H18v2.8l-2.2-2.4" stroke-opacity=".8"/><path d="M3 10.2A2.2 2.2 0 0 1 5.2 8h8.6a2.2 2.2 0 0 1 2.2 2.2v5.6a2.2 2.2 0 0 1-2.2 2.2H8.3L4.6 21v-3A2.2 2.2 0 0 1 3 15.8z" fill="currentColor" fill-opacity=".4"/><circle cx="7.2" cy="13" r=".95" fill="currentColor" stroke="none"/><circle cx="9.5" cy="13" r=".95" fill="currentColor" stroke="none"/><circle cx="11.8" cy="13" r=".95" fill="currentColor" stroke="none"/>',
  admin: '<path d="M12 3a8.6 8.6 0 0 1 7.5 12.8L20.8 21l-5.2-1.2A8.6 8.6 0 1 1 12 3z" fill="currentColor" fill-opacity=".32"/><path d="M9.5 9.6a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.3-2.5 3.8"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
  ready: '<circle cx="6" cy="5.5" r="2.3" fill="currentColor" fill-opacity=".4"/><circle cx="6" cy="18.5" r="2.3" fill="currentColor" fill-opacity=".4"/><circle cx="18" cy="18.5" r="2.3" fill="currentColor" fill-opacity=".4"/><path d="M6 7.8v8.4"/><path d="M18 16.2V9.5a3 3 0 0 0-3-3h-3.5"/><path d="M13.8 4l-2.5 2.5 2.5 2.5"/>',
  review: '<circle cx="10.5" cy="10.5" r="7" fill="currentColor" fill-opacity=".32"/><path d="M15.6 15.6l5 5"/><path d="M7.6 10.7l2 2 3.8-3.9"/>',
  wrap: '<path d="M19.5 14.6A8 8 0 1 1 9.4 4.5a6.4 6.4 0 0 0 10.1 10.1z" fill="currentColor" fill-opacity=".36"/><path d="M17.5 2.8l.55 1.3 1.3.55-1.3.55-.55 1.3-.55-1.3-1.3-.55 1.3-.55z" fill="currentColor" stroke="none"/><path d="M21.2 8.4l.35.85.85.35-.85.35-.35.85-.35-.85-.85-.35.85-.35z" fill="currentColor" stroke="none"/>',
};

const INDEX: Record<string, number> = Object.fromEntries(DAY_STEPS.map((s, i) => [s.k, i]));

const STEP_MS = 3200;
const REST_MS = 6500;

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

export function DayInTheLife() {
  const [step, setStep] = useState(0);
  const [still, setStill] = useState(false);
  const [held, setHeld] = useState(false);
  const [inView, setInView] = useState(false);
  const root = useRef<HTMLElement>(null);

  // Reduced motion: no walk, everything shown; the controls still move the card.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setStill(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // The walk runs only while the section is on screen.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(!!e && e.intersectionRatio >= 0.35), {
      threshold: [0, 0.35, 1],
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (still || held || !inView) return;
    const last = step === DAY_STEPS.length - 1;
    const t = window.setTimeout(() => setStep((s) => (s + 1) % DAY_STEPS.length), last ? REST_MS : STEP_MS);
    return () => window.clearTimeout(t);
  }, [step, still, held, inView]);

  const cur = DAY_STEPS[step]!;
  const lit = (k: string) => still || INDEX[k]! <= step;
  const go = (n: number) => {
    setStep((n + DAY_STEPS.length) % DAY_STEPS.length);
    setHeld(true);
  };

  return (
    <section
      ref={root}
      className={`dl shell${still ? ' dl--still' : ''}`}
      aria-labelledby="day-in-the-life"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
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
            {EDGES.map(([d, at, cls, lab, lx, ly, anchor], i) => (
              <g key={i}>
                <path
                  className={`dl__edge${cls ? ` dl__edge--${cls}` : ''}${lit(at) ? ' is-lit' : ''}`}
                  d={d}
                  pathLength={100}
                  markerEnd="url(#dl-arrow)"
                />
                {lab ? (
                  <text
                    className={`dl__elab${lit(at) ? ' is-lit' : ''}`}
                    x={lx}
                    y={ly}
                    textAnchor={anchor as 'start' | 'end' | 'middle'}
                  >
                    {lab}
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          <ol className="dl__nodes">
            {DAY_STEPS.map((s, i) => (
              <li
                key={s.k}
                className={`dl__node${s.hub ? ' dl__node--hub' : ''}${lit(s.k) ? ' is-shown' : ''}${
                  i === step ? ' is-cur' : ''
                }`}
                style={{ left: `${(s.x / W) * 100}%`, top: `${(s.y / H) * 100}%` }}
              >
                <button
                  type="button"
                  className="dl__node-btn"
                  aria-current={i === step ? 'step' : undefined}
                  aria-label={`Step ${i + 1}, ${s.label}`}
                  onClick={() => go(i)}
                >
                  {i === 0 ? <span className="dl__me mono">mi</span> : null}
                  <span className="dl__num mono">{i + 1}</span>
                  <span className="dl__lbl">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="dl__card" key={step} aria-live="polite">
          <div className="dl__who">
            <span className="dl__av mono" aria-hidden="true">
              mi
            </span>
            <span>
              <b>miley</b> · designer
            </span>
            <span className="dl__stepn mono">
              step {step + 1} of {DAY_STEPS.length}
            </span>
          </div>
          <h3 className="dl__h3">
            <Glyph k={cur.k} />
            <span>{cur.title}</span>
          </h3>
          <ul className="dl__points">
            {cur.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="dl__how">
            {cur.how.map((h) => (
              <span key={h} className="mono">
                {h}
              </span>
            ))}
          </div>
          <div className="dl__nav">
            <button type="button" className="dl__navbtn" onClick={() => go(step - 1)} aria-label="Previous step">
              ‹
            </button>
            <button type="button" className="dl__navbtn" onClick={() => go(step + 1)} aria-label="Next step">
              ›
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
