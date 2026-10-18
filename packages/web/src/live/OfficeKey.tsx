import { useState, type ReactElement } from 'react';

const KEY = 'musterd.live.key';

const SKIN = '#d9a273';
const WOOD = '#b07a45';

/**
 * Each state as a small picture of what you will see on the floor (2026-10-18, goal live-delight: a
 * key of words alone read as a form). Drawn flat in the scene's own wood, paper and mustard; the
 * words stay beside them, so the picture is a reminder, never the only telling.
 */
const ROWS: [ReactElement, string, string][] = [
  [
    <>
      <rect x="7" y="2" width="11" height="8" rx="1.2" fill="#2f3a44" />
      <rect x="8.2" y="3.2" width="8.6" height="5.6" rx="0.6" fill="#8fc1d4" />
      <circle cx="6" cy="10" r="3" fill={SKIN} />
      <rect x="1" y="13" width="22" height="2.4" rx="1" fill={WOOD} />
      <rect x="3" y="15.4" width="2" height="4" fill={WOOD} />
      <rect x="19" y="15.4" width="2" height="4" fill={WOOD} />
    </>,
    'at a desk',
    'working',
  ],
  [
    <>
      <circle cx="12" cy="7" r="3" fill={SKIN} />
      <rect x="2" y="9" width="20" height="6" rx="2.5" fill="#e3b341" />
      <rect x="1" y="11" width="4" height="6" rx="1.5" fill="#c99a2e" />
      <rect x="19" y="11" width="4" height="6" rx="1.5" fill="#c99a2e" />
      <rect x="4" y="15" width="16" height="3" rx="1" fill="#c99a2e" />
    </>,
    'on the couch',
    'between tasks',
  ],
  [
    <>
      <path d="M4 7h16v11H4z" fill="#c9955b" />
      <path d="M4 7l3-4h10l3 4z" fill="#ddb07a" />
      <rect x="10.5" y="7" width="3" height="11" fill="#e8d3a8" />
    </>,
    'carrying a box',
    'handing off',
  ],
  [
    <path
      d="M8 18c-2-1.5-4-4-4.6-6.6-.3-1.1 1.2-1.6 1.8-.6L7 13V4.6c0-1.3 1.9-1.3 1.9 0V10h.4V3.2c0-1.3 1.9-1.3 1.9 0V10h.4V3.8c0-1.3 1.9-1.3 1.9 0V10h.4V5.6c0-1.3 1.9-1.3 1.9 0V12c0 3-1 5-3 6z"
      fill="#f2c24f"
      stroke="#b8860b"
      strokeWidth="0.8"
      strokeLinejoin="round"
    />,
    'a raised hand',
    'asking a human',
  ],
  [
    <>
      <rect x="2" y="1" width="20" height="18" rx="1.5" fill="#c98f55" />
      <path d="M6 4h12v10l-3 3H6z" fill="#efe3c8" />
      <path d="M15 17v-3h3z" fill="#d8c7a2" />
      <rect x="8" y="7" width="7" height="1.2" rx="0.6" fill="#c8b48e" />
      <rect x="8" y="10" width="5" height="1.2" rx="0.6" fill="#c8b48e" />
      <circle cx="12" cy="4.5" r="1.3" fill="#b8860b" />
    </>,
    'a faded card',
    'a plan that stopped',
  ],
];

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
        {ROWS.map(([pic, said, means]) => (
          <li key={said}>
            <svg className="lc-office__key-pic" viewBox="0 0 24 20" aria-hidden="true">
              {pic}
            </svg>
            <b>{said}</b> {means}
          </li>
        ))}
      </ul>
    </aside>
  );
}
