import './Wiki.css';
import type { WikiIndex, WikiPageEntry } from '@musterd/protocol';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { OPEN_TILT, shouldDismiss, zoomTransform } from '../boardOverlayMath';
import { getWiki, getWikiPage, type LiveConfig } from '../client';
import { repoWebBase } from '@musterd/protocol/wire';

/** Markdown shown as text when the daemon sent no HTML (a daemon from before ADR 754). */
function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Matches the CSS close transition, as the board and settings overlays do. */
const CLOSE_MS = 320;
/** Rows the contents list mounts at once; past it, typing narrows (the stream's windowing rule). */
const LIST_CAP = 300;
/** The page a wiki opens on when it has one, in this order. */
const FRONT_PAGES = ['readme.md', 'index.md', 'home.md'];

type PageState =
  | { state: 'idle' }
  | { state: 'loading'; path: string }
  | { state: 'ready'; path: string; html: string; hash: string }
  | { state: 'missing'; path: string };

function rememberKey(team: string): string {
  return `musterd.wiki.page.v1.${team}`;
}

/**
 * The Team's wiki, taken off the shelf (ADR 747, nick 2026-10-28). Opened from the left-wall
 * bookshelf, it comes off the wall out of the shelf's rect the way the board and settings do, and
 * goes back onto it to close. Dressed as a cloth-bound book: contents on the left page, the page you
 * are reading on the right; on a narrow screen one page at a time.
 *
 * Everything in it is read from the Team's repo by the daemon — this overlay keeps no copy and edits
 * nothing. A page is edited where it lives, in the repo, and shows up here once it merges.
 */
