/**
 * Question asks and the answer line (ADR 773, ADR 774) as plain TypeScript — no zod, so `/live` and
 * the MCP adapter's injectors read a question and check an answer line without a validator in their
 * bundle. `question.ts` builds the schemas.
 */

/** At most this many options on a question (keys 1–9 on `/live`). */
export const QUESTION_MAX_OPTIONS = 9;
export const QUESTION_TEXT_MAX = 280;
export const QUESTION_WHY_MAX = 600;
export const QUESTION_LABEL_MAX = 80;
export const QUESTION_CONSEQUENCE_MAX = 140;
export const ANSWER_TEXT_MAX = 4000;

export const QUESTION_AUDIENCES = ['addressee', 'team'] as const;
export type QuestionAudience = (typeof QUESTION_AUDIENCES)[number];

export const ANSWER_CHANNELS = ['live', 'app', 'slack', 'cli'] as const;
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];

export interface QuestionOption {
  label: string;
  consequence?: string | undefined;
}

export interface Question {
  text: string;
  why?: string | undefined;
  options?: QuestionOption[] | undefined;
  context?:
    | { lane?: string | undefined; pr?: number | undefined; branch?: string | undefined }
    | undefined;
  blocking: boolean;
  audience: QuestionAudience;
  inferred: boolean;
}

/** An answer: an option (0-based), free text, or both (ADR 773 §4). */
export interface Answer {
  choice?: number | undefined;
  text?: string | undefined;
}

/** Server-stamped on every answer; a client-sent copy is stripped (ADR 773 §5). */
export interface AnswerProof {
  channel: AnswerChannel;
  verified: boolean;
  by: string;
  late?: boolean | undefined;
}

/** True when an act's meta carries a question — the one test every surface uses. */
export function isQuestion(meta: Record<string, unknown> | null | undefined): boolean {
  const q = meta?.['question'];
  return typeof q === 'object' && q !== null && !Array.isArray(q);
}

/**
 * The answer as the seat reads it: the chosen option's label in double quotes, the text, or both
 * joined by ` — ` (ADR 774 §2). A choice past the question's options reads as `"option N"`.
 */
export function answerLabel(q: Pick<Question, 'options'>, a: Answer): string {
  const picked =
    a.choice === undefined ? undefined : (q.options?.[a.choice]?.label ?? `option ${a.choice + 1}`);
  const parts: string[] = [];
  if (picked !== undefined) parts.push(`"${picked}"`);
  if (a.text !== undefined && a.text.length > 0) parts.push(a.text);
  return parts.join(' — ');
}

/** The answer part of the line is capped here; the whole line at {@link ANSWER_LINE_MAX}. */
export const ANSWER_LINE_ANSWER_MAX = 2000;
export const ANSWER_LINE_MAX = 2400;
export const ANSWER_TRUNCATED = '…[truncated; full answer in team_wake_context]';

/**
 * The answer line's shape: the ⚡ prefix, then printable Unicode only (letters, marks, numbers,
 * punctuation, symbols, plain space) — one line, no controls, no format characters.
 */
export const ANSWER_LINE_PATTERN =
  '^⚡ musterd \\[[a-z0-9-]+\\]: [\\p{L}\\p{M}\\p{N}\\p{P}\\p{S} ]+$';

export function isPushableAnswerLine(line: string): boolean {
  return line.length <= ANSWER_LINE_MAX && new RegExp(ANSWER_LINE_PATTERN, 'u').test(line);
}

/**
 * Text as it may sit inside the fence: newlines fold to ` ⏎ `, the fence glyphs are escaped so the
 * text can neither close the fence nor open a forged one, other whitespace becomes a space, and
 * anything outside the line's character class (controls, zero-width joiners) is dropped.
 */
export function fenceText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ⏎ ')
    .replace(/«/g, '‹‹')
    .replace(/»/g, '››')
    .replace(/\s/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '');
}

function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const keep = Math.max(0, max - Array.from(ANSWER_TRUNCATED).length);
  return chars.slice(0, keep).join('') + ANSWER_TRUNCATED;
}

/**
 * The one wake line that carries body text (ADR 774): a verified person's answer to the woken
 * seat's own question. `recapOf` (the asker's own question text) makes the recap form, for a fresh
 * session that could not resume.
 */
export function composeAnswerLine(p: {
  team: string;
  person: string;
  questionId: string;
  answerId: string;
  channel: AnswerChannel;
  answer: string;
  recapOf?: string | undefined;
}): string {
  const head = `⚡ musterd [${p.team}]: ${p.person} answered your question ${p.questionId} (via ${p.channel}) — `;
  const recap = p.recapOf !== undefined ? `you asked: «${fenceText(p.recapOf)}» — ` : '';
  const tail = ` — act on it; ack with team_wake_context {act_id: "${p.answerId}"}`;
  const budget = ANSWER_LINE_MAX - Array.from(head + recap + tail).length - 2;
  const answer = capChars(fenceText(p.answer), Math.min(ANSWER_LINE_ANSWER_MAX, budget));
  return `${head}${recap}«${answer}»${tail}`;
}
