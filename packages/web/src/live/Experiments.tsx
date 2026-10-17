import { useState } from 'react';
import {
  capEntries,
  experimentsCount,
  type ExperimentEntry,
  type ReadStatus,
} from './experimentReads';

/**
 * The Experiments section at the foot of the team column (ADR 644, spec
 * 2026-10-17-experiments-panel-design.md): every dated read beside the team, so an overdue one is
 * seen by the room and the stream. Rows, not cards. `still` is the stream's: no links, no toggle,
 * and nothing at all when there is nothing to read — dead air says nothing.
 */
export function Experiments({
  entries,
  still = false,
  stale = false,
}: {
  /** Uncapped, in group order (`experimentEntries`). */
  entries: readonly ExperimentEntry[];
  still?: boolean;
  /** The board refetch is failing: dim the marks, never the words. */
  stale?: boolean;
}) {
  const [all, setAll] = useState(false);
  const changed = useStatusChanges(entries);
  if (still && entries.length === 0) return null;
  const capped = capEntries(entries);
  const shown = all && !still ? entries : capped;
  const more = entries.length - capped.length;
  return (
    <section className={`lc-xp${stale ? ' is-stale' : ''}`} aria-label="Experiments">
      <header className="lc-xp__head">
        <span className="lc-team__title">Experiments</span>
        {entries.length > 0 && <span className="lc-team__count">{experimentsCount(entries)}</span>}
      </header>
      {entries.length === 0 ? (
        <p className="lc-xp__empty">No dated reads. Open a lane with --reads-on to add one.</p>
      ) : (
        <ul className="lc-xp__rows">
          {shown.map((e) => (
            <li
              key={`${e.id}:${e.status}`}
              className={`lc-xp__row lc-xp__row--${e.status}${changed.has(e.id) ? ' is-changed' : ''}`}
            >
              {still ? (
                <div className="lc-xp__hit">
                  <ExperimentRow entry={e} still />
                </div>
              ) : (
                <a
                  className="lc-xp__hit"
                  href={`/board?lane=${encodeURIComponent(e.id)}`}
                  aria-label={e.label}
                >
                  <ExperimentRow entry={e} />
                </a>
              )}
            </li>
          ))}
        </ul>
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

function ExperimentRow({ entry, still = false }: { entry: ExperimentEntry; still?: boolean }) {
  return (
    <>
      <span className="lc-xp__line1">
        <ReadMark status={entry.status} />
        <span className="lc-xp__status">{entry.phrase}</span>
        <span className="lc-xp__date">{entry.date}</span>
      </span>
      <span className="lc-xp__title">{entry.title}</span>
      {(entry.owner || entry.note) && (
        <span className="lc-xp__meta" title={!still && entry.note ? entry.note : undefined}>
          {entry.owner}
          {entry.owner && entry.note && ' · '}
          {entry.note && `"${entry.note}"`}
        </span>
      )}
    </>
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
 * read to due). A row is keyed on its status, so a move remounts it and its flash plays once; the
 * mark stays set, so the column's frequent re-renders never cut the flash short or replay it.
 * Nothing flashes on the first render, or when "Show all" mounts rows: arriving is not a change.
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
