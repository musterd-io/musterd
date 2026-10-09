import type { MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import type { Briefing } from './briefing';
import { NowSections } from './NowPanel';
import {
  readBriefedAt,
  startMode,
  writeBriefedAt,
  type NowMode,
  type NowStorage,
} from './nowWhen';
import { nowOpenMode, stillMode } from './stillMode';

/**
 * The Now briefing's shell (live-briefing spec): one card with three homes. On the first visit of a
 * period it comes up as an overlay over the room — which stays live and untouched behind it — and
 * when the reader collapses it, it shrinks into a tab on the room's left edge and stays there until
 * they ask for it back, as the overlay or full screen. See `nowWhen.ts` for when it opens by itself.
 *
 * Not modal: it takes no focus when it opens and the room behind it keeps working. Esc steps it
 * down (full → overlay → tab) while focus is inside it.
 */

const store = (): NowStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // some browsers throw on the accessor itself
  }
};

const PHONE_QUERY = '(max-width: 880px)';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);

export interface NowOverlayProps {
  brief: Briefing;
  roster: readonly MemberSummary[];
  /** Where the shipped list starts (`briefingSince`). */
  since: number;
  onOpenLane: (laneId: string) => void;
  onOpenAsk: (envelopeId: string) => void;
}

export function NowOverlay({ brief, roster, since, onOpenLane, onOpenAsk }: NowOverlayProps) {
  // First paint is docked on server and client alike; the entrance is a second step, so there is
  // a docked state for it to grow out of.
  const [mode, setMode] = useState<NowMode>('docked');
  const [still, setStill] = useState(false);
  const [phone, setPhone] = useState(false);

  useEffect(() => {
    const isStill = stillMode();
    const isPhone = window.matchMedia(PHONE_QUERY).matches;
    setStill(isStill);
    setPhone(isPhone);
    // Measurement modes (stillMode.ts): `?now-open` mounts it open for the one sweep that reads its
    // text; plain `?still` keeps it docked so every other sweep sees the page as it was.
    if (nowOpenMode()) {
      setMode('overlay');
      return;
    }
    if (isStill) return;
    const start = startMode(readBriefedAt(store()), Date.now(), { phone: isPhone });
    if (!start.opened) return;
    // The stamp is written when the overlay actually opens, never before: an effect that is run,
    // torn down and run again (StrictMode, a fast remount) must not spend the period on a run
    // whose animation frame was cancelled.
    const open = () => {
      writeBriefedAt(store(), Date.now());
      setMode('overlay');
    };
    // Two frames: the first paints docked, the second lets the transition see a change.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(open);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // The phone query follows the window, so rotating a tablet reshapes the open card.
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Esc steps it down. A listener on the element, not a prop: the card is a region, not a control.
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMode((m) => (m === 'full' ? 'overlay' : 'docked'));
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const now = Date.now();
  const open = mode !== 'docked';
  const waiting = brief.needsHuman.length;
  const cls = (base: string) => `${base}${still ? ' is-still' : ''}`;

  return (
    <>
      <button
        type="button"
        className={cls(`now-dock${open ? ' is-away' : ''}`)}
        onClick={() => setMode('overlay')}
        aria-expanded={open}
        aria-controls="now-ov"
        aria-label={`Open the team briefing${waiting ? ` — ${waiting} need a human` : ''}`}
        title="Open the team briefing"
        inert={open}
      >
        <span className="now-dock__label">Now</span>
        {waiting > 0 && (
          <span className="now-dock__n" aria-hidden="true">
            {waiting}
          </span>
        )}
      </button>
      <section
        id="now-ov"
        className={cls(`now-ov now-ov--${mode}${phone ? ' is-phone' : ''}`)}
        aria-label="Team briefing"
        inert={!open}
        ref={card}
      >
        <header className="now-ov__head">
          <div>
            <p className="now-ov__k">Now</p>
            <p className="now-ov__headline">{brief.headline}</p>
          </div>
          <div className="now-ov__ctl">
            {mode === 'full' ? (
              <button
                type="button"
                className="now-ctl"
                onClick={() => setMode('overlay')}
                aria-label="Back to the overlay"
                title="Back to the overlay"
              >
                <Icon d="M6 2v4H2M10 14v-4h4M6 6 2 2M10 10l4 4" />
              </button>
            ) : (
              <button
                type="button"
                className="now-ctl"
                onClick={() => setMode('full')}
                aria-label="Full screen"
                title="Full screen"
              >
                <Icon d="M2 6V2h4M14 10v4h-4M2 2l4 4M14 14l-4-4" />
              </button>
            )}
            <button
              type="button"
              className="now-ctl"
              onClick={() => setMode('docked')}
              aria-label="Collapse to the side tab"
              title="Collapse to the side tab"
            >
              <Icon d="M10 3 5 8l5 5M3 3v10" />
            </button>
          </div>
        </header>
        <div className="now-ov__scroll">
          <NowSections
            brief={brief}
            roster={roster}
            now={now}
            since={since}
            full={mode === 'full'}
            onOpenLane={onOpenLane}
            onOpenAsk={onOpenAsk}
            onMore={() => setMode('full')}
          />
        </div>
      </section>
    </>
  );
}
