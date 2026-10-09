import type { Envelope } from '@musterd/protocol';
import { useState, type KeyboardEvent } from 'react';
import { sendAct, type LiveConfig } from './client';
import { CAST, MAX_CAST, promptAct } from './promptAct';
import './PromptBar.css';

/**
 * The demo prompt bar (lane 01M4H4ARQC, Demo Day 2026-10-09): nick types the live-demo request on
 * /live, on the projector, instead of in a terminal. A lazy chunk, mounted by the route only when
 * `?promptbar=1` is set AND the viewer is a signed-in human admin — so the default /live carries
 * none of it, its CSS included. Never on /broadcast.
 *
 * It sends ONE ordinary envelope through `sendAct`, the shape `musterd huddle open` sends
 * (`promptAct.ts`). Copy is product-communications' (alfie), verbatim.
 */
export function PromptBar({
  cfg,
  onSent,
}: {
  cfg: LiveConfig;
  /** The firehose skips the sender, so the route folds the ack in itself (the AsksStrip precedent). */
  onSent: (ack: Envelope) => void;
}) {
  const [text, setText] = useState('');
  const [on, setOn] = useState<readonly string[]>(CAST);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  // The room id is minted at send time; this one only answers "is there anything to send?".
  const ready = promptAct(text, on, 'ready') !== null;
  const send = async () => {
    const input = promptAct(text, on, crypto.randomUUID());
    if (!input || state === 'sending') return;
    setState('sending');
    try {
      const ack = await sendAct(cfg, input);
      onSent(ack);
      setText('');
      setState('sent');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };
  const toggle = (name: string) =>
    setOn((cur) =>
      cur.includes(name)
        ? cur.filter((n) => n !== name)
        : cur.length < MAX_CAST
          ? CAST.filter((n) => n === name || cur.includes(n))
          : cur,
    );
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="pbar">
      <div className="pbar__cast" role="group" aria-label="Who hears it">
        <span className="pbar__label" aria-hidden="true">
          Who hears it
        </span>
        {CAST.map((name) => (
          <button
            key={name}
            type="button"
            className={`pbar__chip${on.includes(name) ? ' is-on' : ''}`}
            aria-pressed={on.includes(name)}
            onClick={() => toggle(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <textarea
        className="pbar__input"
        rows={1}
        value={text}
        placeholder="Ask the team something real"
        aria-label="Ask the team something real"
        onChange={(e) => {
          setText(e.target.value);
          if (state !== 'sending') setState('idle');
        }}
        onKeyDown={onKey}
        disabled={state === 'sending'}
      />
      <button
        type="button"
        className="pbar__send"
        onClick={() => void send()}
        disabled={!ready || state === 'sending'}
      >
        {state === 'sending' ? 'Sending…' : 'Send to the team'}
      </button>
      <p className="pbar__status" role="status" aria-live="polite">
        {state === 'sent' && 'Sent. Watch the huddle open.'}
        {state === 'error' && `Couldn't send: ${error}. Your text is still here.`}
      </p>
    </div>
  );
}
