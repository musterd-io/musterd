import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import {
  capEntries,
  clockPhrase,
  evidenceUrl,
  experimentsCount,
  firstSentence,
  SPARK_H,
  SPARK_W,
  formatValue,
  STRIP_DAYS,
  stripDays,
  type ExperimentEntry,
  type ReadStatus,
} from './experimentReads';

/** The chart is drawn in its own chunk (lane 01M5GE8AX4): /live's first paint carries the list, and
 *  the sparklines (their geometry, gradients and dots) arrive a moment after (ADR 183: lazy-loading is
 *  what moves the initial budget). */
const ExperimentSpark = lazy(() => import('./ExperimentSpark'));

/** While the chart's chunk loads: the same box, already saying the number, so nothing shifts. */
const OPEN_KEY = 'musterd.live.experiments.open';
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeOpen(v: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* private window: the fold simply isn't remembered */
  }
}

function SparkPending({ entry }: { entry: ExperimentEntry }) {
  const last = entry.samples[entry.samples.length - 1]!;
  return (
    <span className={`lc-xp__spark${entry.status === 'read' ? ' is-read' : ''}`} title={entry.metric!.name}>
      <span style={{ display: 'block', width: SPARK_W, height: SPARK_H }} aria-hidden="true" />
      <span className="lc-xp__spark-latest">{formatValue(last.value, entry.metric!.unit)}</span>
    </span>
  );
}

/** An owner's avatar: the roster's colour for them and their initial. Null for a seat not on it. */
export type AvatarOf = (
  seat: string,
) => { background: string; color?: string; initial: string } | null;

/**
 * The Experiments section at the foot of the team column (ADR 644, spec
 * 2026-10-17-experiments-panel-design.md): every dated read beside the team, so an overdue one is
 * seen by the room and the stream. `still` is the stream's: no links, no toggle, no hover, and
 * nothing at all when there is nothing to read — dead air says nothing.
 *
 * Each read is a leaf torn off a desk calendar and tacked up, the same paper and tack as the read
 * tags on the office corkboard, so the room and the column read as one wall. Above them, a
 * fortnight strip shows the reads coming toward today (nick, 2026-10-17: the first cut, plain rows,
 * "look extremely bare").
 */
