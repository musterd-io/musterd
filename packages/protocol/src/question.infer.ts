import {
  QUESTION_CONSEQUENCE_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_MAX_OPTIONS,
  QUESTION_TEXT_MAX,
} from './question.wire.js';

/**
 * The inferred-question check (ADR 781): does a turn's last message end by asking the person
 * something? Pure and shared, so every catcher — Claude Code's Stop hook, the other harnesses' turn
 * ends, `musterd host` for headless wakes — applies the same rule.
 */
export interface InferredQuestion {
  text: string;
  options?: { label: string; consequence?: string }[];
}

const CHOICE = /\b(which|pick|choose|prefer|or)\b/i;
const YES_NO = /^(want me|shall i|should i|do you want|ok to|okay to|can i|may i)\b/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|[A-Ia-i][.)])\s+(.+)$/;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Markdown emphasis and inline code markers off, whitespace collapsed. */
function plain(s: string): string {
  return s
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function option(item: string): { label: string; consequence?: string } | null {
  const text = plain(item);
  const at = text.search(/ — | – |: /);
  const label = clip((at > 0 ? text.slice(0, at) : text).trim(), QUESTION_LABEL_MAX);
  if (!label) return null;
  const rest =
    at > 0
      ? text
          .slice(at)
          .replace(/^ [—–] |^: /, '')
          .trim()
      : '';
  return rest ? { label, consequence: clip(rest, QUESTION_CONSEQUENCE_MAX) } : { label };
}

export function inferQuestion(message: string): InferredQuestion | null {
  // Code and quotes are someone else's words or output, never the seat asking.
  const prose = message
    .replace(/```[\s\S]*?(```|$)/g, '\n\n')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = paragraphs.at(-1);
  if (!last) return null;
  const lines = last.split('\n');
  const finalLine = plain(lines.at(-1) ?? '');
  if (!finalLine.endsWith('?')) return null;
  // The last sentence of the final line: after the last sentence end that precedes it.
  const sentences = finalLine.split(/(?<=[.!?])\s+/);
  const sentence = (sentences.at(-1) ?? '').replace(/^[-*•\d.)\s]+/, '').trim();
  if (sentence.replace(/[?\s]/g, '').length < 3) return null;
  const text = clip(sentence, QUESTION_TEXT_MAX);

  if (YES_NO.test(sentence)) return { text, options: [{ label: 'Yes' }, { label: 'No' }] };
  if (CHOICE.test(sentence)) {
    // The list just before the question: earlier lines of its own paragraph, else the paragraph
    // before it.
    const before = lines.length > 1 ? lines.slice(0, -1) : (paragraphs.at(-2)?.split('\n') ?? []);
    const items: string[] = [];
    for (let i = before.length - 1; i >= 0; i--) {
      const m = LIST_ITEM.exec(before[i]!);
      if (!m) break;
      items.unshift(m[1]!);
    }
    const options = items
      .slice(0, QUESTION_MAX_OPTIONS)
      .map(option)
      .filter((o): o is NonNullable<typeof o> => o !== null);
    if (options.length >= 2) return { text, options };
  }
  return { text };
}
