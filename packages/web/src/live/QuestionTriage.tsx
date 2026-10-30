import type { Envelope, MemberSummary } from '@musterd/protocol';
import { answerLabel } from '@musterd/protocol/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveFetchError, sendAct, type LiveConfig } from './client';
import { MemberFace } from './MemberFace';
import { waitedLabel, type QuestionCard } from './questions';
import { alreadyAnswered, answerOf, triageKey } from './triage';

/** Where a seat wakes, for the "Sent to …" line: its live presence's machine, else where it lives. */
function hostOf(m: MemberSummary | undefined): string {
  const live = m?.presences?.find((p) => p.node_label)?.node_label;
  return live ?? m?.residence?.node_label ?? 'its machine';
}

type Flash = { kind: 'sent'; text: string } | { kind: 'taken'; text: string } | { kind: 'error'; text: string };

/**
 * One decision at a time (seats ask 1e, plan Task 12; mockup question-card-v2). A modal sheet over
 * the room: the seat and how long it has waited, its lane, the question large, why it is asking,
 * the options keyed 1–9 with what each leads to, and a free-text line. Picking and typing combine.
 * `S` skips, `esc` closes; an answer slides the next card in. Rules for the keys are in `triage.ts`.
 */
export function QuestionTriage({
  cards,
  roster,
  cfg,
  recent,
  onClose,
  onAnswered,
}: {
  cards: QuestionCard[];
  roster: MemberSummary[];
  cfg: LiveConfig;
  /** The seat's last few acts, for "Show more". */
  recent: (seat: string) => Envelope[];
  onClose: () => void;
  /** The ack, folded in at once so the card leaves the list before the firehose copy lands. */
  onAnswered: (ack: Envelope) => void;
}) {
  // The queue is fixed when the sheet opens: a question arriving mid-triage joins at the end, and an
  // answered one never vanishes from under the cursor.
  const [queue, setQueue] = useState(() => cards.map((c) => c.id));
  useEffect(() => {
    setQueue((q) => [...q, ...cards.map((c) => c.id).filter((id) => !q.includes(id))]);
  }, [cards]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [more, setMore] = useState(false);
  const sheet = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const members = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);

  const card = byId.get(queue[at] ?? '') ?? null;
  const total = queue.length;

  const next = useCallback(() => {
    setPicked(null);
    setText('');
    setMore(false);
    if (at + 1 >= queue.length) onClose();
    else setAt((i) => i + 1);
  }, [at, queue.length, onClose]);

  const send = useCallback(async () => {
    if (!card || busy) return;
    const answer = answerOf(picked, text);
    if (answer.choice === undefined && answer.text === undefined) return;
    setBusy(true);
    try {
      const ack = await sendAct(cfg, {
        act: 'accept',
        to: { kind: 'member', name: card.asker },
        body: answerLabel(card.question, answer),
        meta: { in_reply_to: card.id, answer },
      });
      onAnswered(ack);
      setFlash({ kind: 'sent', text: `Sent to ${card.asker} — waking on ${hostOf(members.get(card.asker))}` });
      next();
    } catch (e) {
      const taken = e instanceof LiveFetchError && e.status === 409 ? alreadyAnswered(e.message) : null;
      if (taken) {
        setFlash({ kind: 'taken', text: `Already answered by ${taken.by} on ${taken.channel}` });
        window.setTimeout(next, 1200);
      } else {
        setFlash({ kind: 'error', text: e instanceof Error ? e.message : 'Could not send — try again' });
      }
    } finally {
      setBusy(false);
    }
  }, [card, busy, picked, text, cfg, onAnswered, members, next]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2600);
    return () => window.clearTimeout(t);
  }, [flash]);

  // Focus lands on the sheet, stays inside it, and the opener takes it back on close (WaitingOnYou).
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      const f = sheet.current?.querySelectorAll<HTMLElement>('button, textarea, [tabindex="0"]');
      if (f && f.length > 0) {
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = triageKey(e.key, {
      shift: e.shiftKey,
      inText: document.activeElement === box.current,
      options: card?.question.options?.length ?? 0,
      picked,
      text,
    });
    if (k.kind === 'none') return;
    e.preventDefault();
    if (k.kind === 'close') onClose();
    else if (k.kind === 'skip') next();
    else if (k.kind === 'send') void send();
    else setPicked(k.choice);
  };

  if (!card) return null;
  const ctx = card.question.context;
  return (
    <div className="qt">
      <button type="button" className="qt__backdrop" tabIndex={-1} aria-label="Close" onClick={onClose} />
      {/* The dialog owns its keys (1–9, S, ↵, esc, Tab trap) — the modal pattern Board.tsx uses too. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={sheet}
        className="qt__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qt-question"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="qt__head">
          <ol className="qt__dots" aria-hidden="true">
            {queue.map((id, i) => (
              <li key={id} className={i < at ? 'is-done' : i === at ? 'is-now' : ''} />
            ))}
          </ol>
          <span className="qt__count">
            {at + 1} of {total} waiting
          </span>
          <button type="button" className="qt__x" onClick={onClose} aria-label="Close">
            esc
          </button>
        </div>

        <article key={card.id} className="qt__card">
          <header className="qt__who">
            <MemberFace name={card.asker} roster={members} size={34} />
            <div className="qt__whoText">
              <span className="qt__seat">{card.asker}</span>
              {(ctx?.lane || ctx?.pr || ctx?.branch) && (
                <span className="qt__ctx">
                  {[card.laneTitle ?? ctx?.lane, ctx?.pr ? `#${ctx.pr}` : null, ctx?.branch]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>
            <span className={`qt__pill${card.question.blocking ? ' is-blocking' : ''}`}>
              {card.question.blocking ? 'blocked' : 'waiting'} · {waitedLabel(card.waitedMs)}
            </span>
          </header>

          <h2 id="qt-question" className="qt__q">
            {card.question.text}
          </h2>
          {card.question.why && <p className="qt__why">{card.question.why}</p>}

          {card.question.options && card.question.options.length > 0 && (
            <div className="qt__opts" role="radiogroup" aria-label="Options">
              {card.question.options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={picked === i}
                  className={`qt__opt${picked === i ? ' is-picked' : ''}`}
                  onClick={() => setPicked(picked === i ? null : i)}
                >
                  <kbd className="qt__key">{i + 1}</kbd>
                  <span className="qt__optText">
                    <span className="qt__label">{o.label}</span>
                    {o.consequence && <span className="qt__cons">{o.consequence}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}

          <label className="qt__text">
            <span className="lc-sr">Reply to {card.asker}</span>
            <textarea
              ref={box}
              rows={2}
              value={text}
              placeholder={`Or tell ${card.asker} something else…`}
              onChange={(e) => setText(e.target.value)}
            />
          </label>

          {card.undelivered && (
            <p className="qt__undelivered" role="status">
              Didn&rsquo;t reach {card.asker}
            </p>
          )}

          {more && (
            <ol className="qt__more" aria-label={`${card.asker}'s last steps`}>
              {recent(card.asker).map((e) => (
                <li key={e.id}>
                  <span className="qt__moreAct">{e.act.replace('_', ' ')}</span>
                  <span className="qt__moreBody">{(e.body ?? '').split('\n')[0]}</span>
                </li>
              ))}
            </ol>
          )}

          <footer className="qt__foot">
            <button type="button" className="qt__link" onClick={() => setMore((m) => !m)}>
              {more ? 'Show less' : 'Show more'}
            </button>
            <span className="qt__hints" aria-hidden="true">
              <kbd>S</kbd> skip · <kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line
            </span>
            <button type="button" className="qt__skip" onClick={next}>
              Skip
            </button>
            <button
              type="button"
              className="qt__send"
              disabled={busy || (picked === null && text.trim() === '')}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </footer>
        </article>

        {flash && (
          <p className={`qt__flash is-${flash.kind}`} role="status">
            {flash.text}
          </p>
        )}
      </div>
    </div>
  );
}
