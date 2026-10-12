import type { TicketStage, TimelineEntry, TourOutcome } from './tourMachine';
import { timeOfDay } from './tourMachine';

/**
 * The tour lane as a ticket (lane 01M4PSEV08): its id and title, a four-stop track that lights as
 * the real acts arrive, and the story so far underneath. The tour talks about a lane the viewer
 * cannot otherwise see on /live; this is that lane, moving. On `record` the same ticket is the
 * receipt, and an accept stamps it.
 */
const STOPS = ['Opened', 'Claimed', 'Submitted', 'Closed'] as const;
/** The newest few lines; the whole story is on the lane itself. */
const SHOWN = 4;

export function LaneTicket({
  laneId,
  title,
  agent,
  stage,
  declined,
  outcome,
  you,
  entries,
}: {
  laneId: string;
  title: string;
  agent: string;
  stage: TicketStage;
  declined: boolean;
  outcome: TourOutcome | undefined;
  you: string;
  entries: readonly TimelineEntry[];
}) {
  const last = outcome === 'accepted' ? 'Accepted' : STOPS[3];
  return (
    <section className={`tour-ticket${stage === 4 ? ' is-closed' : ''}`} aria-label="Your tour lane">
      <header className="tour-ticket__head">
        <span className="tour-ticket__id">{laneId.slice(0, 10)}</span>
        <span>{stage >= 2 ? `owner ${agent}` : 'unowned'}</span>
      </header>
      <p className="tour-ticket__title">{title}</p>
      <ol className="tour-track">
        {STOPS.map((label, i) => {
          const n = i + 1;
          const failed = declined && n === 2;
          const state = failed ? 'is-failed' : n <= stage ? 'is-done' : n === stage + 1 ? 'is-next' : '';
          return (
            <li key={label} className={`tour-track__stop ${state}`}>
              <span className="tour-track__mark" aria-hidden="true">
                {failed ? '×' : n <= stage ? '✓' : ''}
              </span>
              <span className="tour-track__label">
                {failed ? 'Declined' : n === 4 ? last : label}
              </span>
            </li>
          );
        })}
      </ol>
      {entries.length > 0 && (
        <ol className="tour-story" aria-label="What has happened">
          {entries.slice(-SHOWN).map((e) => (
            <li key={e.id} className="tour-story__line">
              <time className="tour-story__time" dateTime={new Date(e.ts).toISOString()}>
                {timeOfDay(e.ts)}
              </time>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
      {outcome === 'accepted' && (
        <p className="tour-ticket__stamp" role="status">
          Accepted · {you}
        </p>
      )}
    </section>
  );
}

/** A one-second burst on the accept. Sixteen spans, CSS only; reduced motion hides it. */
export function Confetti() {
  return (
    <span className="tour-confetti" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <i key={i} style={{ ['--i' as string]: i }} />
      ))}
    </span>
  );
}
