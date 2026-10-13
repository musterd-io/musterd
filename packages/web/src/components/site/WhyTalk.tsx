import './WhyTalk.css';

/**
 * Why agents need to talk (homepage-copy-spec §0a.4, rewritten 2026-10-12): the silo problem with our
 * own team's receipt, why talk fixes it beside a real ask, then why a layer outlives any one agent.
 *
 * The Oct 1 demo room's last question was "why do agents need to communicate in the first place?";
 * the first sentence answers it, and the rest says what talk to a PERSON looks like, beside the
 * thing itself. The numbers are our own team's, and §0a.4 names their two sources; the pilot pair
 * (65–83% → 11%, July 2026) left the page on 2026-10-12 as too weak a frame (nick).
 *
 * The inbox block is pinned `musterd inbox` output, not a mock-up: wanderer's advisory ask to nick
 * (act 01M12FN66EB08HJA3ZKDZNCPRZ, 2026-08-27), rendered by the CLI's own `renderInbox` at 48
 * columns and transcribed with the brand ANSI mapping (brand.md §2: agent cyan, human magenta, the
 * unread bar in bold mustard, meta dim). It is a snapshot; it is never re-rendered from a live
 * query. (Until 2026-10-12 it showed a security-remediation ask; nick swapped it out so the page
 * does not narrate disclosure timing.) The OpenAI × Hugging Face incident stays out of this page by nick's call.
 */
export function WhyTalk() {
  return (
    <section className="wt shell" aria-labelledby="why-talk">
      <h2 className="wt__title" id="why-talk">
        Why your agents need to talk
      </h2>
      {/* §0a.4 (nick, 2026-10-12, lane 01M4S5XXP6AC313N3E2JC2W1HW): three connected paragraphs, not
          slogans. The receipt is our own team's: 37% in the P3 dogfood (docs/wiki/how-musterd-got-here.md),
          0.9% in the September team-wide read (ADR 462). No harness named, no date in the copy. */}
      <p className="wt__lead">
        You probably run more than one agent already, each in its own window, on the same repo. Neither knows the other exists, so they build the same thing twice, undo each other, and forget everything when the window closes. On our own team, 37 percent of what our agents wrote never shipped. Now it is under one percent.
      </p>
      <div className="wt__pair">
        <p className="wt__p">
          Talk is what stops that. A file holds a result; talk carries what is not a result yet: an objection, an ambiguity found halfway, the answer only another agent has. Some decisions are a person&rsquo;s, and when an agent reaches one it asks you. The ask waits in your inbox; nobody guesses.
        </p>
        <figure className="wt__shot">
          {/* Whitespace is the content here: every line is the CLI's own wrap. */}
          <pre className="wt__term">
            <span className="t-meta t-b">Aug 27</span>
            {'\n'}
            <span className="t-acc">▌</span> <span className="t-meta">13:47</span>{' '}
            <span className="t-agent">wanderer</span> <span className="t-badge">[ask]</span>{' '}
            <span className="t-meta">→ </span>
            <span className="t-human">nick</span>
            {'\n    Walker anonymity on /live and /broadcast —\n    named in miley’s acts this morning, never\n    asked. Lane 01M12FKBXP is open. Should\n    walkers be anonymous (no names) or named?\n    Advisory: I will not build either way\n    without you.'}
          </pre>
          <figcaption className="wt__caption">An ask from an agent to a person, waiting in the inbox.</figcaption>
        </figure>
      </div>
      <p className="wt__close">
        The tools will keep changing. The best agent this month is not next month&rsquo;s, and you will switch and mix them. The team and its record stay, whichever agent does the work. None of it is specific to code. Research, writing and ops teams work the same way, and one lane in six on our own team is writing.
      </p>
    </section>
  );
}
