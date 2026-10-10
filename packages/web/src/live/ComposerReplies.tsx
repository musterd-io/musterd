import type { MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import { askIsLoud, SPECIES_VERB_YOU, type AskView } from './asks';
import {
  answeredLine,
  seatState,
  type ComposerThread as Thread,
  type SeatState,
} from './composerThread';
import { clock } from './format';
import { MemberFace } from './MemberFace';
import { displayModel } from './modelBadge';

/**
 * The thread panel over the composer (lane 01M4KY55N1). The viewer's sentence comes first, on the
 * right, as a sent message. Each reply follows on the left, with the face the room draws, the
 * member's name, the model that wrote it and the time. An ask to the viewer is a card in the same
 * column, with the asks strip's three answers, so nick answers it without leaving the box. Above it
 * all, the cast and one quiet line: "{n} of {m} have answered".
 *
 * Static apart from the arrival of a line (`cthread-in`). The only motion that loops is the waking
 * ring, and only while a seat is actually being woken (designer tell: motion means now).
 */

const TICK = 'M3.5 8.5 6.5 11.5 12.5 5';

/** A face with what this seat is doing about the thread: a tick once it answered, a ring while waking. */
export function SeatFace({
  name,
  idx,
  state,
  size,
}: {
  name: string;
  idx: Map<string, MemberSummary>;
  state: SeatState;
  size: number;
}) {
  return (
    <span className={`cseat is-${state}`} title={state === 'waking' ? `${name} — waking…` : name}>
      <MemberFace name={name} roster={idx} size={size} />
      {state === 'replied' && (
        <svg className="cseat__tick" viewBox="0 0 16 16" aria-label="answered">
          <path d={TICK} />
        </svg>
      )}
    </span>
  );
}

export function ComposerThreadPanel({
  thread,
  idx,
  viewer,
  busy,
  onAnswer,
  onHide,
}: {
  thread: Thread;
  idx: Map<string, MemberSummary>;
  viewer: string;
  /** The ask id an answer is in flight for. */
  busy: string | null;
  onAnswer: (ask: AskView, kind: 'accept' | 'decline' | 'deciding') => void;
  onHide: () => void;
}) {
  const states = thread.cast.map((name) => [name, seatState(name, thread, idx.get(name))] as const);
  const waking = states.some(([, s]) => s === 'waking');
  // The newest line stays in view as replies arrive, unless the reader has scrolled up to read.
  const list = useRef<HTMLOListElement | null>(null);
  const pinned = useRef(true);
  const count = thread.lines.length + thread.asks.length;
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  // Lines and asks interleave by time, so a question lands where it was asked.
  const items = [
    ...thread.lines.map((l) => ({ ts: l.env.ts, key: l.env.id, line: l, ask: null })),
    ...thread.asks.map((a) => ({ ts: a.env.ts, key: a.env.id, line: null, ask: a })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <section className={`cthread${thread.closed ? ' is-closed' : ''}`} aria-label="Replies">
      <header className="cthread__head">
        <span className="cthread__cast" aria-hidden="true">
          {states.map(([name, s]) => (
            <SeatFace key={name} name={name} idx={idx} state={s} size={26} />
          ))}
        </span>
        <span className="cthread__count" aria-live="polite">
          {answeredLine(thread)}
          {waking && <span className="cthread__waking"> · waking…</span>}
          {thread.closed && <span className="cthread__closed"> · closed</span>}
        </span>
        <button type="button" className="cthread__hide" aria-label="Hide replies" title="Hide" onClick={onHide}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </header>
      <ol
        className="cthread__lines"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <li className="cthread__msg is-mine">
          <Bubble text={thread.sentence} />
          <time className="cthread__time">{clock(thread.root.ts)}</time>
        </li>
        {items.map(({ key, line, ask }) =>
          line ? (
            line.env.from === viewer ? (
              <li key={key} className="cthread__msg is-mine">
                <Bubble text={line.env.body} />
                <time className="cthread__time">{clock(line.env.ts)}</time>
              </li>
            ) : (
              <li key={key} className="cthread__msg">
                <MemberFace name={line.env.from} roster={idx} size={30} />
                <div className="cthread__col">
                  <Byline name={line.env.from} model={line.env.meta?.['model']} ts={line.env.ts} direct={line.direct} />
                  <Bubble text={line.env.body} />
                </div>
              </li>
            )
          ) : (
            <li key={key} className="cthread__msg">
              <MemberFace name={ask!.env.from} roster={idx} size={30} />
              <AskCard ask={ask!} viewer={viewer} busy={busy === ask!.env.id} onAnswer={onAnswer} />
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

function Byline({ name, model, ts, direct }: { name: string; model: unknown; ts: number; direct: boolean }) {
  const m = displayModel(typeof model === 'string' ? model : null);
  return (
    <div className="cthread__by">
      <b>{name}</b>
      {m && <span className="cthread__model">{m}</span>}
      <time className="cthread__time">{clock(ts)}</time>
      {direct && <span className="cthread__direct">to you</span>}
    </div>
  );
}

/** Replies run long. A bubble shows its first few lines and opens on a click; short ones never clamp. */
function Bubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split('\n').length > 6;
  if (!long) return <p className="cthread__bubble">{text.trim()}</p>;
  return (
    <button
      type="button"
      className={`cthread__bubble is-long${open ? ' is-open' : ''}`}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    >
      {text.trim()}
    </button>
  );
}

/** How a settled ask reads in the thread. Who answered is named, because it may not have been you. */
function settledLine(ask: AskView, viewer: string): string | null {
  const who = !ask.answeredBy || ask.answeredBy === viewer ? 'You' : ask.answeredBy;
  switch (ask.state) {
    case 'accepted':
      return `${who} approved`;
    case 'declined':
      return `${who} said no`;
    case 'deferred':
      return `${who === 'You' ? 'You are' : `${who} is`} deciding — they check back in an hour`;
    case 'resolved':
      return 'Settled';
    case 'lapsed':
    case 'risk_accepted':
      return 'The clock ran out, so they went ahead';
    default:
      return null;
  }
}

function AskCard({
  ask,
  viewer,
  busy,
  onAnswer,
}: {
  ask: AskView;
  viewer: string;
  busy: boolean;
  onAnswer: (ask: AskView, kind: 'accept' | 'decline' | 'deciding') => void;
}) {
  const mine = ask.to === viewer || ask.to === null;
  const open = askIsLoud(ask.state);
  return (
    <div className={`cthread__col cthread__ask${open ? ' is-open' : ''}`}>
      <div className="cthread__by">
        <b>{ask.env.from}</b>
        <span className="cthread__asks">{mine ? SPECIES_VERB_YOU[ask.species] : `asks ${ask.to}`}</span>
        <time className="cthread__time">{clock(ask.env.ts)}</time>
      </div>
      {ask.env.body && <Bubble text={ask.env.body} />}
      {open && mine ? (
        <div className="cthread__answers">
          <button type="button" disabled={busy} className="cthread__ans is-yes" onClick={() => onAnswer(ask, 'accept')}>
            Approve
          </button>
          <button type="button" disabled={busy} className="cthread__ans" onClick={() => onAnswer(ask, 'decline')}>
            Deny
          </button>
          <button type="button" disabled={busy} className="cthread__ans is-quiet" onClick={() => onAnswer(ask, 'deciding')}>
            Deciding — 1h
          </button>
        </div>
      ) : (
        !open && settledLine(ask, viewer) && <p className="cthread__settled">{settledLine(ask, viewer)}</p>
      )}
    </div>
  );
}
