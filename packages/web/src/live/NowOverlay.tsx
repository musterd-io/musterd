import type { MemberSummary } from '@musterd/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { waitingFor, type Briefing } from './briefing';
import { NowCard } from './NowPanel';
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
 * when the reader docks it, it shrinks into the "Now" chip in the topbar and stays there until they
 * ask for it back, as the overlay or full screen. See `nowWhen.ts` for when it opens by itself.
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
  /** The signed-in member, or null for an observer: whose asks get the band and the chip's count. */
  viewer: string | null;
  onOpenLane: (laneId: string) => void;
  onOpenAsk: (envelopeId: string) => void;
  onOpenGoal: (goalId: string | null) => void;
  onLight: (names: readonly string[] | null) => void;
  /** The id of the topbar element the dock chip is portalled into. A prop, not an import the route
   *  makes from here: this module is a lazy chunk and the route must not pull it eagerly. */
  slotId: string;
}

export function NowOverlay({
  brief,
  roster,
  since,
  viewer,
  onOpenLane,
  onOpenAsk,
  onOpenGoal,
  onLight,
  slotId,
}: NowOverlayProps) {
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

  // The chip lives in the topbar (spec, "Docking"), so it is portalled there; the slot is found
  // after mount, which is also when the card's docked geometry can be measured against it.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(slotId)), [slotId]);
  const chip = useRef<HTMLButtonElement | null>(null);
  // Docked, the card is scaled onto the chip at the chip's position, so docking visibly shrinks INTO
  // it and opening grows OUT of it. The offset is measured, not guessed: the chip's place in the
  // topbar moves with the window and with what else the topbar holds.
  useLayoutEffect(() => {
    const el = card.current;
    const c = chip.current;
    if (!el || !c || !el.offsetParent) return;
    const parent = el.offsetParent as HTMLElement;
    // The room's asks strip and huddle rail share one box at its top; the card sits under it, never
    // over it — the strip is where an ask is answered, and the rail grows and shrinks as huddles open.
    const asks = parent.querySelector<HTMLElement>('.lc-office__asks');
    const place = () => {
      const from = parent.getBoundingClientRect();
      const below = asks ? asks.getBoundingClientRect().bottom - from.top + 12 : 72;
      el.style.setProperty('--now-top', `${Math.max(72, Math.round(below))}px`);
      const to = c.getBoundingClientRect();
      el.style.setProperty('--now-dock-x', `${to.left - from.left - el.offsetLeft}px`);
      el.style.setProperty('--now-dock-y', `${to.top - from.top - el.offsetTop}px`);
    };
    place();
    const ro = asks && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (asks) ro?.observe(asks);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [slot, mode]);

  // A goal row lights its people in the room; docking must not leave them lit.
  useEffect(() => {
    if (mode === 'docked') onLight(null);
  }, [mode, onLight]);

  const now = Date.now();
  const open = mode !== 'docked';
  const yours = waitingFor(brief, viewer).mine.length;
  const cls = (base: string) => `${base}${still ? ' is-still' : ''}`;

  const dock = (
    <button
      type="button"
      ref={chip}
      className={cls(`now-chip${open ? ' is-open' : ''}`)}
      onClick={() => setMode(open ? 'docked' : 'overlay')}
      aria-expanded={open}
      aria-controls="now-ov"
      aria-label={`Team briefing${yours ? ` — ${yours} waiting on you` : ''}`}
      title={open ? 'Dock the team briefing' : 'Open the team briefing'}
    >
      <span className="now-chip__label">Now</span>
      {yours > 0 && (
        <span className="now-chip__you" aria-hidden="true">
          <i className="now-chip__dot" />
          {yours} needs you
        </span>
      )}
    </button>
  );

  return (
    <>
      {slot && createPortal(dock, slot)}
      <section
        id="now-ov"
        className={cls(`now-ov now-ov--${mode}${phone ? ' is-phone' : ''}`)}
        aria-label="Team briefing"
        inert={!open}
        ref={card}
      >
        <header className="now-ov__head">
          <p className="now-ov__k">Now</p>
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
              aria-label="Dock to the topbar"
              title="Dock to the topbar"
            >
              <Icon d="M3 10 8 5l5 5M3 13h10" />
            </button>
          </div>
        </header>
        <div className="now-ov__scroll">
          <NowCard
            brief={brief}
            roster={roster}
            viewer={viewer}
            now={now}
            since={since}
            full={mode === 'full'}
            onOpenLane={onOpenLane}
            onOpenAsk={onOpenAsk}
            onOpenGoal={onOpenGoal}
            onLight={onLight}
          />
        </div>
      </section>
    </>
  );
}
