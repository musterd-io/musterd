import { lazy, Suspense, useEffect, useRef, useState } from 'react';

/** The card is drawn in its own chunk: /live's first paint carries the badge, not the rows (ADR 183). */
const VersionCard = lazy(() => import('./VersionCard'));

/** What the daemon says about itself on `/health` (all optional: an older daemon omits some). */
export interface DaemonInfo {
  release?: string | undefined;
  build?: string | undefined;
  epoch?: number | undefined;
  wire?: string | undefined;
  guidance?: number | undefined;
  schema?: number | undefined;
}

export const shortBuild = (build: string) => build.slice(0, 7);

/** The badge's words: the release when the daemon names one, else the build. Null before the read. */
export function versionLabel(info: DaemonInfo): string | null {
  if (info.release) return `v${info.release}`;
  return info.build ? shortBuild(info.build) : null;
}

/**
 * The version stamp (nick, 2026-10-22): a small mono badge beside the wordmark. On /live it opens a card
 * of every counter the daemon reports; on /broadcast (`still`) nobody can click, so it is the words alone.
 * There is no single musterd version — the release number is the one the packages share, and the rest
 * are separate counters — so the card names each rather than inventing one.
 */
export function VersionBadge({ info, still = false }: { info: DaemonInfo; still?: boolean }) {
  const label = versionLabel(info);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!label) return null;
  if (still) return <span className="lc-ver lc-ver--still">{label}</span>;
  return (
    <span className="lc-ver-wrap" ref={box}>
      <button
        type="button"
        className="lc-ver"
        aria-expanded={open}
        aria-controls="lc-ver-card"
        title="musterd versions"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <Suspense fallback={null}>
          <VersionCard info={info} />
        </Suspense>
      )}
    </span>
  );
}
