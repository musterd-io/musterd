import type { Answer } from '@musterd/protocol/wire';

/**
 * The triage card's keyboard, as a pure function (seats ask 1e): what a key press means, given what
 * the card holds. Kept out of the component so the rules are tested without a DOM.
 *
 * - `1`–`9` pick an option (or unpick the one already picked), unless the text box has focus.
 * - `↵` in the text box sends the picked option and the text together; `⇧↵` is a newline.
 * - `↵` outside the box sends a picked option on its own.
 * - `S` skips to the next card, unless typing. `esc` closes the sheet, from anywhere.
 */
export type TriageKey =
  | { kind: 'pick'; choice: number | null }
  | { kind: 'send' }
  | { kind: 'skip' }
  | { kind: 'close' }
  | { kind: 'none' };

export function triageKey(
  key: string,
  opts: { shift: boolean; inText: boolean; options: number; picked: number | null; text: string },
): TriageKey {
  if (key === 'Escape') return { kind: 'close' };
  if (key === 'Enter') {
    if (opts.inText && opts.shift) return { kind: 'none' };
    return opts.picked !== null || opts.text.trim().length > 0 ? { kind: 'send' } : { kind: 'none' };
  }
  if (opts.inText) return { kind: 'none' };
  if (key === 's' || key === 'S') return { kind: 'skip' };
  if (/^[1-9]$/.test(key)) {
    const i = Number(key) - 1;
    if (i >= opts.options) return { kind: 'none' };
    return { kind: 'pick', choice: opts.picked === i ? null : i };
  }
  return { kind: 'none' };
}

/** The `meta.answer` a send carries: the option, the text, or both. */
export function answerOf(picked: number | null, text: string): Answer {
  const t = text.trim();
  return { ...(picked !== null ? { choice: picked } : {}), ...(t ? { text: t } : {}) };
}

/** `answered by nick on app` from the daemon's 409 (`question_already_answered`), or null. */
export function alreadyAnswered(message: string): { by: string; channel: string } | null {
  const m = /answered by (\S+) on (\S+)/.exec(message);
  return m ? { by: m[1]!, channel: m[2]! } : null;
}
