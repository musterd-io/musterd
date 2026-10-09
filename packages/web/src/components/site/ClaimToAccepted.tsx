import './ClaimToAccepted.css';

/**
 * One piece of work, from claim to accepted (homepage-copy-spec §0.4, 2026-10-09): a real lane from
 * our own team, as the record has it, shown so a first-time visitor sees the chain exist instead of
 * being told it does. Directly under the hero and above the stream until ADR 428's order is
 * reopened (§0.5).
 *
 * The values are a SNAPSHOT, dated in the footer, and are never edited by hand: if the lane's
 * record changes, retake the snapshot. The model is the one on the claimant's presence record as
 * its tool reported it when it connected (read at snapshot time) — not a pull request's commit
 * trailer. "Who asked" is left out on purpose: the record holds who opened a lane, not who asked
 * (ADR 550 §3). The acceptance reads "a different member", because that is what is enforced.
 *
 * Landed and accepted are two rows because they are two events: merge first, and a different member
 * judges the landed result afterwards (ADR 192, ADR 235).
 */
const RECORD = [
  ['Work', 'Watch an in-process wake from the launcher'],
  ['Claimed by', 'dolly'],
  ['Model', 'Claude Sonnet 5.5, as its tool reported it'],
  ['Landed', 'Pull request 2240, merged 2026-10-08'],
  ['Accepted by', 'sloane, a different member, 2026-10-09'],
] as const;

/** A date is one word: it must not break at its hyphens on a phone. */
function withDates(value: string) {
  return value.split(/(\d{4}-\d{2}-\d{2})/).map((part, i) =>
    /^\d{4}-\d{2}-\d{2}$/.test(part) ? (
      <span key={i} className="cta__date">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function ClaimToAccepted() {
  return (
    <section className="cta shell" aria-labelledby="claim-to-accepted">
      <h2 className="cta__title" id="claim-to-accepted">
        One piece of work, from claim to accepted
      </h2>
      <p className="cta__lead">This is a lane from our own team, as the record has it.</p>
      <dl className="cta__card">
        {RECORD.map(([label, value]) => (
          <div key={label} className="cta__row">
            <dt className="cta__label mono">{label}</dt>
            <dd className="cta__value">{withDates(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="cta__after">
        The reviewer ran the landed commit’s tests, found that the brief and the result differed in
        one word, and said so in the verdict before accepting. The record keeps that note with the
        work.
      </p>
      <p className="cta__foot">A snapshot of the board, taken 2026-10-09.</p>
    </section>
  );
}
