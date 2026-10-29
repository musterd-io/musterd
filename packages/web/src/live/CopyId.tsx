import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { copyPayload, copyShortcut, copyText, shownId } from './idCopy';
import './CopyId.css';

/**
 * A card's ID, worn where you can read it and copied in one tap (lane 01M62KAMZ3). Click copies the
 * ID; ⇧-click copies the ID with its title, ready to paste into a chat. The keyboard has it too:
 * hover or focus a card and press `c` (⇧C for the title as well) — one listener for the whole page,
 * however many chips are mounted. The chip confirms in place — the label turns to "copied", a few
 * sparks fly — and says it to a screen reader.
 *
 * The card that owns the chip marks itself `data-cid-host`; that is how the shortcut finds which
 * chip a hovered or focused card means.
 */
export function CopyId({ kind, id, title }: { kind: 'lane' | 'goal'; id: string; title: string }) {
  const shown = shownId(kind, id);
  const ref = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'titled' | 'failed'>('idle');
  const [burst, setBurst] = useState(0);
  const [said, setSaid] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const copy = async (withTitle: boolean) => {
    const ok = await copyText(copyPayload(shown, title, withTitle));
    window.clearTimeout(timer.current);
    setState(ok ? (withTitle ? 'titled' : 'copied') : 'failed');
    if (ok) setBurst((b) => b + 1);
    setSaid(ok ? `Copied ${withTitle ? `${shown} and its title` : shown}` : `Could not copy ${shown}`);
    // A browser that refused the clipboard still lets a person copy a selection: select the ID, so
    // the "press ⌘C" the chip now says is true.
    if (!ok) {
      const label = ref.current?.querySelector('.cid__label');
      const sel = window.getSelection();
      if (label && sel) {
        const range = document.createRange();
        range.selectNodeContents(label);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: Event) => void copy((e as CustomEvent<{ withTitle: boolean }>).detail.withTitle);
    el.addEventListener('cid:copy', onKey);
    const release = holdShortcut();
    return () => {
      el.removeEventListener('cid:copy', onKey);
      release();
      window.clearTimeout(timer.current);
    };
    // `copy` reads only the props it closes over; re-binding on them is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, title]);

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void copy(e.shiftKey || e.altKey);
  };

  return (
    <span className="cid-wrap" data-state={state}>
      <button
        ref={ref}
        type="button"
        className={`cid cid--${kind}`}
        onClick={onClick}
        aria-label={`Copy ${kind} ID ${shown}`}
      >
        <span className="cid__face">
          <span className="cid__label">
            <span className="cid__hash" aria-hidden="true">
              #
            </span>
            {shown}
          </span>
          <span className="cid__done" aria-hidden="true">
            {state === 'failed' ? 'press ⌘C' : state === 'titled' ? '✓ with title' : '✓ copied'}
          </span>
        </span>
        <svg className="cid__icon" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
          <path d="M8.5 2.6V2.2c0-.7-.5-1.2-1.2-1.2H2.2C1.5 1 1 1.5 1 2.2v5.1c0 .7.5 1.2 1.2 1.2h.4" />
        </svg>
        {burst > 0 && (
          <span key={burst} className="cid__burst" aria-hidden="true">
            {SPARKS.map((s) => (
              <i key={s} style={{ ['--a' as string]: `${s}deg` }} />
            ))}
          </span>
        )}
      </button>
      <span className="cid__tip" aria-hidden="true">
        <span className="cid__tip-row">
          Copy ID
          <span>
            <kbd>C</kbd>
          </span>
        </span>
        <span className="cid__tip-row cid__tip-2">
          with its title
          <span>
            <kbd>⇧</kbd>
            <kbd>C</kbd>
          </span>
        </span>
      </span>
      <span className="lc-sr" role="status">
        {said}
      </span>
    </span>
  );
}

const SPARKS = [0, 60, 120, 180, 240, 300];

/* One keydown listener for the page, held while any chip is mounted. */
let holders = 0;
function onShortcut(e: KeyboardEvent): void {
  const hit = copyShortcut(e);
  if (!hit) return;
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-cid-host]');
  const hovered = [...document.querySelectorAll<HTMLElement>('[data-cid-host]:hover')].pop();
  const chip = (focused ?? hovered)?.querySelector<HTMLButtonElement>('.cid');
  if (!chip) return;
  e.preventDefault();
  chip.dispatchEvent(new CustomEvent('cid:copy', { detail: hit }));
}
function holdShortcut(): () => void {
  if (holders++ === 0) document.addEventListener('keydown', onShortcut);
  return () => {
    if (--holders === 0) document.removeEventListener('keydown', onShortcut);
  };
}
