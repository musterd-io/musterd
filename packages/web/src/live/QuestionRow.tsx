import type { Envelope, MemberSummary } from '@musterd/protocol';
import { answerLabel } from '@musterd/protocol/wire';
import { useCallback, useState, type CSSProperties } from 'react';
import { sendAct, type LiveConfig } from './client';
import { hueOf, initial, kindOf, memberDisc } from './format';
import { waitedLabel, type QuestionCard } from './questions';
import { Refusal, refusalOf } from './Refusal';
import { type Refusal as RefusalCopy } from './refusalCopy';
import { answerOf } from './triage';

/**
 * A seat's question (ADR 773) as a row of the asks rail's sheet (lane 01M6EP0ZR9) — the same
 * `lc-ask` card every other ask is, with what a question needs that an approval does not: the
 * options keyed 1–9, each with what it leads to, and a line to say something else. A pick is the
 * answer; text sends with ↵ (⇧↵ for a newline). The ack folds in at once (`onAnswered`), so the row
 * leaves before the firehose copy lands. The daemon's 409 (answered elsewhere) is said in place.
 *
 * Before this the questions had a card of their own above the rail and a modal over the room
 * (seats ask 1e, Task 11/12); nick, 2026-11-02: the rail is the surface he likes, so this is a row.
 */
export function QuestionRow({
  card,
  idx,
  cfg,
  canAnswer,
  onAnswered,
  onReveal,
  style,
}: {
  card: QuestionCard;
  idx: Map<string, MemberSummary>;
  cfg: LiveConfig;
  canAnswer: boolean;
  onAnswered: (ack: Envelope) => void;
  onReveal: (id: string) => void;
  style?: CSSProperties;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<RefusalCopy | null>(null);
  const from = card.asker;
  const q = card.question;
  const options = q.options ?? [];

  const send = useCallback(
    async (picked: number | null) => {
      const answer = answerOf(picked, text);
      if (answer.choice === undefined && answer.text === undefined) return;
      setBusy(true);
      setNote(null);
      try {
        const ack = await sendAct(cfg, {
          act: 'accept',
          to: { kind: 'member', name: from },
          body: answerLabel(q, answer),
          meta: { in_reply_to: card.id, answer },
        });
        onAnswered(ack);
      } catch (e) {
        setNote(refusalOf(e));
      } finally {
        setBusy(false);
      }
    },
    [cfg, from, q, card.id, text, onAnswered],
  );

  const ctx = [card.laneTitle, q.context?.pr ? `#${q.context.pr}` : null, q.context?.branch]
    .filter(Boolean)
    .join(' · ');

  return (
    <article className={`lc-ask lc-ask--open lc-ask--question${q.blocking ? ' is-blocking' : ''}`} style={style}>
      <div className="lc-ask__main">
        <div className="lc-ask__head">
          <span className="lc-chip__avatar" style={{ ...memberDisc(from, kindOf(from, idx), hueOf(from, idx)) }}>
            {initial(from)}
          </span>
          <span className="lc-ask__verb">
            <b>{from}</b> asks you
            {ctx && <span className="lc-asks__routed"> · {ctx}</span>}
          </span>
          <span className={`lc-ask__hold lc-ask__hold--${q.blocking ? 'blocking' : 'advisory'}`}>
            {q.blocking ? 'blocked' : 'waiting'} · {waitedLabel(card.waitedMs)}
          </span>
        </div>
        <button type="button" className="lc-ask__body lc-ask__body--q" onClick={() => onReveal(card.id)} title="Open this question in the log">
          {q.text}
        </button>
        {q.why && <p className="lc-ask__why">{q.why}</p>}
      </div>
      <span className="lc-ask__clock">{waitedLabel(card.waitedMs)}</span>
      {canAnswer && (
        <div className="lc-ask__actions lc-ask__actions--choice">
          {options.length > 0 && (
            <div className="lc-choices" role="group" aria-label={`${from}’s options`}>
              {options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={busy}
                  style={{ '--i': i } as CSSProperties}
                  className="lc-choice"
                  onClick={() => void send(i)}
                >
                  <span className="lc-choice__key" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="lc-choice__text">
                    {o.label}
                    {o.consequence && <span className="lc-choice__cons"> — {o.consequence}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <label className="lc-ask__reply">
            <span className="lc-sr">Reply to {from}</span>
            <textarea
              rows={1}
              value={text}
              disabled={busy}
              placeholder={`Or tell ${from} something else…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(null);
                }
              }}
            />
            <button
              type="button"
              className="lc-ask__btn lc-ask__btn--accept"
              disabled={busy || text.trim() === ''}
              onClick={() => void send(null)}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          </label>
          {note && <Refusal refusal={note} className="lc-ask__note" />}
        </div>
      )}
    </article>
  );
}
