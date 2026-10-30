import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveConfig } from './client';
import { MemberFace } from './MemberFace';
import { QuestionTriage } from './QuestionTriage';
import { deriveQuestions, waitedLabel } from './questions';
import './WaitingOnYou.css';

/**
 * "Waiting on you · N" (seats ask 1e, plan Task 11): the seats' open questions to this person, at
 * rest — one calm row each with the seat, its question in one line, what it is working on and how
 * long it has waited. **Answer all** or ⌘K/Ctrl+K opens the one-card-at-a-time triage. Renders
 * nothing when nobody is waiting. A lazy chunk: a viewer with no questions never downloads it.
 */
export function WaitingOnYou({
  roster,
  cfg,
  envelopes,
  board = null,
}: {
  roster: MemberSummary[];
  cfg: LiveConfig;
  envelopes: Envelope[];
  board?: LaneBoard | null;
}) {
  // Answers this browser just sent fold in at once, so a card leaves before the firehose copy lands;
  // the clock ticks the waits.
  const [answeredHere, setAnsweredHere] = useState<Envelope[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const cards = useMemo(
    () => deriveQuestions([...envelopes, ...answeredHere], cfg.as, now, board),
    [envelopes, answeredHere, cfg.as, now, board],
  );
  const onAnswered = useCallback((ack: Envelope) => setAnsweredHere((a) => [...a, ack]), []);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const members = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && cards.length > 0) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards.length]);

  const recent = useCallback(
    (seat: string) =>
      envelopes
        .filter((e) => e.from === seat)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5),
    [envelopes],
  );

  if (cards.length === 0) return null;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <section className="wy" aria-labelledby="wy-title">
      <header className="wy__head">
        <h2 id="wy-title" className="wy__title">
          Waiting on you <span className="wy__n">· {cards.length}</span>
        </h2>
        <button ref={opener} type="button" className="wy__all" onClick={() => setOpen(true)}>
          Answer all <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </header>
      <ul className="wy__list">
        {cards.map((c) => (
          <li key={c.id} className="wy__row">
            <MemberFace name={c.asker} roster={members} size={26} />
            <div className="wy__body">
              <p className="wy__q">{c.question.text}</p>
              <p className="wy__meta">
                <span className="wy__seat">{c.asker}</span>
                {c.laneTitle && <span className="wy__lane"> · {c.laneTitle}</span>}
              </p>
            </div>
            <span className={`wy__age${c.question.blocking ? ' is-blocking' : ''}`}>
              {waitedLabel(c.waitedMs)}
            </span>
          </li>
        ))}
      </ul>
      {open && (
        <QuestionTriage
          cards={cards}
          roster={roster}
          cfg={cfg}
          recent={recent}
          onClose={close}
          onAnswered={onAnswered}
        />
      )}
    </section>
  );
}
