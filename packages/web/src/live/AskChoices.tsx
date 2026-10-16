import { useState } from 'react';
import type React from 'react';
import type { AskChoice } from './askPhrase';

/**
 * An ask that is a choice, answered by picking an option (lane 01M511XNQC). On 2026-10-15 nick approved
 * a consult with options A–D from the rail without seeing them, and the asker read the empty accept as
 * option C. So a choice never gets a one-click Approve: every option is on screen in full, each is its
 * own answer, and the pick sends the option itself (`choiceReply`). The asker's recommendation wears a
 * small tag but is not pre-selected — recommending is theirs, choosing is yours.
 *
 * "None of these" declines. The picked option gets a soft stamp as it goes (CSS, off under reduced
 * motion), so the click is felt before the thread catches up.
 */
export function AskChoices({
  choices,
  asker,
  busy,
  onPick,
  onNone,
}: {
  choices: { options: AskChoice[]; recommended: string | null };
  asker: string;
  busy: boolean;
  onPick: (option: AskChoice) => void;
  onNone: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div
      className={`lc-choices${picked !== null ? ' has-pick' : ''}`}
      role="group"
      aria-label={`${asker}’s options`}
    >
      {choices.options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          disabled={busy || picked !== null}
          aria-pressed={picked === o.key}
          // `--i` deals the options in one after another, like cards onto a table.
          style={{ '--i': i } as React.CSSProperties}
          className={`lc-choice${picked === o.key ? ' is-picked' : ''}${
            choices.recommended === o.key ? ' is-rec' : ''
          }`}
          onClick={() => {
            setPicked(o.key);
            onPick(o);
          }}
        >
          <span className="lc-choice__key" aria-hidden="true">
            {o.key}
          </span>
          <span className="lc-choice__text">{o.text}</span>
          {choices.recommended === o.key && (
            <span className="lc-choice__rec">
              <span aria-hidden="true">✦ </span>
              {asker} recommends
            </span>
          )}
        </button>
      ))}
      {picked !== null && (
        <p className="lc-choices__sent" aria-live="polite">
          ✓ sent to {asker} — {picked}
        </p>
      )}
      <button
        type="button"
        disabled={busy || picked !== null}
        className="lc-choices__none"
        onClick={onNone}
      >
        None of these
      </button>
    </div>
  );
}
