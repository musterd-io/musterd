import { EARLY_ACCESS_URL, TAGLINE } from '../../content/site';
import { StreamSection } from './StreamSection';
import './LightHero.css';

/**
 * The typographic landing hero (ADR 302): type on the warm mustard ground, no canvas, no render
 * loop. The pitch is the prerendered text itself.
 *
 * Two columns since 2026-10-12 (ADR 567): the pitch on the left and the team's office on the right —
 * the stream, or its still between sessions — so the first picture on the page is the team making
 * the claim. On a phone the office follows the preview line. (A record card sat here for one draft;
 * it said what the chain section below says, so the lane's facts now live there once.)
 */
export function LightHero() {
  return (
    <section className="lh">
      <div className="lh__inner shell">
        <div className="lh__pitch">
        {/*
          No wordmark here. SiteNav states the name 38px above this, at the same size, and at phone
          width both sit flush left — so the page opened by saying "musterd" twice before it said
          anything. The nav carries identity; the hero carries the pitch. (2026-09-19)
        */}
        <h1 className="lh__title">{TAGLINE}</h1>
        {/*
          The subhead says what the reader gets (what landed, who stands behind it) before how
          (who did it, who accepted it) — ADR 563 decision 2. It names the people as members. No
          contrast frame (brand.md §4) and no "ships" for acceptance — merge comes first and a
          different member judges the landed result afterwards. The mechanisms ADR 563 moved out
          of the headline ("which model", "any member can say no") live in the chain section.
          docs/design/homepage-copy-spec.md §0a.2, 2026-10-12.
        */}
        <p className="lh__sub">
          Your agents and the people you work with are named members of one team.
          You know what landed and who stands behind it, because every piece of work shows who did
          it and who accepted it.
        </p>
        <p className="lh__ctas">
          <a className="lh__cta lh__cta--primary" href={EARLY_ACCESS_URL}>
            Get early access
          </a>
          {/* Names the action. "Watch it live" was a state claim in prerendered HTML. */}
          <a className="lh__cta" href="/watch">
            Watch the team work
          </a>
        </p>
        {/* What happens after the click, and why there is no install: the primary button sets an
            expectation. nick confirms this promise against what the form actually sends. */}
        <p className="lh__note">Private preview. We write to you when there is a seat for your team.</p>
        </div>
        <StreamSection />
      </div>
    </section>
  );
}
