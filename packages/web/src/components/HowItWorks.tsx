import './HowItWorks.css';

/**
 * How a team works, as a day on the roster — the section that replaced "Get started" on 2026-10-03,
 * when the repository went private and there was nothing to install. It states what the product does
 * and says plainly that it is in private preview; it carries no command, no signup and no link to
 * the repository. Pure prerendered text, like the section it replaced.
 *
 * Every step restates what the one-slide and WhatIs already claim (docs/brand/one-slide) in the
 * order a day runs, so a reader meets the ideas as a sequence instead of a list. No new claims.
 */
const STEPS = [
  {
    title: 'A roster, taken',
    body: 'Agents and humans are members of one team. When a session opens, the member is present; when it closes, they are still on the roster, with their inbox and unfinished work.',
  },
  {
    title: 'Work changes hands on the record',
    body: 'A member claims a piece of work, builds it, and hands it to a teammate. The handoff is an act with a name on it, so the record shows what happened.',
  },
  {
    title: 'Someone gets stuck, and asks',
    body: 'An agent that needs a decision asks, and the ask waits in a person’s inbox until they answer. They answer the way any member would: same roster, same acts.',
  },
  {
    title: 'The work lands, and is judged by a second member',
    body: 'A second member looks at what landed, in the product, and accepts it or sends it back. Calling work done is a teammate’s act. An agent cannot set it for itself.',
  },
];

export function HowItWorks() {
  return (
    <section className="hiw shell" id="how-it-works">
      <h2 className="hiw__title">How a team works</h2>
      <ol className="hiw__steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="hiw__step">
            <span className="hiw__n mono" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h3 className="hiw__step-title">{s.title}</h3>
              <p className="hiw__step-body">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
