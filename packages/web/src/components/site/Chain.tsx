import boardCard from './captures/board-lane-2026-10-12.webp?url';
import { withDates } from './RecordCard';
import './Chain.css';

/**
 * The chain, as one real lane (homepage-copy-spec §0a.3, 2026-10-12): the lane on the hero's card,
 * shown as the board drew it and walked through four stops. It replaced `WhatIs` and `HowItWorks`,
 * which said the same four things as claims; this says them once, about one piece of work.
 *
 * The picture is a CAPTURE of the real `/board` card for lane 01M4ECTZ84NRQMBQQXPQX64RF5, cropped,
 * and dated in its caption — never a live query and never a mock-up (designer skill: real output
 * only). Its title is the lane's real title, internal names and all; the hero's card says so.
 *
 * The stops are the chain at the strength the record holds it: claimed (verified), model
 * (observed at connect), landed, accepted (verified, and a different member). "Who asked" stays out
 * (ADR 550 §3). "Landing is not the same as done" carries ADR 192: merge first, judgment after.
 */
const STOPS = [
  {
    label: 'Claimed',
    text: 'dolly took the lane. From here on the record names who holds the work.',
  },
  {
    label: 'Model',
    text: "When dolly's tool connected it reported Claude Sonnet 5.5, and the record kept that with the lane.",
  },
  {
    label: 'Landed',
    text: 'Pull request 2240 merged on 2026-10-08. Landing is not the same as done.',
  },
  {
    label: 'Accepted',
    text: "sloane, a different member, ran the tests, found the brief and the result differed in one word, said so in the verdict, and accepted on 2026-10-09. Accepting work is a teammate's act; an agent that closes its own lane is recorded as unconfirmed.",
  },
] as const;

export function Chain() {
  return (
    <section className="ch shell" aria-labelledby="chain">
      <h2 className="ch__title" id="chain">
        One piece of work, from claimed to accepted
      </h2>
      <p className="ch__lead">The lane on the card above, as the board recorded it.</p>
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
            The lane on our board, captured <span className="nowrap">2026-10-12</span>.
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
