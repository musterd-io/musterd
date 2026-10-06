import { z } from 'zod';

/**
 * Team memory retrieval shapes (ADR 327) — the read side of the `insight` act. The index behind
 * `GET /teams/:slug/memory/search` is a derived, rebuildable FTS fold over the message log (never a
 * source of truth, ADR 259); these schemas describe only what the wire returns.
 */

/**
 * ADR 526: where an insight stands now. `retracted` — its author (or a human) withdrew it with a
 * `resolve` on its id. `superseded_by` — later insights naming it in `meta.supersedes`; `hides` is
 * true when that insight came from the author or a human (the old one is then left out of search,
 * dreams and the digest), false when anyone else superseded it (shown, with the pointer beside it).
 */
export const InsightStatusSchema = z.object({
  retracted: z
    .object({ by: z.string().min(1), at: z.number().int(), reason: z.string() })
    .optional(),
  superseded_by: z
    .array(
      z.object({
        id: z.string().min(1),
        from: z.string().min(1),
        headline: z.string(),
        hides: z.boolean(),
      }),
    )
    .optional(),
});
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const InsightHitSchema = z.object({
  /** The insight act's envelope id — join key back to the durable log. */
  id: z.string().min(1),
  /** Seat name of the finder (resolved from `from_member` at read time). */
  from: z.string().min(1),
  headline: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  ts: z.number().int().nonnegative(),
  /** ADR 526: present only when the insight was retracted or superseded. */
  status: InsightStatusSchema.optional(),
});
export type InsightHit = z.infer<typeof InsightHitSchema>;

export const TeamMemorySearchResponseSchema = z.object({
  results: z.array(InsightHitSchema),
});
export type TeamMemorySearchResponse = z.infer<typeof TeamMemorySearchResponseSchema>;
