import { z } from 'zod';
import { HEARINGS, type Hearing } from './acts.wire.js';

/**
 * Idle-at-prompt wake (ADR 558). The daemon decides what rings (`seam=idle` on interrupt-check);
 * the adapter decides when, from evidence only the session's machine has. These are the shapes the
 * two halves share, plus the one local file the hooks and the adapter share.
 */

/** Which seam asked interrupt-check. `rail` stays the harness id (ADR 423). */
export const InterruptSeamSchema = z.enum(['boundary', 'idle']);
export type InterruptSeam = z.infer<typeof InterruptSeamSchema>;

/** Can this session be pushed while idle? `deaf` carries a reason. */
export const HearingSchema = z.enum(HEARINGS);
export { HEARINGS, type Hearing };
export const HearingReasonSchema = z.string().min(1).max(80);

/** ADR 558 §5 (increment 5): the `team_send` / `musterd send` line when a directed recipient is live and deaf. */
export function deafRecipientNotice(recipient: string, reason?: string | null): string {
  const detail = reason ? ` (${reason})` : '';
  return `${recipient} is live · deaf${detail} — lands at its next tool call or prompt`;
}

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
/** A session held busy is looked at again this often, for its pending acts, until it goes idle. */
export const IDLE_BUSY_RECHECK_MS = 15_000;
/** …and no longer than this: past it the boundary seams are the only rail for those acts. */
export const IDLE_BUSY_HOLD_MS = 10 * 60_000;

/**
 * The only line an inject may push (ADR 558): the daemon-composed interrupt line — one line of
 * printable ASCII plus the two glyphs it uses (⚡, —), bounded. Shared so every pusher (the adapter,
 * and the opencode plugin, which renders this source into its own text) checks the same shape.
 */
export const IDLE_LINE_MAX = 800;
export const IDLE_LINE_PATTERN = '^⚡ musterd \\[[a-z0-9-]+\\]: [\\x20-\\x7E—]+$';
export function isPushableLine(line: string): boolean {
  return line.length <= IDLE_LINE_MAX && new RegExp(IDLE_LINE_PATTERN).test(line);
}

/**
 * opencode (ADR 558 increment 3). Its inject is in-process only — a plugin calls `promptAsync` —
 * so the adapter and the managed plugin (ADR 392, generation ≥ 5) talk through three files in the
 * workspace's `.musterd/`, each 0600 and replaced whole (tmp + rename). None carries a secret.
 *
 * - `idle-ring.json` — adapter → plugin: push this line. `seq` is fresh per ring.
 * - `idle-ring-ack.json` — plugin → adapter: what happened to ring `seq`.
 * - `opencode-plugin.json` — plugin → adapter: the plugin is loaded, at this generation, and where
 *   its session is. Rewritten on every busy/idle change and every 30 s; stale means deaf.
 */
export const IDLE_RING_FILE = 'idle-ring.json';
export const IDLE_RING_ACK_FILE = 'idle-ring-ack.json';
export const OPENCODE_PLUGIN_STAMP_FILE = 'opencode-plugin.json';
/** The first plugin generation that watches the ring file. */
export const OPENCODE_RING_MIN_GENERATION = 5;
/** The plugin rewrites its stamp at least this often… */
export const OPENCODE_STAMP_EVERY_MS = 30_000;
/** …and the adapter calls a stamp older than this a plugin that is gone. */
export const OPENCODE_STAMP_FRESH_MS = 90_000;
/** How long the adapter waits for the plugin's ack before calling the ring failed. */
export const IDLE_RING_ACK_TIMEOUT_MS = 10_000;

export const IdleRingSchema = z.object({
  seq: z.string().min(1).max(64),
  line: z.string().min(1).max(IDLE_LINE_MAX),
  at: z.number().int(),
});
export type IdleRing = z.infer<typeof IdleRingSchema>;

export const IdleRingAckSchema = z.object({
  seq: z.string().min(1).max(64),
  ok: z.boolean(),
  reason: HearingReasonSchema.optional(),
  at: z.number().int(),
});
export type IdleRingAck = z.infer<typeof IdleRingAckSchema>;

export const OpencodePluginStampSchema = z.object({
  generation: z.number().int(),
  pid: z.number().int(),
  session_id: z.string().max(120).optional(),
  status: z.enum(['idle', 'busy']),
  at: z.number().int(),
});
export type OpencodePluginStamp = z.infer<typeof OpencodePluginStampSchema>;
