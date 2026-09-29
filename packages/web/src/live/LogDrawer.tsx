import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The log drawer (ADR 464, spec §5): every message, one keystroke away. It slides in from the right
 * over the team column and hosts today's `Stream` unchanged — the model stamp, the click-through,
 * the reply quotes and the windowed DOM all still work. `L` opens it (the route owns that key),
 * Escape closes it, and focus goes in on open and back to the opener on close.
 */
export function LogDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const back = opener.current;
      if (back instanceof HTMLElement) back.focus({ preventScroll: true });
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="lc-drawer"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        className="lc-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="lc-drawer__head">
          <span className="lc-drawer__title">{title}</span>
          <span className="lc-drawer__spacer" />
          <button
            type="button"
            className="lc-drawer__close"
            onClick={onClose}
            aria-label="Close the log"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        <div className="lc-drawer__body">{children}</div>
      </div>
    </div>
  );
}
