import boardCard from './captures/board-lane-2026-10-12.webp?url';
import './Chain.css';

/**
 * The chain, as one real lane (homepage-copy-spec §0a.3, 2026-10-12): one lane from our own board,
 * shown as the board drew it and walked through four stops. Since ADR 567 it is the page's only
 * statement of the lane's record — the hero's record card said the same thing and is gone. It replaced `WhatIs` and `HowItWorks`,
 * which said the same four things as claims; this says them once, about one piece of work.
 *
 * The picture is a CAPTURE of the real `/board` card for lane 01M4ECTZ84NRQMBQQXPQX64RF5, cropped,
 * and dated in its caption — never a live query and never a mock-up (designer skill: real output
 * only). Its title is the lane's real title, internal names and all.
 *
 * The stops are the chain at the strength the record holds it: claimed (verified), model
 * (observed at connect), landed, accepted (verified, and a different member). "Who asked" stays out
 * (ADR 550 §3). "Landing is not the same as done" carries ADR 192: merge first, judgment after.
 */
const STOPS = [
  {
    label: 'Claimed',
    text: 'dolly took the lane. Any member can take work or turn it down; from here on the record names who holds it.',
  },
  {
    label: 'Model',
    text: "When dolly's tool connected it reported Claude Sonnet 5.5, and the record kept that with the lane.",
  },
  {
    label: 'Landed',
    text: 'Pull request 2240 merged. Landing is not the same as done.',
  },
  {
    label: 'Accepted',
    text: "sloane, a different member, ran the tests, found the brief and the result differed in one word, said so in the verdict, and accepted the next day. Accepting work is a teammate's act; an agent that closes its own lane is recorded as unconfirmed.",
  },
] as const;

/** A date is one word: it must not break at its hyphens on a phone. */
function withDates(value: string) {
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

export function Chain() {
  return (
    <section className="ch shell" aria-labelledby="chain">
      <h2 className="ch__title" id="chain">
        One piece of work, from claimed to accepted
      </h2>
      <p className="ch__lead">One lane from our own board, as the board recorded it.</p>
      <div className="ch__body">
        <figure className="ch__shot">
          {/* The capture's own pixels are 2x; the box is sized so it lands at 1x on a laptop. */}
          <img
            src={boardCard}
            alt="A card on the musterd board: the lane's title, its owner dolly, its goal, a green 'accepted' chip and its branch."
            width={218}
            height={284}
            loading="lazy"
            decoding="async"
          />
          <figcaption className="ch__caption">
            The lane&rsquo;s card on our board.
          </figcaption>
        </figure>
        <ol className="ch__stops">
          {STOPS.map((s) => (
            <li key={s.label} className="ch__stop">
              <span className="ch__label mono">{s.label}</span>
              <p className="ch__text">{withDates(s.text)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
