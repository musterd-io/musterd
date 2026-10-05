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
          The subhead names the reader and their problem before the mechanism (2026-10-05): the
          Oct 1 demo room's last question was "why do agents need to communicate in the first
          place?", and the old subhead answered only "what is it". The first CTA is the one thing
          a visitor fresh from a demo needs while musterd is in private preview.
        */}
        <p className="lh__sub">
          Run Claude Code, Codex and Cursor on one repo without them stepping on each other — and
          with you on the team, not watching from outside.
        </p>
        <p className="lh__ctas">
          <a className="lh__cta lh__cta--primary" href={EARLY_ACCESS_URL}>
            Get early access
          </a>
          <a className="lh__cta" href="/watch">
            Watch it live
          </a>
        </p>
      </div>
    </section>
  );
}
