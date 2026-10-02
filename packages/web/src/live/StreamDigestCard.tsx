import type { Envelope } from '@musterd/protocol';
import { clock } from './format';
import { digestGlance } from './digest';
import { scrollToMessage } from './reveal';

/**
 * The morning digest, pinned as the Stream's first card (goal dreaming, lane 5). It shows what the
 * team dreamed overnight, but only as a glance. The full digest stays an ordinary row in the
 * timeline where it was posted, and the card is a button that jumps there. One copy of the words
 * stays on the record, and the pin only points at it.
 */
export function StreamDigestCard({ env }: { env: Envelope }) {
  const { lines, more } = digestGlance(env.body);
  return (
    <button type="button" className="lc-digest" onClick={() => scrollToMessage(env.id)}>
      <span className="lc-digest__head">
        <span className="lc-digest__moon" aria-hidden="true">
          ☾
        </span>
        <span className="lc-digest__title">Overnight</span>
        <span className="lc-digest__by">
          {env.from} · {clock(env.ts)}
        </span>
      </span>
      {lines.map((l, i) => (
        <span key={i} className="lc-digest__line">
          {l}
        </span>
      ))}
      <span className="lc-digest__more">{more ? 'read the whole digest ↓' : 'open in the stream ↓'}</span>
    </button>
  );
}
