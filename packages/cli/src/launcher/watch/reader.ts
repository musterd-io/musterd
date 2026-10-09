import type { LocalWake } from '../live.js';
import type { WatchEvent } from './events.js';

/** Everything a wake has said and done so far, and whether it has finished its work. */
export interface WatchSnapshot {
  events: WatchEvent[];
  /** True when the transcript ends the way a finished run ends (Claude Code: `end_turn`). */
  endedCleanly: boolean;
}

/**
 * One per harness (ADR 546): find that harness's record of the wake from the lease's `session_id`,
 * and turn it into {@link WatchEvent}s — through `textEvent` / `toolEvent`, never by hand, so the
 * rules about what watch may show hold for every harness. Null means there is no transcript to read
 * (yet): the watch view says so and leaves. Called on every poll, so a reader keeps what it has already
 * read (a store it cannot re-scan cheaply) and may answer asynchronously.
 */
export interface WatchReader {
  snapshot(wake: LocalWake): WatchSnapshot | null | Promise<WatchSnapshot | null>;
}
