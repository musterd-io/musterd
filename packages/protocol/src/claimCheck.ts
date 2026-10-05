import { z } from 'zod';

/**
 * Stored claims are checked on read (ADR 522). When a seat reads a stored note — its own memory, a
 * handoff it was given, an insight in a dream packet — the daemon finds what the note talks about
 * (a lane id, a hold id, a Team-rule phrase like "don't merge" or "freeze") and states, next to it,
 * what is true NOW. The verdict is conclusive by design: a seat that is told "this may be stale,
 * check" goes and checks, and five seats checking the same thing is the waste this exists to end.
 *
 * Only what changes how the note should be read is reported: a lane that has ended, a hold's
 * current state, and whether a Team rule is backed by an active hold. A live lane the note mentions
 * says nothing — it is as the note left it.
 */

export const CLAIM_CHECK_SOURCES = ['memory', 'handoff', 'insight'] as const;
export const CLAIM_CHECK_KINDS = ['lane', 'hold', 'rule'] as const;
/**
 * `current` — in force or live, as the note says; `ended` — the lane closed or parked, or the hold
 * lifted or expired; `unsourced` — a Team rule no active hold backs.
 */
export const CLAIM_CHECK_VERDICTS = ['current', 'ended', 'unsourced'] as const;

export const ClaimCheckSchema = z
  .object({
    kind: z.enum(CLAIM_CHECK_KINDS),
    /** The lane id, the hold id, or (for a rule) the phrase as the note wrote it, clipped. */
    ref: z.string().min(1).max(160),
    verdict: z.enum(CLAIM_CHECK_VERDICTS),
    /** The one sentence a seat acts on — names the fact and what follows from it. */
    line: z.string().min(1).max(400),
  })
  .strict();
export type ClaimCheck = z.infer<typeof ClaimCheckSchema>;
export type ClaimCheckSource = (typeof CLAIM_CHECK_SOURCES)[number];

/** At most this many checks per note — the checks are a margin note, not a second copy of it. */
export const CLAIM_CHECKS_MAX = 6;

/** One line per check for a text renderer: `⚠ …` for anything that changes the reading. */
export function claimCheckLines(checks: readonly ClaimCheck[]): string[] {
  return checks.map((c) => `${c.verdict === 'current' ? '✓' : '⚠'} ${c.line}`);
}