export function WikiOverlay({
  cfg,
  origin,
  isAdmin,
  onOpenSettings,
  onClose,
}: {
  cfg: LiveConfig;
  /** The shelf's viewport rect — where the book comes from and goes back to. */
  origin: DOMRect | null;
  /** Whether this viewer can link a wiki (the Team tab of settings). */
  isAdmin: boolean;
  /** Opens settings on the Team tab, for the "link a wiki" path. */
  onOpenSettings?: () => void;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [index, setIndex] = useState<WikiIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [page, setPage] = useState<PageState>({ state: 'idle' });
  const [query, setQuery] = useState('');
  /** Narrow screens show one page of the book at a time. */
  const [showing, setShowing] = useState<'contents' | 'page'>('contents');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect(), OPEN_TILT);
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        panel.style.transform = '';
        rootRef.current?.classList.add('is-in');
        panel.focus({ preventScroll: true });
      }),
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: origin is fixed per open
  }, []);

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    const panel = panelRef.current;
    rootRef.current?.classList.remove('is-in');
    if (panel && origin && !reduced) {
      panel.style.transform = zoomTransform(origin, panel.getBoundingClientRect(), OPEN_TILT);
    }
    closeTimer.current = window.setTimeout(onClose, CLOSE_MS);
  }, [closing, origin, reduced, onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldDismiss(e, false)) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    let live = true;
    getWiki(cfg)
      .then((idx) => {
        if (live) setIndex(idx);
      })
      .catch((err: unknown) => {
        if (live) setIndexError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [cfg]);

  const ready = index?.state === 'ready' ? index : null;
  const pageSet = useMemo(() => new Set(ready?.pages.map((p) => p.path) ?? []), [ready]);

  const open = useCallback(
    (path: string, hash = '') => {
      if (!ready) return;
      setShowing('page');
      setPage({ state: 'loading', path });
      try {
        sessionStorage.setItem(rememberKey(cfg.team), path);
      } catch {
        /* storage blocked: the wiki just opens on its front page next time */
      }
      getWikiPage(cfg, path)
        .then((p) => {
          // The daemon renders the page (ADR 754); an older one sends markdown only, shown as text.
          const html = p.html ?? `<pre class="lc-wiki__raw">${escapeText(p.markdown)}</pre>`;
          setPage((cur) =>
            cur.state === 'loading' && cur.path === path ? { state: 'ready', path, html, hash } : cur,
          );
        })
        .catch(() => setPage({ state: 'missing', path }));
    },
    [cfg, ready],
  );

  // Open on the page this viewer last read here, else the wiki's front page, else the contents.
  useEffect(() => {
    if (!ready || page.state !== 'idle') return;
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem(rememberKey(cfg.team));
    } catch {
      remembered = null;
    }
    const front =
      (remembered && pageSet.has(remembered) && remembered) ||
      ready.pages.find((p) => FRONT_PAGES.includes(p.path.toLowerCase()))?.path;
    if (front) open(front);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the index arrives
  }, [ready]);

  // A new page starts at its top, or at the heading its link named.
  useLayoutEffect(() => {
    const el = articleRef.current;
    if (!el || page.state !== 'ready') return;
    const target = page.hash ? el.querySelector(`#${CSS.escape(`wiki-${page.hash}`)}`) : null;
    if (target instanceof HTMLElement) target.scrollIntoView({ block: 'start' });
    else el.scrollTop = 0;
  }, [page]);

  const onArticleClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[data-wiki-page]');
    if (!(a instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const to = a.dataset['wikiPage'] ?? '';
    const hash = a.dataset['wikiHash'] ?? '';
    if (page.state === 'ready' && to === page.path) {
      const el = articleRef.current?.querySelector(`#${CSS.escape(`wiki-${hash}`)}`);
      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    open(to, hash);
  };

  const filtered = useMemo(() => {
    if (!ready) return [];
    const q = query.trim().toLowerCase();
    if (!q) return ready.pages;
    return ready.pages.filter(
      (p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [ready, query]);

  const web = ready ? repoWebBase(ready.repo) : null;
  const host = web ? { github: 'GitHub', gitlab: 'GitLab', codeberg: 'Codeberg' }[web.kind] : null;
  const current = page.state === 'idle' ? null : page.path;
  const currentEntry = ready?.pages.find((p) => p.path === current) ?? null;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop dismissal; Escape is the keyboard path (document listener above)
    <div
      ref={rootRef}
      className="lc-boardoverlay lc-wiki"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        className={`lc-boardoverlay__panel lc-wiki__panel is-showing-${showing}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Wiki — ${cfg.team}`}
        tabIndex={-1}
      >
        <header className="lc-wiki__band">
          <span className="lc-wiki__title">
            wiki <span className="lc-wiki__team">· {cfg.team}</span>
          </span>
          {ready && (
            <span className="lc-wiki__source">
              {ready.stale && <span className="lc-wiki__stale">couldn’t check for changes · </span>}
              read at <code>{ready.commit.slice(0, 7)}</code>
              {web && (
                <>
                  {' · '}
                  <a href={web.base} target="_blank" rel="noopener noreferrer">
                    {host} ↗
                  </a>
                </>
              )}
            </span>
          )}
          <button className="lc-wiki__close" onClick={close} aria-label="Close the wiki">
            ×
          </button>
        </header>

        {index === null && indexError === null && (
          <p className="lc-wiki__note" role="status">
            Taking the wiki off the shelf…
          </p>
        )}
        {indexError !== null && (
          <p className="lc-wiki__note" role="alert">
            The wiki couldn’t be read: {indexError}
          </p>
        )}
        {index?.state === 'unlinked' && (
          <div className="lc-wiki__empty">
            <h2>No wiki on this shelf yet</h2>
            <p>
              The wiki is the markdown your team already keeps in its repo — by default the{' '}
              <code>docs/wiki</code> folder. Link the repo once and this shelf reads it from the
              main branch from then on; there is nothing to copy or keep in step.
            </p>
            {isAdmin && onOpenSettings ? (
              <button type="button" className="lc-wiki__cta" onClick={onOpenSettings}>
                Link the repo in settings ›
              </button>
            ) : (
              <p className="lc-wiki__dim">A team admin links it in settings → team → wiki.</p>
            )}
          </div>
        )}
        {index?.state === 'failed' && (
          <div className="lc-wiki__empty">
            <h2>The wiki couldn’t be read</h2>
            <p>
              musterd tried <code>{index.repo}</code> and git said: <q>{index.detail}</q>
            </p>
            <p className="lc-wiki__dim">
              The repo has to be public for now. Check the address in settings → team → wiki.
            </p>
          </div>
        )}

        {ready && (
          <div className="lc-wiki__book">
            <nav className="lc-wiki__contents" aria-label="Pages">
              <label className="lc-wiki__find">
                <span className="lc-wiki__sr">Find a page</span>
                <input
                  type="search"
                  placeholder={`Find among ${ready.pages.length} pages`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {ready.pages.length === 0 ? (
                <p className="lc-wiki__dim">
                  <code>{ready.path || '/'}</code> has no markdown pages yet.
                </p>
              ) : (
                <ul className="lc-wiki__list">
                  {filtered.slice(0, LIST_CAP).map((p) => (
                    <PageRow key={p.path} p={p} on={p.path === current} onOpen={open} />
                  ))}
                  {filtered.length > LIST_CAP && (
                    <li className="lc-wiki__dim lc-wiki__more">
                      {filtered.length - LIST_CAP} more — type to narrow
                    </li>
                  )}
                  {filtered.length === 0 && <li className="lc-wiki__dim">No page matches.</li>}
                </ul>
              )}
              {ready.truncated && (
                <p className="lc-wiki__dim">The folder holds more pages than the shelf lists.</p>
              )}
            </nav>
            <div className="lc-wiki__spine" aria-hidden="true" />
            <article
              ref={articleRef}
              className="lc-wiki__page"
              aria-live="polite"
              aria-busy={page.state === 'loading'}
            >
              <button
                type="button"
                className="lc-wiki__back"
                onClick={() => setShowing('contents')}
              >
                ‹ contents
              </button>
              {page.state === 'idle' && (
                <div className="lc-wiki__intro">
                  <h2>{cfg.team}’s wiki</h2>
                  <p>
                    {ready.pages.length} pages, read from <code>{ready.path || '/'}</code> on{' '}
                    <code>{ready.branch}</code>. Pick one from the contents.
                  </p>
                </div>
              )}
              {page.state === 'loading' && <p className="lc-wiki__dim">Opening…</p>}
              {page.state === 'missing' && (
                <p className="lc-wiki__dim">That page isn’t on the shelf any more.</p>
              )}
              {page.state === 'ready' && (
                // The HTML is the daemon's renderWikiPage (ADR 754): raw HTML escaped, links vetted.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegated clicks on the page's own <a> elements, which are keyboard-reachable
                <div
                  className="lc-wiki__prose"
                  onClick={onArticleClick}
                  dangerouslySetInnerHTML={{ __html: page.html }}
                />
              )}
              {page.state === 'ready' && currentEntry && web && (
                <p className="lc-wiki__foot">
                  <a
                    href={`${web.base}/${web.kind === 'github' ? 'edit' : web.kind === 'gitlab' ? '-/edit' : '_edit'}/${ready.branch}/${[ready.path, currentEntry.path].filter(Boolean).join('/')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Edit this page on {host} ↗
                  </a>
                </p>
              )}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

function PageRow({
  p,
  on,
  onOpen,
}: {
  p: WikiPageEntry;
  on: boolean;
  onOpen: (path: string) => void;
}) {
  const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : null;
  return (
    <li>
      <button
        type="button"
        className={`lc-wiki__row${on ? ' is-on' : ''}`}
        aria-current={on ? 'page' : undefined}
        onClick={() => onOpen(p.path)}
      >
        <span className="lc-wiki__rowtitle">{p.title}</span>
        {dir && <span className="lc-wiki__rowdir">{dir}</span>}
      </button>
    </li>
  );
}
