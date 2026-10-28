import type { MemberSummary } from '@musterd/protocol';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { allowanceChips, type AllowanceChipMember, type AllowanceLine } from './allowanceLine';
import { MemberFace } from './MemberFace';

/** The card's width (Live.css `.lc-allow__card`) and its least distance from the viewport edge. */
const CARD_WIDTH = 280;
const EDGE = 12;

/**
 * Each human's accounts, in the /live top bar (ADR 744, option C; ADR 745). One chip per human
 * with a reading: their face, their name, then every account by name with the percent used and a
 * thin bar of that share. A click opens the same accounts as rows. Agents are not painted.
 */
export function AllowanceChips({
  roster,
  you = null,
  now,
}: {
  roster: readonly MemberSummary[];
  /** The signed-in viewer, whose chip comes first. */
  you?: string | null;
  /** The clock, for tests; the component ticks its own every 30 s when unset. */
  now?: number;
}) {
  const tick = useHalfMinute(now === undefined);
  const at = now ?? tick;
  const chips = allowanceChips(roster as readonly AllowanceChipMember[], at, you);
  const faces = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const [open, setOpen] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const cardId = useId();

  // An outside press closes the card. Bound only while one is open.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!group.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Place the card under its chip, then pull it left so it keeps 12px from the viewport's edge:
  // a phone's chip row starts ~210px in, and a 280px card from there ran 100px off-screen.
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    const root = group.current;
    const chip = open ? root?.querySelector<HTMLElement>(`[data-allow="${CSS.escape(open)}"]`) : null;
    if (!root || !chip) return;
    const base = root.getBoundingClientRect().left;
    const width = Math.min(CARD_WIDTH, window.innerWidth - 2 * EDGE);
    const x = Math.max(EDGE, Math.min(chip.getBoundingClientRect().left, window.innerWidth - EDGE - width));
    setLeft(x - base);
  }, [open]);

  if (chips.length === 0) return null;
  const shown = chips.find((c) => c.name === open) ?? null;

  return (
    <div ref={group} className="lc-allow">
      {chips.map((chip) => {
        const top = chip.lines[0]!;
        return (
          <button
            key={chip.name}
            type="button"
            data-allow={chip.name}
            className={`lc-allow__chip${tone(top)}${open === chip.name ? ' is-open' : ''}`}
            aria-label={chip.label}
            aria-expanded={open === chip.name}
            aria-controls={open === chip.name ? cardId : undefined}
            onClick={() => setOpen((o) => (o === chip.name ? null : chip.name))}
            // The chip keeps focus while its card is open, so Escape lands here.
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || open !== chip.name) return;
              e.stopPropagation();
              setOpen(null);
            }}
          >
            <span className="lc-allow__face">
              <MemberFace name={chip.name} roster={faces} size={22} />
            </span>
            <span className="lc-allow__name">{chip.name}</span>
            {chip.lines.map((line) => (
              <span key={line.text} className={`lc-allow__acct${tone(line)}`}>
                {line.text}
                {line.suffixes.length > 0 && (
                  <span className="lc-allow__more"> {line.suffixes.join(' · ')}</span>
                )}
                <Track bar={line.bar} />
              </span>
            ))}
          </button>
        );
      })}
      {shown && (
        <div
          id={cardId}
          className="lc-allow__card"
          role="group"
          aria-label={`${shown.name}'s accounts`}
          style={{ left }}
        >
          <b className="lc-allow__who">{shown.name}</b>
          {shown.lines.map((line, i) => (
            <span key={i} className={`lc-allow__row${tone(line)}`} title={line.title}>
              <span className="lc-allow__words">
                {line.text}
                {line.suffixes.length > 0 && (
                  <span className="lc-allow__more"> {line.suffixes.join(' · ')}</span>
                )}
              </span>
              <Track bar={line.bar} />
            </span>
          ))}
          {shown.note && <span className="lc-allow__note">{shown.note}</span>}
        </div>
      )}
    </div>
  );
}

/** Quiet comes after warn, as on the 28px line: a stale low window is muted (ADR 723). */
function tone(line: AllowanceLine): string {
  return `${line.warn ? ' is-warn' : ''}${line.quiet ? ' is-quiet' : ''}`;
}

function Track({ bar }: { bar: number }) {
  return (
    <span className="lc-allow__track" aria-hidden="true">
      <i style={{ width: `${bar}%` }} />
    </span>
  );
}

/** A 30 s clock, so a reading turns quiet and its age moves on without an event. Paused while
 *  the tab is hidden. */
function useHalfMinute(on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    let id: number | undefined;
    const start = () => {
      setT(Date.now());
      id = window.setInterval(() => setT(Date.now()), 30_000);
    };
    const stop = () => window.clearInterval(id);
    const vis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [on]);
  return t;
}