export function Experiments({
  entries,
  now,
  avatarOf,
  still = false,
  stale = false,
}: {
  /** Uncapped, in group order (`experimentEntries`). */
  entries: readonly ExperimentEntry[];
  now: number;
  avatarOf?: AvatarOf;
  still?: boolean;
  /** The board refetch is failing: dim the marks, never the words. */
  stale?: boolean;
}) {
  const [all, setAll] = useState(false);
  // /live only: fold the list under its head, leaving the fortnight strip as the summary. Remembered.
  const [open, setOpen] = useState(readOpen);
  const toggleOpen = () =>
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });
  // The read under the pointer, on the strip or in the list: both light up together.
  const [hot, setHot] = useState<string | null>(null);
  // Rows whose note is open (the §6 disclosure, /live only) — by lane id, so a board refetch keeps it.
  const [openNotes, setOpenNotes] = useState<ReadonlySet<string>>(new Set());
  const toggleNote = (id: string) =>
    setOpenNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const changed = useStatusChanges(entries);
  const tick = useMinuteTick(now);
  if (still && entries.length === 0) return null;
  const capped = capEntries(entries, still);
  const shown = all && !still ? entries : capped;
  const more = entries.length - capped.length;
  const hover = still ? () => undefined : setHot;
  return (
    <section className={`lc-xp${stale ? ' is-stale' : ''}`} aria-label="Experiments">
      <header className="lc-xp__head">
        {still || entries.length === 0 ? (
          <span className="lc-team__title">Experiments</span>
        ) : (
          <button
            type="button"
            className="lc-xp__fold"
            aria-expanded={open}
            onClick={toggleOpen}
            title={open ? 'Fold the list' : 'Show the list'}
          >
            <span className="lc-team__title">Experiments</span>
            <i className="lc-xp__chev" aria-hidden="true" />
          </button>
        )}
        {entries.length > 0 && <span className="lc-team__count">{experimentsCount(entries)}</span>}
      </header>
      {entries.length === 0 ? (
        <p className="lc-xp__empty">No dated reads. Open a lane with --reads-on to add one.</p>
      ) : (
        <>
          <Fortnight entries={entries} now={now} hot={hot} onHot={hover} />
          {(open || still) && (
          <ul className="lc-xp__rows">
            {shown.map((e, i) => (
              <li
                key={`${e.id}:${e.status}`}
                className={`lc-xp__row lc-xp__row--${e.status}${changed.has(e.id) ? ' is-changed' : ''}${hot === e.id ? ' is-hot' : ''}`}
                style={{ '--i': i } as CSSProperties}
                onMouseEnter={() => hover(e.id)}
                onMouseLeave={() => hover(null)}
              >
                {still ? (
                  <div className="lc-xp__hit">
                    <ExperimentRow entry={e} now={tick} avatarOf={avatarOf} still noteOpen={false} />
                  </div>
                ) : (
                  <a
                    className="lc-xp__hit"
                    href={`/board?lane=${encodeURIComponent(e.id)}`}
                    aria-label={e.label}
                    onFocus={() => hover(e.id)}
                    onBlur={() => hover(null)}
                  >
                    <ExperimentRow
                      entry={e}
                      now={tick}
                      avatarOf={avatarOf}
                      noteOpen={openNotes.has(e.id)}
                      onToggleNote={() => toggleNote(e.id)}
                      whyOpen={openNotes.has(`why:${e.id}`)}
                      onToggleWhy={() => toggleNote(`why:${e.id}`)}
                    />
                  </a>
                )}
              </li>
            ))}
          </ul>
          )}
        </>
      )}
      {more > 0 &&
        (open || still) &&
        (still ? (
          <p className="lc-xp__more">+{more} more on the board</p>
        ) : (
          <button type="button" className="lc-xp__toggle" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${entries.length}`}
          </button>
        ))}
    </section>
  );
}

function ExperimentRow({
  entry,
  now,
  avatarOf,
  still = false,
  noteOpen,
  onToggleNote,
  whyOpen = false,
  onToggleWhy,
}: {
  entry: ExperimentEntry;
  /** The minute tick: the row's clock counts toward (or from) the read day against it. */
  now: number;
  avatarOf?: AvatarOf | undefined;
  still?: boolean;
  /** The note disclosure (§6): open shows the whole note; closed shows its first sentence. */
  noteOpen: boolean;
  onToggleNote?: (() => void) | undefined;
  /** The explainer (question, what is measured, goal, decision day), /live only. */
  whyOpen?: boolean;
  onToggleWhy?: (() => void) | undefined;
}) {
  const av = entry.owner ? avatarOf?.(entry.owner) : null;
  const link = still ? null : evidenceUrl(entry.evidence);
  return (
    <>
      <Flask entry={entry} />
      <span className="lc-xp__body">
        <span className="lc-xp__titlerow">
          <span className="lc-xp__title" title={!still && entry.short !== entry.title ? entry.title : undefined}>
            {entry.short}
          </span>
          {!still && onToggleWhy && (entry.about || entry.metric) && (
            <button
              type="button"
              className="lc-xp__why-btn"
              aria-expanded={whyOpen}
              aria-label="What is this experiment?"
              title="What is this experiment?"
              onClick={(ev) => {
                // The row is a link to the board; the explainer opens in place instead.
                ev.preventDefault();
                ev.stopPropagation();
                onToggleWhy();
              }}
            >
              <i aria-hidden="true" />
            </button>
          )}
        </span>
        <span className="lc-xp__meta">
          {av && (
            <span className="lc-xp__avatar" style={{ background: av.background, ...(av.color ? { color: av.color } : {}) }} aria-hidden="true">
              {av.initial}
            </span>
          )}
          {entry.owner && <span className="lc-xp__owner">{entry.owner}</span>}
          {entry.status !== 'read' && <span className="lc-xp__date">{entry.readsLabel}</span>}
          <span className="lc-xp__status lc-xp__clock">{clockPhrase(entry, now)}</span>
        </span>
        {entry.goal && entry.metric && (
          <span
            className="lc-xp__goal"
            title={`${entry.metric.name}: aiming ${entry.metric.direction === 'down' ? 'under' : 'over'} ${formatValue(entry.metric.target, entry.metric.unit)}`}
          >
            goal {entry.goal}
          </span>
        )}
        {whyOpen && !still && (
          <span className="lc-xp__why">
            {entry.about && <span className="lc-xp__why-q">{entry.about}</span>}
            {entry.metric && (
              <span className="lc-xp__why-row">
                <b>Measures</b> {entry.metric.name}
              </span>
            )}
            {entry.goal && entry.metric && (
              <span className="lc-xp__why-row">
                <b>Goal</b> {entry.goal} ({entry.metric.direction === 'down' ? 'lower' : 'higher'} is better)
              </span>
            )}
            <span className="lc-xp__why-row">
              <b>Decided</b> {entry.readsLabel}
            </span>
          </span>
        )}
        {entry.note && (
          <span className={`lc-xp__note${noteOpen ? ' is-open' : ''}`}>
            {still || !onToggleNote ? (
              <span className="lc-xp__note-text">“{firstSentence(entry.note)}”</span>
            ) : (
              <button
                type="button"
                className="lc-xp__note-text lc-xp__note-toggle"
                aria-expanded={noteOpen}
                onClick={(ev) => {
                  // The row is a link to the board; the note opens in place instead of following it.
                  ev.preventDefault();
                  ev.stopPropagation();
                  onToggleNote();
                }}
              >
                “{noteOpen ? entry.note : firstSentence(entry.note)}”
              </button>
            )}
            {link && (
              <a
                className="lc-xp__evidence"
                href={link}
                target="_blank"
                rel="noopener"
                aria-label="Evidence"
                title={entry.evidence ?? undefined}
                onClick={(ev) => ev.stopPropagation()}
              >
                ↗
              </a>
            )}
          </span>
        )}
      </span>
      {entry.metric && entry.samples.length > 0 && (
        <Suspense fallback={<SparkPending entry={entry} />}>
          <ExperimentSpark
            metric={entry.metric}
            samples={entry.samples}
            read={entry.status === 'read'}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * The data so far (§6): the series as one line, the baseline as a faint rule, the target as a dashed
 * rule, the latest value as the only number. Ink only until the read is in — a chart must not say
 * `met` before the rule does. Inline SVG, never a font glyph (the capturer has no emoji font).
 */

/** The experiment's mark: a flask, two-tone like the role glyphs — an outline and a liquid whose tint
 *  is the read's status (CSS `--band`) — and, once a read is in, its verdict stamped on the corner.
 *  Decoration over words the row already says; the date is printed beside the clock. */
function Flask({ entry }: { entry: ExperimentEntry }) {
  return (
    <span className="lc-xp__flask" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="18" height="18">
        <path className="lc-xp__flask-liquid" d="M4.2 10.4h7.6l1.5 2.4a.9.9 0 0 1-.8 1.4H3.5a.9.9 0 0 1-.8-1.4z" />
        <path
          className="lc-xp__flask-glass"
          d="M6.2 1.8h3.6M6.7 1.8v4L2.8 12.5a1.5 1.5 0 0 0 1.3 2.2h7.8a1.5 1.5 0 0 0 1.3-2.2L9.3 5.8v-4"
        />
      </svg>
      {entry.status === 'read' && (
        <span className={`lc-xp__stamp lc-xp__stamp--${entry.phrase}`}>{entry.phrase}</span>
      )}
    </span>
  );
}

/**
 * The next two weeks as a strip, today at the left edge and overdue reads in the gutter before it:
 * each read a mark at its day, so the eye sees them coming. Decorative — every fact on it is in the
 * rows below — but on /live a mark under the pointer lights its row, and the row lights its mark.
 */
function Fortnight({
  entries,
  now,
  hot,
  onHot,
}: {
  entries: readonly ExperimentEntry[];
  now: number;
  hot: string | null;
  onHot: (id: string | null) => void;
}) {
  // Overdue reads share the gutter, a verdict lies where it was read; same-day marks stack upward.
  const stacked = new Map<number, number>();
  const at = (offset: number) => Math.max(-1, Math.min(offset, STRIP_DAYS + 1));
  return (
    <div className="lc-xp__strip" aria-hidden="true">
      <div className="lc-xp__track">
        {stripDays(now).map((d) => (
          <span
            key={d.offset}
            className={`lc-xp__day${d.weekend ? ' is-weekend' : ''}${d.offset === 0 ? ' is-today' : ''}`}
            style={{ '--d': d.offset } as CSSProperties}
          />
        ))}
        {entries.map((e, i) => {
          const slot = at(e.offset);
          const n = stacked.get(slot) ?? 0;
          stacked.set(slot, n + 1);
          return (
            <span
              key={e.id}
              className={`lc-xp__pin lc-xp__pin--${e.status}${hot === e.id ? ' is-hot' : ''}`}
              style={{ '--d': slot, '--n': n, '--i': i } as CSSProperties}
              onMouseEnter={() => onHot(e.id)}
              onMouseLeave={() => onHot(null)}
            >
              <ReadMark status={e.status} />
            </span>
          );
        })}
      </div>
      <div className="lc-xp__scale">
        <span>today</span>
        <span>1 wk</span>
        <span>2 wks</span>
      </div>
    </div>
  );
}

/** Shape first, colour second (WCAG 1.4.1): inline SVG, never a font glyph — the broadcast
 *  capturer has no emoji font and glyph fallback varies by machine. */
export function ReadMark({ status }: { status: ReadStatus }) {
  return (
    <svg className="lc-xp__mark" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {status === 'overdue' && <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" fill="currentColor" />}
      {status === 'due' && <circle cx="5" cy="5" r="4" fill="currentColor" />}
      {status === 'waiting' && (
        <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
      {status === 'read' && (
        <path
          d="M1.5 5.25 4 7.75 8.75 2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/**
 * The rows whose status has moved while this section was up (a verdict landed, or midnight moved a
 * read to due). A row is keyed on its status, so a move remounts it and its leaf turns over once; the
 * mark stays set, so the column's frequent re-renders never cut the turn short or replay it.
 * Nothing turns on the first render, or when "Show all" mounts rows: arriving is not a change.
 */
function useStatusChanges(entries: readonly ExperimentEntry[]): ReadonlySet<string> {
  // Lane ids are ULIDs and statuses are words, so a space-joined `id=status` list is a safe key.
  const key = entries.map((e) => `${e.id}=${e.status}`).join(' ');
  const [seen, setSeen] = useState(key);
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  if (key !== seen) {
    const was = new Map(seen.split(' ').map((p) => p.split('=') as [string, string]));
    const next = new Set(moved);
    for (const e of entries) {
      const w = was.get(e.id);
      if (w && w !== e.status) next.add(e.id);
    }
    setSeen(key);
    setMoved(next);
  }
  return moved;
}


/**
 * A `now` that moves once a minute, on the wall minute (lane 01M5AXHFZT) — the countdowns' clock.
 * One timeout re-armed to the next :00, never setInterval (it drifts off the minute and the column
 * of clocks stutters); paused while the tab is hidden and re-aligned on return, because an interval
 * nobody sees is cost every viewer pays forever (packages/web/AGENTS.md). Under reduced motion it
 * still ticks: a clock is information, not motion. Sixty times gentler than the second clock the
 * header deliberately does NOT run on the stream (`Clock.tsx`), so the stream ticks too.
 */
function useMinuteTick(initial: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    let timer: number | undefined;
    const arm = () => {
      const t = Date.now();
      timer = window.setTimeout(() => {
        setNow(Date.now());
        arm();
      }, 60_000 - (t % 60_000) + 50);
    };
    const onVisible = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      } else {
        setNow(Date.now());
        if (timer === undefined) arm();
      }
    };
    if (!document.hidden) arm();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  // A fresh board render (a lane act) carries a newer `now`; never let the clock run backwards.
  return Math.max(now, initial);
}
