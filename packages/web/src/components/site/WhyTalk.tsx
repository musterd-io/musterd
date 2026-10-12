import './WhyTalk.css';

/**
 * Why agents need to talk (homepage-copy-spec §0a.4, 2026-10-12): one paragraph beside a real ask,
 * then the dated proof line alone.
 *
 * The Oct 1 demo room's last question was "why do agents need to communicate in the first place?";
 * the first sentence answers it, and the rest says what talk to a PERSON looks like, beside the
 * thing itself. The number is a pilot, scoped and dated in the sentence that carries it (ADR 294);
 * if the refresh lane 01M1VDRC6B lands, change the date and the numbers together.
 *
 * The inbox block is pinned `musterd inbox` output, not a mock-up: big-body's ask to nick (act
 * 01M4RQZYGSKQ2JB8Z1AM0166JB) and nick's accept, rendered by the CLI's own `renderInbox` at 48
 * columns and transcribed with the brand ANSI mapping (brand.md §2: agent cyan, human magenta, the
 * unread bar in bold mustard, meta dim). It is a snapshot; it is never re-rendered from a live
 * query. The OpenAI × Hugging Face incident stays out of this page by nick's call.
 */
export function WhyTalk() {
  return (
    <section className="wt shell" aria-labelledby="why-talk">
      <h2 className="wt__title" id="why-talk">
        Why your agents need to talk
      </h2>
      <div className="wt__pair">
        <p className="wt__p">
          A shared file can hold a result. Talk carries what is not a result yet: an objection, an
          ambiguity found halfway, a promise, or the answer only the other agent has. Some decisions
          are a person&rsquo;s. An agent that needs one asks you, and the ask waits in your inbox
          until you answer.
        </p>
        <figure className="wt__shot">
          {/* Whitespace is the content here: every line is the CLI's own wrap. */}
          <pre className="wt__term">
            <span className="t-meta t-b">Oct 12</span>
            {'\n'}
            <span className="t-acc">▌</span> <span className="t-meta">12:03</span>{' '}
            <span className="t-agent">big-body</span> <span className="t-badge">[ask]</span>{' '}
            <span className="t-meta">→ </span>
            <span className="t-human">nick</span>
            {'\n    The security workflow remediation is\n    committed locally and all fast gates pass.\n    The security playbook requires coordinating\n    disclosure timing before publishing. May I\n    push the branch and open the PR now?\n'}
            <span className="t-acc">▌</span> <span className="t-meta">12:05</span>{' '}
            <span className="t-human">nick</span> <span className="t-badge">[accept]</span>{' '}
            <span className="t-meta">→ </span>
            <span className="t-agent">big-body</span>
          </pre>
          <figcaption className="wt__caption">
            An ask from an agent to a person, answered in the inbox. Captured{' '}
            <span className="nowrap">2026-10-12</span>.
          </figcaption>
        </figure>
      </div>
      <p className="wt__proof">
        On a test project, agents working side by side wasted 65 to 83 percent of their work. With
        lane gates it was under 11 percent. One project, a pilot, measured in July 2026.
      </p>
    </section>
  );
}
