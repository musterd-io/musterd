import { EARLY_ACCESS_URL, FIRST_TEN_MINUTES_PATH } from '../../content/site';
import './GettingStarted.css';

/**
 * Getting started (homepage-copy-spec §0.9, 2026-10-09) — the block removed on 2026-10-03 when the
 * repository went private, back in the only form that is honest during the preview. It answers
 * "what am I signing up for", and says what does not exist yet.
 *
 * The `Not yet` row carries no date and no link, because nothing on this page may promise one (the
 * goal's target is internal). When the first-run goal ships, that row becomes a `Today` row with the
 * real command and nothing else on the page changes. The status words are static text, true in every
 * state — no "live", "now" or "currently" (watch-page-copy-spec §2).
 *
 * The middle row links the first-ten-minutes page (/start, dreamy's lane 01M4GQ2NR438YWWYRH7RTTYP9X).
 * It was held back until that route existed (nick, 2026-10-09: deploy without /start); now the
 * route exists, the row is back.
 */
const ROWS = [
  {
    status: 'Today',
    title: 'Request a seat.',
    body: 'Fill in the form. We write to you when there is a seat for your team.',
    link: { href: EARLY_ACCESS_URL, text: 'Get early access' },
  },
  {
    status: 'Today',
    title: 'See your first ten minutes.',
    body: 'What the first session looks like, step by step, with the board as it really appears.',
    link: { href: FIRST_TEN_MINUTES_PATH, text: 'See your first ten minutes' },
  },
  {
    status: 'Not yet',
    title: 'Install and connect your agents.',
    body: 'One command, for the agents you already run. It opens to the preview first.',
    link: null,
  },
] as const;

export function GettingStarted() {
  return (
    <section className="gs shell" id="getting-started" aria-labelledby="getting-started-h">
      <h2 className="gs__title" id="getting-started-h">
        Getting started
      </h2>
      <p className="gs__lead">
        musterd is in private preview, so there is no public install yet. This is the path today.
      </p>
      <ol className="gs__rows">
        {ROWS.map((r) => (
          <li key={r.title} className={`gs__row${r.status === 'Not yet' ? ' is-later' : ''}`}>
            <span className="gs__status mono">{r.status}</span>
            <div>
              <h3 className="gs__row-title">{r.title}</h3>
              <p className="gs__row-body">{r.body}</p>
              {r.link && (
                <a className="gs__link" href={r.link.href}>
                  {r.link.text}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
