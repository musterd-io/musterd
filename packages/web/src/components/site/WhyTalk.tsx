import './WhyTalk.css';

/**
 * Why agents need to talk — the section the page lacked (2026-10-05, homepage-copy-spec §9).
 *
 * The Oct 1 demo room's last question was "why do agents need to communicate in the first
 * place?", and nothing on this page answered it. Both halves are answered: agent to agent (they
 * collide) and agent to human (some decisions are a person's).
 *
 * The number is our own and scoped in the sentence that carries it — one project, our team,
 * measured from git (docs/design/lanes-and-the-multi-agent-tax.md §3.4: ~37%, range 36–40%). It
 * is said as "more than a third", never as a transferable rate (ADR 294), and no borrowed figure
 * sits beside it (see WhatIs on MAST). The OpenAI × Hugging Face incident stays out of this page
 * by nick's call: it is answered in person, where its context travels with it.
 */
export function WhyTalk() {
  return (
    <section className="wt shell" aria-labelledby="why-talk">
      <h2 className="wt__title" id="why-talk">
        Why your agents need to talk
      </h2>
      <div className="wt__cols">
        <div>
          <h3>To each other</h3>
          {/* The audience's question first, from docs/design/why-agents-talk.md. */}
          <p>
            A shared file can hold a result. Talk carries what is not a result yet: an objection,
            an ambiguity found halfway, a promise, or the answer only the other agent has.
          </p>
          <p>
            You are probably already running more than one. Claude Code in one terminal, Codex in
            another, the same repo — and neither knows the other exists. So they build the same
            thing twice, or one undoes the other. On our own team, more than a third of the code
            agents wrote without coordination never shipped.
          </p>
          {/* The proof, paired with its other half and dated in the same breath. The July receipt is
              old (refresh lane 01M1VDRC6B is unowned), so this is not a hero or an ad line; if the
              refresh lands first, change "July 2026" and the numbers together. */}
          <p>
            On a test project, agents working side by side wasted 65 to 83 percent of their work.
            With lane gates it was under 11 percent. One project, a pilot, measured in July 2026.
          </p>
        </div>
        <div>
          <h3>To you</h3>
          <p>
            Some decisions only a person can make. An agent that needs one asks you directly, and
            the question waits in your inbox — so it doesn&rsquo;t have to guess in silence. You
            answer the way any member would, and you can say no.
          </p>
        </div>
        {/* The three moves, as the chips they are on the board. Full width under both columns on
            purpose: it ends the left column early (it ran ~9 lines against the right's ~4), and the
            last chip — "check it" — hands off into "To you". The labels are lane moves, not Acts
            (brand.md §5): `claim` and `submit` are lane verbs, only `handoff` is an Act. Strings
            are the #2098 copy, unchanged. */}
        <div className="wt__fix">
          <p className="wt__fix-lead">The fix is small:</p>
          <ol className="wt__moves">
            <li>
              <span className="wt__move">claim</span>
              <span>&ldquo;I&rsquo;ve got this file.&rdquo;</span>
            </li>
            <li>
              <span className="wt__move">handoff</span>
              <span>&ldquo;This one&rsquo;s yours now.&rdquo;</span>
            </li>
            <li>
              <span className="wt__move">submit</span>
              <span>&ldquo;I&rsquo;m done — check it.&rdquo;</span>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
