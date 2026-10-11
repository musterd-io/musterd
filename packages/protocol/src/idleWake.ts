import { z } from 'zod';

/**
 * Idle-at-prompt wake (ADR 558). The daemon decides what rings (`seam=idle` on interrupt-check);
 * the adapter decides when, from evidence only the session's machine has. These are the shapes the
 * two halves share, plus the one local file the hooks and the adapter share.
 */

/** Which seam asked interrupt-check. `rail` stays the harness id (ADR 423). */
export const InterruptSeamSchema = z.enum(['boundary', 'idle']);
export type InterruptSeam = z.infer<typeof InterruptSeamSchema>;

/** Can this session be pushed while idle? `deaf` carries a reason. */
export const HearingSchema = z.enum(['idle', 'deaf']);
export type Hearing = z.infer<typeof HearingSchema>;
export const HearingReasonSchema = z.string().min(1).max(80);

/** The adapter's outcome report (`POST …/inbox/idle-wake`). Structured fields only — never the line. */
export const IdleWakeReportSchema = z
  .object({
    act: z.string().min(1).max(40),
    outcome: z.enum(['injected', 'failed', 'capped']),
    harness: z.string().min(1).max(40),
    reason: HearingReasonSchema.optional(),
    cap: z.enum(['sender', 'session']).optional(),
  })
  .strict();
export type IdleWakeReport = z.infer<typeof IdleWakeReportSchema>;

/** `.musterd/idle-wake.json` — turn markers (hook-written) and the session switch. No secrets. */
export const IdleWakeStateSchema = z.object({
  session_id: z.string().max(120).optional(),
  last_prompt_at: z.number().int().optional(),
  last_stop_at: z.number().int().optional(),
  switch: z.enum(['on', 'off']).optional(),
});
export type IdleWakeState = z.infer<typeof IdleWakeStateSchema>;

/** Transcript quiet this long, with the last turn stopped and no tool in flight, counts as idle. */
export const IDLE_QUIET_MS = 15_000;
/** Acts arriving within this window of the first ring share one inject. */
export const IDLE_COALESCE_MS = 5_000;
/** No inject within this long of the last prompt the human submitted. */
export const IDLE_KEYBOARD_GUARD_MS = 30_000;
export const IDLE_SENDER_CAP_PER_HOUR = 3;
export const IDLE_SESSION_CAP_PER_HOUR = 6;
/** An ok inject the transcript does not answer within this long flips the session deaf. */
export const IDLE_DEAF_AFTER_MS = 60_000;
