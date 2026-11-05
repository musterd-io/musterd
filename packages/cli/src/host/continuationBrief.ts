import { readFileSync } from 'node:fs';
import { priceRowFor } from './prices.js';

/**
 * ADR 810: the compacted continuation. When ADR 805's price rung refuses a `--resume` because the
 * transcript would cost more than `resume_max_usd` to re-ingest, the wake used to spawn fresh and
 * lose the seat's working context: finding 032 read 24 of 26 act-lane wakes that way, each paying
 * the seat-primer boot to answer one act with no memory of the last. This module turns the
 * transcript into a *brief* the fresh spawn can carry: a deterministic extraction of what the seat
 * said and did, newest last, trimmed from the oldest end until it prices under the same bound — no
 * model call, no summary the host would have to pay for and could not attest.
 *
 * What survives: the seat's own text turns, its tool calls (name, and arguments by construction:
 * enum acts and states and integers with their values, every other key by name only), and the person's prompts
 * (clipped). What never does: thinking blocks, tool results (the bulk of a transcript, and
 * re-readable), attachments, API-request mirrors, any tool argument that is not a path or an
 * identifier, and anything in prose that looks like a credential (hard rule 5 applies to the brief
 * as it does to a log line; the boundary is spelled out at {@link toolInputLine}). The brief
 * rides the `-p` line after the wake line, so it is ingested once, like a resume's history would
 * have been, at a size the bound allows.
 */

/** The most a brief may carry whatever the bound allows: a `-p` argument has to stay well under
 *  Linux's 128 KiB per-argument ceiling, and a brief longer than this is a transcript, not a brief. */
export const BRIEF_MAX_BYTES = 48 * 1024;
/** Per-line clip: a turn is summarised by its opening, never replayed. */
const LINE_MAX = 600;
/** A person's prompt keeps less: the wake line already says what this wake is for. */
const PROMPT_MAX = 400;
/** A tool call's arguments, as one clipped JSON line. */
const TOOL_INPUT_MAX = 160;

export interface ContinuationBrief {
  /** The brief itself, ready to ride the prompt. */
  text: string;
  /** Turns kept (one line each) and turns dropped from the oldest end to fit the budget. */
  turns: number;
  dropped: number;
  /** What was read: the transcript's size and the budget the brief was fitted to. */
  source_bytes: number;
  budget_bytes: number;
}

/**
 * How many brief bytes the bound buys on this model, at the same bytes/4 × input rate ADR 805
 * prices a resume with — so a brief under it is under the bound by the rung's own arithmetic —
 * capped at {@link BRIEF_MAX_BYTES}. Undefined when the model has no price row: the brief cannot be
 * shown under the bound, so there is none (the fresh spawn is always valid).
 */
export function briefBudgetBytes(boundUsd: number, model: string | undefined): number | undefined {
  if (!model) return undefined;
  const row = priceRowFor(model);
  if (!row || row.input <= 0) return undefined;
  const bytes = Math.floor(((boundUsd * 1_000_000) / row.input) * 4);
  return Math.max(0, Math.min(BRIEF_MAX_BYTES, bytes));
}

/**
 * The credential boundary (hard rule 5), in two layers — because the brief rides a process argument
 * and the next session's transcript, and a transcript holds whatever the seat read or typed.
 *
 * 1. **By construction, for tool calls:** a tool's argument never rides the brief as a value unless
 *    it is a member of a closed set the product owns — an act name, a lane state — or an integer.
 *    A field name admits nothing (`{pattern: 'hunter2'}`), and neither does a shape
 *    (`{path: 'hunter2/secret'}` is a path by every path grammar; an AWS key id is Crockford
 *    base32): big-body's three acceptance reads of 2026-11-05 found each in turn. So paths, ids,
 *    names, patterns, a Bash `command`, a Write `content`, a `body`, a `password` — every other
 *    argument — ride as the key alone, and nothing here depends on recognising a secret.
 * 2. **Patterns, for the seat's own text and the person's prompts:** known key prefixes, bearer and
 *    key=value forms tolerant of JSON quoting, and any long opaque token (letters and digits, no
 *    spaces) — run on the WHOLE text before it is clipped, so a clip never splits a secret out of its
 *    pattern's reach.
 */
/**
 * What a tool-argument value may ride the brief as (big-body's acceptance reads of 2026-11-05, three
 * of them): nothing a person could have typed. A field NAME is not a grammar (`{pattern:
 * 'hunter2'}`), and a SHAPE is not one either — `hunter2/secret` is a path by every path grammar,
 * and an AWS access key id is twenty characters of Crockford base32. The only values that cannot
 * carry a credential are the ones drawn from a closed set the product owns: an act name, a lane
 * state, an integer. Everything else — paths, ids, names, patterns, commands, bodies — rides as its
 * key alone. The seat's own text turns say what file it touched, in its own words, under the prose
 * patterns.
 */
const ACT_KEYS = new Set(['act']);
const STATE_KEYS = new Set(['state']);
const INT_KEYS = new Set(['offset', 'limit']);
const ACTS = new Set([
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
  'resolve',
  'steer',
  'challenge',
  'defer',
  'ask',
  'insight',
]);
const LANE_STATES = new Set([
  'open',
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'ready_for_review',
  'done',
  'abandoned',
  'parked',
]);

