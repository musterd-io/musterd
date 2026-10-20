import './Settings.css';
import type { MemberSummary, WorkingHours } from '@musterd/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OPEN_TILT, shouldDismiss, zoomTransform } from '../boardOverlayMath';
import type { LiveConfig } from '../client';
import type { ChannelPairing } from '../pairingClient';
import { TeamPanel } from './TeamPanel';
import { YouPanel } from './YouPanel';

/** Matches the CSS close transition, as the board overlay's does. */
const CLOSE_MS = 320;

type Tab = 'you' | 'team';

/**
 * Settings, opened from the working-hours calendar on the office wall (nick, 2026-10-19). The same
 * gesture as the work board: the panel comes off the wall out of the calendar's rect and goes back on
 * it to close, and it stops short of full-bleed so the room stays visible around it.
 *
 * Two sheets, torn from the same calendar: **You** for any signed-in human — pairings, where asks
 * ring you, how agents talk to you — and **Team** for admins. The route decides who sees the Team tab
 * from the roster; the daemon decides what an edit may do. Sound, room tone and the share link stay
 * in the topbar (nick): they are things you reach for mid-watch, not settings.
 */
export function SettingsOverlay({
  cfg,
  me,
  isAdmin,
  teamHours,
  pairings,
  origin,
  onPairingsChanged,
  onHoldsChanged,
  onClose,
}: {
  cfg: LiveConfig;
  me: MemberSummary | null;
  isAdmin: boolean;
  teamHours: WorkingHours | null;
  pairings: ChannelPairing[];
  /** The calendar's viewport rect — where the panel comes from and goes back to. */
  origin: DOMRect | null;
  onPairingsChanged: () => void;
  onHoldsChanged: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('you');
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect(), OPEN_TILT);
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        panel.style.transform = '';
        rootRef.current?.classList.add('is-in');
        panel.focus({ preventScroll: true });
      }),
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: origin is fixed per open
  }, []);

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    const panel = panelRef.current;
    rootRef.current?.classList.remove('is-in');
    if (panel && origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect(), OPEN_TILT);
    }
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS);
  }, [closing, origin, reduced, onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldDismiss(e, false)) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const tabs: { id: Tab; label: string; flag?: boolean }[] = [
    { id: 'you', label: 'you', flag: pairings.length > 0 },
    ...(isAdmin ? [{ id: 'team' as const, label: 'team' }] : []),
  ];

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop dismissal; Escape is the keyboard path (document listener above)
    <div
      ref={rootRef}
      className="lc-boardoverlay lc-settings"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className="lc-boardoverlay__panel lc-settings__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Settings — ${cfg.team}`}
        tabIndex={-1}
      >
        <header className="lc-settings__band">
          <span className="lc-settings__hole" aria-hidden="true" />
          <span className="lc-settings__title">
            settings <span className="lc-settings__team">· {cfg.team}</span>
          </span>
          <span className="lc-settings__tabs" role="tablist" aria-label="Settings for">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`lc-settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="lc-settings-sheet"
                className={`lc-settings__tab${tab === t.id ? ' is-on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.flag && <span className="lc-settings__flag" aria-label="something waits" />}
              </button>
            ))}
          </span>
          <button className="lc-settings__close" onClick={close} aria-label="Close settings">
            ×
          </button>
          <span className="lc-settings__hole" aria-hidden="true" />
        </header>
        <div
          id="lc-settings-sheet"
          className="lc-settings__sheet"
          role="tabpanel"
          aria-labelledby={`lc-settings-tab-${tab}`}
        >
          {tab === 'you' ? (
            <YouPanel
              cfg={cfg}
              me={me}
              pairings={pairings}
              onPairingsChanged={onPairingsChanged}
            />
          ) : (
            <TeamPanel cfg={cfg} hours={teamHours} onHoldsChanged={onHoldsChanged} />
          )}
        </div>
      </div>
    </div>
  );
}
