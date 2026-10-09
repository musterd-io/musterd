import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { sendAct, type LiveConfig } from './client';
import { rosterIndex } from './format';
import { MemberFace } from './MemberFace';
import { audienceFor, MAX_CAST, promptAct } from './promptAct';
import './PromptBar.css';

/**
 * The /live composer (lanes 01M4H4ARQC, 01M4H7MNN4): nick types to the team on the projector, the way
 * the future musterd chat would feel — one floating box, the team's faces beside it, an address chip,
 * a gold send. A lazy chunk mounted only behind `?promptbar=1` AND a signed-in admin, so the default
 * /live carries none of it. Never on /broadcast.
 *
 * "@team" (nobody picked) convenes the four-seat set the first bar used; picking narrows it
 * (`audienceFor`). Either way it sends ONE envelope through `sendAct`, the shape `musterd huddle open`
 * sends (`promptAct.ts`). Copy is product-communications' (alfie), verbatim.
 */

const FACES = 5;

/** The reader's collapse choice — a per-viewer convenience, so browser storage, guarded. */
const OPEN_KEY = 'musterd.live.composer';
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};
/** Open unless the reader collapsed it last time; open too when storage cannot be read. */
export function composerOpenFrom(s: Store | null): boolean {
  try {
    return s?.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}
/** How long the sent line holds above the composer before it fades. */
const ECHO_MS = 3600;

export function PromptBar({
  cfg,
  roster,
  viewer,
  onSent,
}: {
  cfg: LiveConfig;
  roster: readonly MemberSummary[];
  /** The signed-in member — whose face the sent line floats from. */
  viewer: string;
  /** The firehose skips the sender, so the route folds the ack in itself (the AsksStrip precedent). */
  onSent: (ack: Envelope) => void;
}) {
  const idx = rosterIndex(roster as MemberSummary[]);
  const members = roster.filter((m) => m.kind !== 'service' && m.name !== viewer);
  // Here first, then the rest — the faces say the team is listening.
  const listening = [...members].sort(
    (a, b) => Number(b.presence !== 'offline') - Number(a.presence !== 'offline'),
  );
  const [open, setOpenState] = useState(() => composerOpenFrom(store()));
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      store()?.setItem(OPEN_KEY, next ? 'open' : 'closed');
    } catch {
      /* private mode — the choice just is not remembered */
    }
    if (!next) setPicking(false);
  };
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [echo, setEcho] = useState<{ key: number; text: string; leaving?: true } | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);

  // Held for ECHO_MS, then the exit transition (--lc-dur-5, 600ms) plays before it unmounts — the
  // motion scale owns both ends; only the hold is a plain timer.
  useEffect(() => {
    if (!echo) return;
    const t = echo.leaving
      ? window.setTimeout(() => setEcho(null), 600)
      : window.setTimeout(() => setEcho((e) => (e ? { ...e, leaving: true } : e)), ECHO_MS);
    return () => window.clearTimeout(t);
  }, [echo]);

  const ready = text.trim().length > 0 && !sending;
  const send = async () => {
    const act = promptAct(text, audienceFor(picked), crypto.randomUUID());
    if (!act || sending) return;
    setSending(true);
    setError('');
    try {
      const ack = await sendAct(cfg, act);
      onSent(ack);
      setEcho({ key: Date.now(), text: text.trim() });
      setText('');
      if (input.current) input.current.style.height = '';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === '@') {
      // "@" opens the picker rather than typing the character: addressing is a choice, not text.
      e.preventDefault();
      setPicking(true);
    } else if (e.key === 'Escape' && picking) {
      setPicking(false);
    }
  };
  // Picking closes the list and puts you back in the sentence (nick, 2026-10-09: a list that stayed open
  // after choosing ghost had no obvious way out). "@" again adds another; picking a chosen name removes it.
  const toggle = (name: string) => {
    setPicked((cur) =>
      cur.includes(name)
        ? cur.filter((n) => n !== name)
        : cur.length < MAX_CAST
          ? [...cur, name]
          : cur,
    );
    setPicking(false);
    window.setTimeout(() => input.current?.focus(), 0);
  };
  // …and Escape or a click anywhere outside the composer closes it too.
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!picking) return;
    const away = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setPicking(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPicking(false);
      input.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [picking]);
  const address = picked.length === 0 ? '@team' : picked.map((n) => `@${n}`).join(' ');

  if (!open) {
    return (
      <div className="pbar is-collapsed">
        <button
          type="button"
          className="pbar__fab"
          aria-expanded={false}
          aria-label="Open the chat bar"
          onClick={() => {
            setOpen(true);
            window.setTimeout(() => input.current?.focus(), 0);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1.5 1.5 0 0 1 3 9.5z" />
          </svg>
          Ask your team
          {text.trim() && <span className="pbar__draft" aria-label="you have a draft" />}
        </button>
      </div>
    );
  }

  return (
    <div className="pbar" ref={root}>
      {echo && (
        <div className={`pbar__echo${echo.leaving ? ' is-leaving' : ''}`} key={echo.key}>
          <MemberFace name={viewer} roster={idx} size={24} />
          <p className="pbar__echotext">{echo.text}</p>
        </div>
      )}
      {picking && (
        <div className="pbar__pick" role="listbox" aria-label="Pick who hears it" aria-multiselectable="true">
          {members.map((m) => {
            const on = picked.includes(m.name);
            const here = m.presence !== 'offline';
            return (
              <button
                key={m.name}
                type="button"
                role="option"
                aria-selected={on}
                className={`pbar__who${on ? ' is-on' : ''}`}
                onClick={() => toggle(m.name)}
              >
                <MemberFace name={m.name} roster={idx} size={26} />
                <span className="pbar__whoname">{m.name}</span>
                <span className={`pbar__whostate${here ? ' is-here' : ''}`}>
                  {here ? 'here' : 'asleep'}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="pbar__box">
        <button
          type="button"
          className="pbar__min"
          aria-expanded={true}
          aria-label="Collapse the chat bar"
          title="Collapse"
          onClick={() => setOpen(false)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6.5 8 10.5l4-4" />
          </svg>
        </button>
        <span className="pbar__faces" aria-hidden="true">
          {listening.slice(0, FACES).map((m) => (
            <MemberFace key={m.name} name={m.name} roster={idx} size={24} />
          ))}
          {listening.length > FACES && (
            <span className="pbar__more">+{listening.length - FACES}</span>
          )}
        </span>
        <button
          type="button"
          className={`pbar__to${picked.length ? ' is-picked' : ''}`}
          aria-expanded={picking}
          title="@ to pick who"
          onClick={() => setPicking((p) => !p)}
        >
          {address}
        </button>
        <textarea
          ref={input}
          className="pbar__input"
          rows={1}
          value={text}
          placeholder="Ask your team anything"
          aria-label="Ask your team anything"
          onChange={(e) => {
            setText(e.target.value);
            setError('');
            // Grow with the sentence (to the CSS max) instead of scrolling a one-line box.
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
          }}
          onKeyDown={onKey}
          disabled={sending}
        />
        <span className="pbar__hint" aria-hidden="true">
          {picked.length ? '↵' : '@ to pick who · ↵'}
        </span>
        <button
          type="button"
          className={`pbar__send${ready ? ' is-ready' : ''}`}
          onClick={() => void send()}
          disabled={!ready}
          aria-label="Send"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </button>
      </div>
      {error && (
        <p className="pbar__error" role="alert">
          Couldn&apos;t send: {error}. Your text is still here.
        </p>
      )}
    </div>
  );
}
