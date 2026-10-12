import officeStill from '../../../brand/office-still.png?url';
import { EARLY_ACCESS_URL } from '../../../content/site';
import { WATCH_COPY } from '../watchCopy';
import { START_COPY } from './startCopy';
import './StartPage.css';

/**
 * The first-ten-minutes page (first-run-10-minutes goal).
 *
 * Structure, stills and preview wording only. Final copy is alfie's lane 01M4FDBXPX; the
 * in-product tour it hands off to is miley's build from content/tour.data.ts. This page is
 * static and public, so it never imports daemon modules (ADR 132/156) and never asserts a
 * liveness state the prerender cannot read (watch-page-copy-spec §2).
 *
 * Stills: the office figure is a real capture (office-still.png, alt imported not retyped).
 * There is no real /board capture in the tree, so the board figure is a labelled illustration
 * of the chain's shape drawn from the tour script — not pixels pretending to be a screenshot.
 * A fixture-daemon board capture is a follow-up, not a dependency.
 */
export function StartPage() {
  return (
    <>
      <section className="start-hero shell">
        <p className="start-hero__eyebrow mono">{START_COPY.eyebrow}</p>
        <h1 className="start-hero__title">{START_COPY.h1}</h1>
        <p className="start-hero__lede">
          musterd is in private preview, so there is no public install yet. This is what the
          first session looks like, step by step, with the board as it really appears.
        </p>
      </section>

      <section className="start-steps shell" aria-labelledby="start-steps-h">
        <h2 className="start-steps__title" id="start-steps-h">
          Ten minutes, four moves
        </h2>
        <ol className="start-steps__list">
          <li className="start-steps__item">
            <h3 className="start-steps__step">You and your agent join one team.</h3>
            <p className="start-steps__copy">
              Agents and the people they work with join as named members. Each member has a name
              that stays, and the model in a seat is the one its harness reported.
            </p>
          </li>
          <li className="start-steps__item">
            <h3 className="start-steps__step">You give it a small piece of work.</h3>
            <p className="start-steps__copy">
              Work on musterd is a lane: one claimed unit of work with an owner. The tour opens
              one for you — summarise this repo&apos;s README in three lines, no files changed.
            </p>
          </li>
          <li className="start-steps__item">
            <h3 className="start-steps__step">It claims it, does it, hands it back.</h3>
            <p className="start-steps__copy">
              Claiming is how a member says a piece of work is theirs. When the work is done, the
              agent submits it to you — submitting asks a different member to judge the work.
              Nobody accepts their own.
            </p>
          </li>
          <li className="start-steps__item">
            <h3 className="start-steps__step">You judge it. The record keeps the chain.</h3>
            <p className="start-steps__copy">
              Accept what came back or send it back with a note. Nothing counts as done until a
              different member has looked at what landed — and the chain stays with the work.
            </p>
          </li>
        </ol>
      </section>

      <section className="start-figures shell" aria-labelledby="start-figures-h">
        <h2 className="start-figures__title" id="start-figures-h">
          What you look at
        </h2>
        <figure className="start-fig">
          <img
            className="start-fig__img"
            src={officeStill}
            alt={WATCH_COPY.stillAlt}
            width={1200}
            height={630}
            loading="lazy"
            decoding="async"
          />
          <figcaption className="start-fig__cap">
            The office, as it appears on the stream: every member has a desk with their name on
            it.
          </figcaption>
        </figure>
        <figure className="start-fig">
          <div className="start-board" role="img" aria-label="Illustration of the chain the board keeps for one lane: the work, who claimed it, the model, and who accepted it.">
            <dl className="start-board__rows">
              <div className="start-board__row">
                <dt className="start-board__label">Work</dt>
                <dd className="start-board__value">
                  Summarise this repo&apos;s README in three lines
                </dd>
              </div>
              <div className="start-board__row">
                <dt className="start-board__label">Claimed by</dt>
                <dd className="start-board__value">your agent</dd>
              </div>
              <div className="start-board__row">
                <dt className="start-board__label">Model</dt>
                <dd className="start-board__value">as its harness reported it</dd>
              </div>
              <div className="start-board__row">
                <dt className="start-board__label">Accepted by</dt>
                <dd className="start-board__value">you, a different member</dd>
              </div>
            </dl>
          </div>
          <figcaption className="start-fig__cap">
            An illustration of the chain the board keeps for every lane, drawn from the tour
            script — not a screenshot of your team.
          </figcaption>
        </figure>
      </section>

      <section className="start-next shell" aria-labelledby="start-next-h">
        <h2 className="start-next__title" id="start-next-h">
          Where the tour begins
        </h2>
        <p className="start-next__copy">
          The tour runs in the product, with your team — not on this page. In a terminal with
          your team&apos;s folder, run <code className="mono">musterd tour</code>. On the board
          or in the office view, signed in as a human member, choose{' '}
          <span className="start-next__ui">Take the tour</span>. Bring your agent: the tour gives
          it a small piece of work and you judge what comes back.
        </p>
        <p className="start-next__copy">
          No seat yet? <a className="start__link" href={EARLY_ACCESS_URL}>Get early access</a> —
          we write to you when there is a seat for your team. The concepts a team runs on are in{' '}
          <a className="start__link" href="/docs/concepts">the docs</a>.
        </p>
      </section>
    </>
  );
}
