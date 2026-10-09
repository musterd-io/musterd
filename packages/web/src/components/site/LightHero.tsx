import { EARLY_ACCESS_URL, TAGLINE } from '../../content/site';
import './LightHero.css';

/**
 * The typographic landing hero (ADR 302): type on the warm mustard ground, no canvas, no render
 * loop. The pitch is the prerendered text itself.
 */
export function LightHero() {
  return (
    <section className="lh">
      <div className="lh__inner shell">
        {/*
          No wordmark here. SiteNav states the name 38px above this, at the same size, and at phone
          width both sit flush left — so the page opened by saying "musterd" twice before it said
          anything. The nav carries identity; the hero carries the pitch. (2026-09-19)
        */}
        <h1 className="lh__title">{TAGLINE}</h1>
        {/*
          The subhead carries the whole ADR 550 chain above the fold, at the strength the record
          holds it: claimed (verified), model (observed), accepted (verified, and enforced to be a
          different member), plus the refusal. It names the people as members. No contrast frame
          (brand.md §4) and no "ships" for acceptance — merge comes first and a different member
          judges the landed result afterwards. docs/design/homepage-copy-spec.md §0.3, 2026-10-09.
        */}
        <p className="lh__sub">
          Claude Code, Codex, Cursor and the people you work with join one team as named members.
          Every piece of work shows who claimed it, which model did it and who accepted it. Any
          member can say no.
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
    </section>
  );
}
