import { useState, type CSSProperties } from 'react';
import {
  capEntries,
  experimentsCount,
  STRIP_DAYS,
  stripDays,
  type ExperimentEntry,
  type ReadStatus,
} from './experimentReads';

/** An owner's avatar: the roster's colour for them and their initial. Null for a seat not on it. */
export type AvatarOf = (seat: string) => { background: string; initial: string } | null;

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
  // The read under the pointer, on the strip or in the list: both light up together.
  const [hot, setHot] = useState<string | null>(null);
  const changed = useStatusChanges(entries);
  if (still && entries.length === 0) return null;
  const capped = capEntries(entries);
  const shown = all && !still ? entries : capped;
  const more = entries.length - capped.length;
  const hover = still ? () => undefined : setHot;
  return (
    <section className={`lc-xp${stale ? ' is-stale' : ''}`} aria-label="Experiments">
      <header className="lc-xp__head">
        <span className="lc-team__title">Experiments</span>
        {entries.length > 0 && <span className="lc-team__count">{experimentsCount(entries)}</span>}
      </header>
      {entries.length === 0 ? (
        <p className="lc-xp__empty">No dated reads. Open a lane with --reads-on to add one.</p>
      ) : (
        <>
          <Fortnight entries={entries} now={now} hot={hot} onHot={hover} />
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
                    <ExperimentRow entry={e} avatarOf={avatarOf} still />
                  </div>
                ) : (
                  <a
                    className="lc-xp__hit"
                    href={`/board?lane=${encodeURIComponent(e.id)}`}
                    aria-label={e.label}
                    onFocus={() => hover(e.id)}
                    onBlur={() => hover(null)}
                  >
                    <ExperimentRow entry={e} avatarOf={avatarOf} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {more > 0 &&
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
  avatarOf,
  still = false,
}: {
  entry: ExperimentEntry;
  avatarOf?: AvatarOf | undefined;
  still?: boolean;
}) {
  const av = entry.owner ? avatarOf?.(entry.owner) : null;
  return (
    <>
      <Leaf entry={entry} />
      <span className="lc-xp__body">
        <span className="lc-xp__title" title={!still && entry.short !== entry.title ? entry.title : undefined}>
          {entry.short}
        </span>
        <span className="lc-xp__meta">
          {av && (
            <span className="lc-xp__avatar" style={{ background: av.background }} aria-hidden="true">
              {av.initial}
            </span>
          )}
          {entry.owner && <span className="lc-xp__owner">{entry.owner}</span>}
          <span className="lc-xp__status">{entry.phrase}</span>
        </span>
        {entry.note && (
          <span className="lc-xp__note" title={!still ? entry.note : undefined}>
            “{entry.note}”
          </span>
        )}
      </span>
    </>
  );
}

/** The tear-off leaf: weekday band, the day in the casual cut, the month, a tack at the top — and,
 *  once a read is in, its verdict stamped across it. Decoration over words the row already says. */
function Leaf({ entry }: { entry: ExperimentEntry }) {
  return (
    <span className="lc-xp__leaf" aria-hidden="true">
      <span className="lc-xp__tack" />
      <span className="lc-xp__leaf-wd">{entry.leaf.weekday}</span>
      <span className="lc-xp__leaf-day">{entry.leaf.day}</span>
      <span className="lc-xp__leaf-mo">{entry.leaf.month}</span>
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