/** The value a tool argument may ride as — a member of a closed set the product owns, or an
 *  integer — else undefined. Exported for the tests. */
export function constrainedValue(key: string, value: unknown): string | undefined {
  if (INT_KEYS.has(key)) {
    return typeof value === 'number' && Number.isInteger(value) ? String(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  if (ACT_KEYS.has(key)) return ACTS.has(value) ? value : undefined;
  if (STATE_KEYS.has(key)) return LANE_STATES.has(value) ? value : undefined;
  return undefined;
}

const SECRET_PATTERNS = [
  /\b(mskey|msgr|mscr|msat)_[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key: value / key=value / "key": "value" / "the key is value", for the usual credential key names.
  /\b(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|credential|private[_-]?key)["']?\s*(?:[:=]|\b(?:is|was)\b)\s*["']?[^\s"',}]+/gi,
  // A long opaque run with both letters and digits: a key, a token, a hash — never prose.
  /(?<![A-Za-z0-9_])(?=[A-Za-z0-9_+/=-]{24,}(?![A-Za-z0-9_+/=-]))(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])[A-Za-z0-9_+/=-]{24,}/g,
];

/** Exported for the tests: the pattern layer, applied to a whole text before any clip. */
export function redact(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A tool call's argument line: a value rides only when it parses as one of the grammars above
 *  ({@link constrainedValue}); every other argument rides as its key alone. Exported for the tests. */
export function toolInputLine(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const v = constrainedValue(key, value);
    parts.push(v === undefined ? key : `${key}=${v}`);
  }
  return parts.join(' ');
}

/** One turn of the brief, as the transcript's `user` / `assistant` records yield it. */
function turnLines(record: Record<string, unknown>): string[] {
  const type = record['type'];
  if (type !== 'user' && type !== 'assistant') return [];
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  const lines: string[] = [];
  if (typeof content === 'string') {
    // A person's (or the wake line's) prompt, as a plain string: redacted whole, then clipped.
    if (type === 'user' && content.trim()) lines.push(`> ${oneLine(redact(content), PROMPT_MAX)}`);
    return lines;
  }
  if (!Array.isArray(content)) return [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Record<string, unknown>;
    const kind = it['type'];
    if (type === 'assistant' && kind === 'text' && typeof it['text'] === 'string') {
      const text = it['text'].trim();
      if (text) lines.push(oneLine(redact(text), LINE_MAX));
    } else if (type === 'assistant' && kind === 'tool_use' && typeof it['name'] === 'string') {
      // Arguments by construction: safe keys with values, the rest by name (see the boundary above).
      lines.push(
        `[${it['name']}] ${oneLine(toolInputLine(it['input']), TOOL_INPUT_MAX)}`.trimEnd(),
      );
    } else if (type === 'user' && kind === 'text' && typeof it['text'] === 'string') {
      const text = it['text'].trim();
      if (text) lines.push(`> ${oneLine(redact(text), PROMPT_MAX)}`);
    }
    // thinking, tool_result, images, attachments: never.
  }
  return lines;
}

const HEADER =
  '--- Continuation brief (ADR 810) ---\n' +
  'Your previous session on this seat ended; a resume would have cost more than the team allows, ' +
  'so the host compacted it. What you said and did, oldest to newest, one line a turn; tool ' +
  'results are not replayed — re-read what you need.';

/**
 * Compact a Claude Code transcript (JSONL, one record a line) into a brief at most `budgetBytes`
 * long. Reads the whole file once; a file that cannot be read or holds no turn yields no brief.
 * Trimming drops whole turns from the OLDEST end, so what the seat did last is what it keeps.
 */
export function compactTranscript(
  path: string,
  budgetBytes: number,
): ContinuationBrief | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    for (const l of turnLines(parsed as Record<string, unknown>)) lines.push(l);
  }
  if (lines.length === 0) return undefined;
  return fitBrief(lines, Buffer.byteLength(raw, 'utf8'), budgetBytes);
}

/** Fit the turn lines to the budget from the oldest end; exported for the test's fixtures. */
export function fitBrief(
  lines: string[],
  sourceBytes: number,
  budgetBytes: number,
): ContinuationBrief | undefined {
  const headerBytes = Buffer.byteLength(HEADER, 'utf8') + 1;
  let start = 0;
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
  while (start < lines.length && headerBytes + bytes > budgetBytes) {
    bytes -= Buffer.byteLength(lines[start]!, 'utf8') + 1;
    start += 1;
  }
  if (start >= lines.length) return undefined; // the budget holds not one turn: no brief
  const kept = lines.slice(start);
  const dropped = start;
  const note = dropped > 0 ? `(${dropped} earlier turn${dropped === 1 ? '' : 's'} dropped)\n` : '';
  return {
    text: `${HEADER}\n${note}${kept.join('\n')}`,
    turns: kept.length,
    dropped,
    source_bytes: sourceBytes,
    budget_bytes: budgetBytes,
  };
}

/** The `-p` line a compacted wake runs: the wake line first (it is the instruction), the brief after. */
export function composeContinuationLine(composedLine: string, brief: ContinuationBrief): string {
  return `${composedLine}\n\n${brief.text}`;
}
