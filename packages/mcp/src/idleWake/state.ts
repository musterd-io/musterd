import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IdleWakeState, IdleWakeStateSchema } from '@musterd/protocol';

/**
 * The adapter's read-only twin of the CLI's `.musterd/idle-wake.json` reader (ADR 558): the turn
 * markers the trace hook writes and this workspace's session switch. The two packages share only
 * `@musterd/protocol`, so the schema is shared and the four lines of file reading are not.
 * Fail-open: an unreadable file is "no evidence", never an error.
 */
export function readIdleWakeState(dir: string): IdleWakeState {
  try {
    const parsed = IdleWakeStateSchema.safeParse(
      JSON.parse(readFileSync(join(dir, '.musterd', 'idle-wake.json'), 'utf8')),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Markers written for a different session than the one captured here describe somebody else's
 *  turns; keep only the switch. Unknown on either side keeps everything (fail toward the guards). */
export function markersFor(state: IdleWakeState, sessionId: string | undefined): IdleWakeState {
  if (!sessionId || !state.session_id || state.session_id === sessionId) return state;
  return state.switch ? { switch: state.switch } : {};
}
