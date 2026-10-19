/**
 * The board query grammar (ADR 582 §1) — one string, space-separated terms, all of which must match.
 *
 * A seat asks the board the questions it used to answer by reading the database:
 * `lane_board {q:"area:ui goal:launch state:open"}`, `{q:"sync"}`, `{q:"path:packages/web"}`.
 *
 * The grammar is parsed here, at the boundary, so both the daemon and the MCP tools read one
 * definition (AGENTS.md hard rule 4). Matching lives on the server, where the board's rows are:
 * this module decides what a query *says*, never what it *matches*.
 */
import { z } from 'zod';

/**
 * The one argument a board query arrives in (ADR 582 §1). Trimmed, non-empty and bounded: a query
 * is a phrase a seat types, not a payload.
 */
export const BoardQuerySchema = z.string().trim().min(1).max(200);

/** The keys a **lane** query understands. An unknown key is a 400, never a silent text search. */
export const LANE_QUERY_KEYS = [
  'goal',
  'area',
  'owner',
  'state',
  'role',
  'risk',
  'project',
  'path',
] as const;

/** The keys a **goal** query understands. A Goal has no surface, so no `path:` and no `area:`. */
export const GOAL_QUERY_KEYS = ['status'] as const;

export type LaneQueryKey = (typeof LANE_QUERY_KEYS)[number];
export type GoalQueryKey = (typeof GOAL_QUERY_KEYS)[number];

/** One term of a parsed query. */
export interface BoardQueryTerm {
  /** The field this term names, or null for a bare word. */
  key: string | null;
  /** The term's text. For a keyed term, the part after the colon. */
  value: string;
  /** A quoted term is one phrase; an unquoted one is one word. */
  phrase: boolean;
}

/** One token of the raw query, with the flag that says whether a quote was closed around it. */
interface RawToken {
  text: string;
  quoted: boolean;
}

/**
 * Split a query into tokens on whitespace, keeping a quoted run together. The quotes are dropped
 * and remembered, so `"two words"` is one phrase and `two words` is two terms.
 */
function tokenize(q: string): RawToken[] {
  const out: RawToken[] = [];
  let cur = '';
  let quoted = false;
  let quote: string | null = null;
  const flush = (): void => {
    if (cur !== '') {
      out.push({ text: cur, quoted });
      cur = '';
      quoted = false;
    }
  };
  for (const ch of q) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/**
 * Parse a query into its terms. `key:value` is a field term; anything else is a bare word.
 *
 * The key is only recognised when it looks like one (letters, digits, `_`, `-`), so a bare word
 * that happens to contain a colon — a path, a URL — stays a bare word instead of becoming a field
 * that happens to be unknown. Whether a recognised key is *known* is the caller's question: the
 * allowed keys differ between lanes and Goals.
 */
export function parseBoardQuery(q: string): BoardQueryTerm[] {
  const terms: BoardQueryTerm[] = [];
  for (const token of tokenize(q)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(token.text);
    const key = m?.[1];
    if (key !== undefined) {
      terms.push({ key: key.toLowerCase(), value: (m?.[2] ?? '').trim(), phrase: token.quoted });
      continue;
    }
    terms.push({ key: null, value: token.text, phrase: token.quoted });
  }
  return terms;
}

/**
 * The first key in `terms` that is not in `allowed`, or null when every key is known. The caller
 * answers 400 with the known keys — a query must never quietly become a text search the seat did
 * not mean.
 */
export function unknownQueryKey(
  terms: readonly BoardQueryTerm[],
  allowed: readonly string[],
): string | null {
  for (const t of terms) {
    if (t.key !== null && !allowed.includes(t.key)) return t.key;
  }
  return null;
}

/** A keyed term with no value (`goal:`) — the query says which field but not what. */
export function emptyValuedKey(terms: readonly BoardQueryTerm[]): string | null {
  for (const t of terms) {
    if (t.key !== null && t.value === '') return t.key;
  }
  return null;
}
