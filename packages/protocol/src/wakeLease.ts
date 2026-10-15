import { z } from 'zod';

/**
 * The wake-lease FILE — a second channel for the ADR 241 correlation token, for harnesses that do
 * not let the first one through (ADR 354).
 *
 * The actuator hands a woken child two facts in its environment: `MUSTERD_PROVENANCE=wake` and
 * `MUSTERD_WAKE_LEASE=<id>`. Every process the child spawns inherits them — hooks, one-shot CLI
 * commands, and on Claude Code the MCP adapter too, which is how a woken session's presence row
 * comes to carry the lease that ADR 241 verifies against. Codex does not forward its environment to
 * the MCP servers it launches: measured 2026-09-02 on codex-cli 0.150.1, a stdio server starts with
 * twelve variables (HOME, PATH, USER, SHELL, TMPDIR, LANG, LOGNAME, TERM and four more), none of them
 * `MUSTERD_*`. On that harness the adapter attested `provenance: session` and no lease, the actuator
 * read the seat as held by another session, and killed the review it had spawned ninety seconds
 * earlier. Every codex wake from 2026-08-27 to 2026-09-02 ended that way.
 *
 * So the actuator ALSO writes this file beside `binding.json` at spawn, and the adapter reads it —
 * under two conditions that keep it an attestation rather than a default (ADR 236):
 *
 *  1. only when the environment is silent on BOTH provenance and lease — env always wins, so the
 *     harnesses that forward it behave exactly as before;
 *  2. only when `spawner_pid` is the adapter's own parent process — the codex the actuator spawned.
 *     A human session opened in the same workspace during the wake window has a different parent
 *     and reads nothing, which is the whole reason the pid is in the file.
 *
 * `expires_at` bounds the file's life to the work order; the actuator clears it when the run
 * settles, and a stale file past its expiry is ignored even if it survives a crash.
 */
export const WAKE_LEASE_FILE = 'wake-lease.json';

export const WakeLeaseFileSchema = z.object({
  /** The daemon-minted lease id (ADR 241) — opaque, never a session id or a token. */
  lease_id: z.string().min(1).max(64),
  /** The provenance this lease confers: `dream` when the wake order's derivation is `dream`
   *  (ADR 494/604 — was `z.literal('wake')`, which stamped every dream wake a lie), else `wake`.
   *  The server settles Presence from its own lease record regardless; this is the take-over
   *  handle's honesty, and old readers fail closed on `dream` (ADR 604 Consequences). */
  provenance: z.enum(['wake', 'dream']),
  /** Which backend wrote it — for the audit, and so a mismatched harness can refuse it. */
  harness: z.string().min(1).max(32),
  /** The pid the adapter's ancestry must include: the harness process the actuator spawned — or,
   *  on OpenCode, the persistent `opencode serve` daemon the spawned run delegates to, since the
   *  adapter is serve's child, never the run's (ADR 613). */
  spawner_pid: z.number().int().positive(),
  started_at: z.number().int().nonnegative(),
  /** Past this the file is dead even if nothing cleared it. */
  expires_at: z.number().int().nonnegative(),
  /** The conversation id the host gave the harness (`--session-id` / `--resume`), so a person can
   *  take the wake over in that conversation (ADR 546). Local only — never sent to the daemon.
   *  Absent from older hosts: take over then falls back to the plain live-seat question. */
  session_id: z.string().min(1).max(128).optional(),
  /** True when the wake is a loop running INSIDE the host process (the native harness), so
   *  `spawner_pid` is the host's own pid: a launcher must never signal it, and the adapter must not
   *  honour the file (it names no child to attest). The yield marker is how such a wake is stopped
   *  (ADR 546, lane 6/6). */
  in_process: z.boolean().optional(),
});
export type WakeLeaseFile = z.infer<typeof WakeLeaseFileSchema>;

/** The marker a launcher writes to ask the wake holding `lease_id` to stop (ADR 546). `musterd gate`
 *  denies that wake's next tool call while it exists; the host removes it when the run settles. */
export const WAKE_YIELD_FILE = 'wake-yield.json';
export const WakeYieldFileSchema = z.object({
  lease_id: z.string().min(1).max(64),
  /** The person taking over, for the deny line and the audit. */
  by: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
});
export type WakeYieldFile = z.infer<typeof WakeYieldFileSchema>;
