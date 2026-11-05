import type { CSSProperties } from 'react';
import { pollSummary, type PollView } from './poll';
import './PollCard.css';

/**
 * The Twitch poll on the stream (ADR 807, lane 01M6ME5BFQ): the question, one bar per option with
 * the number a viewer types, the share, the time left and the vote count — then, for 15 s after
 * it closes, the result. Display only: nothing on it is clickable, and it never names a voter.
 *
 * Lazy-loaded by the /broadcast route, mounted only while there is a poll to show.
 */
export function PollCard({ view, scale = 1 }: { view: PollView; scale?: number }) {
  const closed = view.kind === 'result';
  return (
    <aside
      className={`bc-poll${closed ? ' is-closed' : ''}`}
      aria-label="Twitch poll"
      // Laid out for the 1080 stage; the 720 rung shrinks the card whole (PollCard.css).
      style={scale === 1 ? undefined : ({ '--bc-poll-zoom': scale } as CSSProperties)}
    >
      <header className="bc-poll__head" aria-hidden="true">
        <span className="bc-poll__eyebrow">
          <span className="bc-poll__dot" />
          {closed ? 'Poll closed' : 'Twitch poll'}
        </span>
        <span className="bc-poll__left">{view.kind === 'open' ? view.left : view.votes}</span>
      </header>
      <p className={`bc-poll__q${view.question.length > 90 ? ' is-long' : ''}`} aria-hidden="true">
        {view.question}
      </p>
      <ol className="bc-poll__rows" aria-hidden="true">
        {view.rows.map((r) => (
          <li
            key={r.n}
            className={`bc-poll__row${r.lead ? ' is-lead' : ''}`}
            style={{ '--bc-poll-pct': `${r.pct}%` } as CSSProperties}
          >
            {/* Once voting has closed the command is no use; the number stays, as the winner names it. */}
            <span className="bc-poll__cmd">{closed ? r.n : `!vote ${r.n}`}</span>
            <span className="bc-poll__label">{r.label}</span>
            <span className="bc-poll__pct">{r.pct}%</span>
            <span className="bc-poll__bar" />
          </li>
        ))}
      </ol>
      <p className="bc-poll__foot" aria-hidden="true">
        {view.kind === 'open' ? view.votes : view.headline}
      </p>
      <p className="lc-sr" aria-live="polite">
        {pollSummary(view)}
      </p>
    </aside>
  );
}

export default PollCard;
