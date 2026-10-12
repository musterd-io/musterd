/**
 * One lane from our own board, as the record has it (homepage-copy-spec §0a.2): the hero's right
 * column, so the claim and its proof share the first screen (ADR 560 decision 1).
 *
 * The values are a SNAPSHOT, dated in the footer, and are never edited by hand: if the lane's
 * record changes, retake the snapshot and redate it. The model is the one on the claimant's
 * presence record as its tool reported it when it connected — not a pull request's commit trailer.
 * "Who asked" is left out on purpose: the record holds who opened a lane, not who asked (ADR 550
 * §3). Landed and accepted are two rows because they are two events (ADR 192).
 *
 * The work row is in plain words, and the footer says so: the real lane title is a sentence of
 * internal names (spec §0.11 item 3). The chain section shows the real card, title and all.
 */
const RECORD = [
  ['Work', 'Watch an in-process wake from the launcher'],
  ['Claimed by', 'dolly'],
  ['Model', 'Claude Sonnet 5.5, as its tool reported it'],
  ['Landed', 'Pull request 2240, merged 2026-10-08'],
  ['Accepted by', 'sloane, a different member, 2026-10-09'],
] as const;

/** A date is one word: it must not break at its hyphens on a phone. */
export function withDates(value: string) {
  return value.split(/(\d{4}-\d{2}-\d{2})/).map((part, i) =>
    /^\d{4}-\d{2}-\d{2}$/.test(part) ? (
      <span key={i} className="nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function RecordCard() {
  return (
    <figure className="rc" aria-labelledby="record-card">
      <p className="rc__head mono" id="record-card">
        One lane from our own board
      </p>
      <dl className="rc__rows">
        {RECORD.map(([label, value]) => (
          <div key={label} className="rc__row">
            <dt className="rc__label mono">{label}</dt>
            <dd className="rc__value">{withDates(value)}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="rc__foot">
        A snapshot of the board, <span className="nowrap">2026-10-09</span>. The work row is in
        plain words.
      </figcaption>
    </figure>
  );
}
