import { INSTALL } from '../../content/generated/install';
import { FIRST_TEN_MINUTES_PATH, REPO_URL } from '../../content/site';
import './GettingStarted.css';

/**
 * Getting started (ADR 568, 2026-10-12): the preview is over, so this is the install, in three
 * steps, with the commands themselves. It replaced the preview's "Request a seat / Not yet" rows.
 *
 * The steps, commands and copy come from `content/install.data.ts` (ADR 669 §3.3), the one source the
 * README, llms.txt and the launch post agree with — the site no longer holds its own copy of the
 * install. Step 2 names no harness (nick, #2405); `musterd init`'s own detection list
 * (`packages/cli/src/onboard/harnesses/index.ts`) is what it finds.
 *
 * The commands are plain text in a terminal block, not a copy button: the page is prerendered and
 * needs no script for this, and `user-select: all` makes one click select the whole command.
 */
const STEPS = INSTALL.steps.map((step, i) => ({
  ...step,
  // The install step carries the alternative route (Homebrew); the others carry none.
  alt: i === 0 ? (INSTALL.alternatives[0] ?? null) : null,
}));

export function GettingStarted() {
  return (
    <section className="gs shell" id="getting-started" aria-labelledby="getting-started-h">
      <h2 className="gs__title" id="getting-started-h">
        Getting started
      </h2>
      <p className="gs__lead">
        {INSTALL.requires}
      </p>
      <ol className="gs__steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="gs__step">
            <span className="gs__num mono" aria-hidden="true">
              {i + 1}
            </span>
            <div className="gs__step-main">
              <h3 className="gs__step-title">{s.title}</h3>
              {s.body && <p className="gs__step-body">{s.body}</p>}
              <pre className="gs__cmd">
                {s.commands.map((c, j) => (
                  <code key={c}>
                    <span className="gs__prompt" aria-hidden="true">
                      ${' '}
                    </span>
                    <span className="gs__line">{c}</span>
                    {j < s.commands.length - 1 && '\n'}
                  </code>
                ))}
              </pre>
              {s.alt && (
                <p className="gs__alt">
                  {s.alt.lead} <code className="gs__inline">{s.alt.command}</code>
                </p>
              )}
              {/* The third capture (lane 01M4V74X9W, 2026-10-13): what step 3 leaves you looking at — our own
                  team's `musterd status`, taken Oct 13 2026, re-wrapped by hand at 48 columns so the phone rail
                  (358 px) holds it without a sideways scroll, like WhyTalk's frame. Columns the site does not
                  name are trimmed (model, build, harness — nick, #2405: the site says "agents", never a
                  harness). Reuses WhyTalk's terminal frame so no new CSS lands on the site budget. */}
              {i === STEPS.length - 1 && (
                <figure className="gs__shot wt__shot">
                  <pre className="wt__term">
                    <span className="t-meta t-b">Oct 13</span>
                    {'\n'}
                    <span className="t-acc">●</span> <span className="t-b">revive</span>
                    {'  33 members · 11 present · 6 working\n\n'}
                    <span className="t-b">WORKING</span>
                    {'  6\n  '}
                    <span className="t-acc">●</span> <span className="t-agent">miley</span>
                    {'   agent · designer\n    Home page: the third capture — a dated\n    musterd status frame under Getting\n    started (lane 01M4V74X9W)\n  '}
                    <span className="t-acc">●</span> <span className="t-agent">fifty</span>
                    {'   agent · platform\n    Run 38 (lane 01M4VJX4KB): matched repeat\n    on 6fd7aca, team lb-run38 created, bench\n    launching (~25 min).\n  '}
                    <span className="t-meta">… 4 more</span>
                  </pre>
                  <figcaption className="wt__caption">
                    Our team after step 3: who is on it, who is present, who is working.
                  </figcaption>
                </figure>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="gs__more">
        <a className="gs__link" href={FIRST_TEN_MINUTES_PATH}>
          See your first ten minutes
        </a>
        <a className="gs__link" href={REPO_URL}>
          Read the source on GitHub
        </a>
      </p>
    </section>
  );
}
