import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { useMemo } from 'react';
import { kindOf, memberColor, hueOf, rosterIndex } from './format';
import { collapseHeadlines, headline, headlineText, type Headline } from './headline';

/** How far back the band looks. The buffer is capped at 1,000; three headlines never need it all. */
const SCAN = 200;
const SHOW = 3;

/**
 * The headline ticker (ADR 464, spec §5): the last few notable moments in one line under the room,
 * newest on the left, each chip in its actor's own hue — the same colour their body, plate and card
 * carry. Nothing here is the act body; every line comes from `headline()`.
 */
export function Ticker({
  envelopes,
  roster,
  board,
  hide,
}: {
  envelopes: readonly Envelope[];
  roster: readonly MemberSummary[];
  board: LaneBoard | null;
  /** Act ids the asks strip is already showing. Their moments are dropped here: the same ask in the
   *  strip and again as a chip was the page saying one thing twice (live-briefing spec, increment 4). */
  hide?: ReadonlySet<string>;
}) {
  const idx = rosterIndex(roster as MemberSummary[]);
  const items = useMemo(() => {
    const titles = new Map((board?.lanes ?? []).map((l) => [l.id, l.title] as const));
    const ctx = { laneTitle: (id: string) => titles.get(id) ?? null };
    const tail = envelopes.slice(-SCAN);
    const lines: Headline[] = [];
    for (const e of tail) {
      if (hide?.has(e.id)) continue;
      const h = headline(e, ctx);
      if (h) lines.push(h);
    }
    return collapseHeadlines(lines).slice(-SHOW).reverse();
  }, [envelopes, board, hide]);

  return (
    <div className="lc-ticker" aria-label="Latest moments">
      <ul className="lc-ticker__list">
        {items.length === 0 && (
          <li className="lc-ticker__empty">Nothing notable yet — the room is settling in.</li>
        )}
        {items.map((h) => {
          const kind = kindOf(h.who, idx);
          const color = memberColor(h.who, kind, hueOf(h.who, idx));
          return (
            <li
              key={h.id}
              className={`lc-ticker__item is-${h.tone}`}
              style={{ ['--member' as string]: color }}
            >
              <i className="lc-ticker__dot" aria-hidden="true" />
              <span className="lc-ticker__text">{headlineText(h)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
