import { useState } from 'react';

const KEY = 'musterd.live.key';

/**
 * "How to read the office" (ADR 464 §3.4): the four postures a stranger needs to know, in one
 * corner card. Open by default; a close is remembered on this browser, because a key you have
 * read once is clutter the second time.
 */
export function OfficeKey() {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(KEY) !== '0';
    } catch {
      return true;
    }
  });
  if (!open) return null;
  const close = () => {
    setOpen(false);
    try {
      window.localStorage.setItem(KEY, '0');
    } catch {
      /* private mode — the key simply comes back next visit */
    }
  };
  return (
    <aside className="lc-office__key" aria-label="How to read the office" data-open="true">
      <div className="lc-office__key-head">
        <span className="lc-office__key-title">How to read the office</span>
        <button
          type="button"
          className="lc-office__key-close"
          onClick={close}
          aria-label="Close the key"
        >
          ×
        </button>
      </div>
      <ul>
        <li>
          <b>at a desk</b> working
        </li>
        <li>
          <b>on the couch</b> between tasks
        </li>
        <li>
          <b>carrying a box</b> handing off
        </li>
        <li>
          <b>✋</b> asking a human
        </li>
      </ul>
    </aside>
  );
}
