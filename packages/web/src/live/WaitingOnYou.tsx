import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SPECIES_VERB_YOU } from './asks';
import type { LiveConfig } from './client';
import { MemberFace } from './MemberFace';
import { QuestionTriage } from './QuestionTriage';
import { askItemsFor, deriveQuestions, itemLine, waitedLabel, waitingItems } from './questions';
import { useAskViews, type AskViews } from './useAskViews';
import './WaitingOnYou.css';

/**
 * "Waiting on you · N" (seats ask 1e, plan Task 11): everything a seat has put to this person, at
 * rest — one calm row each with the seat, its question in one line, what it is about and how long
 * it has waited. **Answer all** or ⌘K/Ctrl+K opens the one-card-at-a-time triage. Renders nothing
 * when nobody is waiting. A lazy chunk: a viewer with no questions never downloads it.
 *
 * Since lane 01M6DBDSGH this is the one list (spec 2026-10-30: "one place to look"): a seat's
 * question (ADR 773) and any other ask routed to the reader by name — an approval, an escalation, a
 * lane review — are rows here, and the rail below keeps only the team pool and other people's asks.
 */
export function WaitingOnYou({
  roster,
  cfg,
  envelopes,
  board = null,
  views,
}: {
  roster: MemberSummary[];
  cfg: LiveConfig;
  envelopes: Envelope[];
  board?: LaneBoard | null;
  /** The page's shared ask derivation; rendered alone, the list derives its own. */
  views?: AskViews;
}) {
  // Answers this browser just sent fold in at once, so a card leaves before the firehose copy lands;
  // the clock ticks the waits.
  const [answeredHere, setAnsweredHere] = useState<Envelope[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const own = useAskViews({ cfg, roster, board, envelopes, enabled: views === undefined });
  const v = views ?? own;
  const questions = useMemo(
    () => deriveQuestions([...envelopes, ...answeredHere], cfg.as, now, board),
    [envelopes, answeredHere, cfg.as, now, board],
  );
  const items = useMemo(
    () => waitingItems(questions, askItemsFor(v.asks, v.ctx, now)),
    [questions, v.asks, v.ctx, now],
  );
  const onAnswered = useCallback(
    (ack: Envelope) => {
      setAnsweredHere((a) => [...a, ack]);
      v.addLocal(ack);
    },
    [v],
  );
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const members = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && items.length > 0) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length]);

  const recent = useCallback(
    (seat: string) =>
      envelopes
        .filter((e) => e.from === seat)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 5),
    [envelopes],
  );

  if (items.length === 0) return null;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <section className="wy" aria-labelledby="wy-title">
      <header className="wy__head">
        <h2 id="wy-title" className="wy__title">
          Waiting on you <span className="wy__n">· {items.length}</span>
        </h2>
        <button ref={opener} type="button" className="wy__all" onClick={() => setOpen(true)}>
          Answer all <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </header>
      <ul className="wy__list">
        {items.map((it) => {
          const blocking =
            it.kind === 'question' ? it.card.question.blocking : it.ask.tier === 'blocking';
          return (
            <li key={it.id} className={`wy__row wy__row--${it.kind}`}>
              <MemberFace name={it.asker} roster={members} size={24} />
              <div className="wy__body">
                <p className="wy__q">{itemLine(it)}</p>
                <p className="wy__meta">
                  <span className="wy__seat">{it.asker}</span>
                  {it.kind === 'question' && it.card.laneTitle && (
                    <span className="wy__lane"> · {it.card.laneTitle}</span>
                  )}
                  {it.kind === 'ask' && (
                    <span className="wy__lane"> · {SPECIES_VERB_YOU[it.ask.species]}</span>
                  )}
                </p>
              </div>
              <span className={`wy__age${blocking ? ' is-blocking' : ''}`}>
                {waitedLabel(it.waitedMs)}
              </span>
            </li>
          );
        })}
      </ul>
      {open && (
        <QuestionTriage
          items={items}
          roster={roster}
          cfg={cfg}
          now={v.now}
          recent={recent}
          onClose={close}
          onAnswered={onAnswered}
        />
      )}
    </section>
  );
}
