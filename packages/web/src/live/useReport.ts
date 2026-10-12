import type { Envelope, Report } from '@musterd/protocol';
import { fetchReport, type LiveConfig } from './client';
import { useLaneFed } from './useWorkingOn';

/**
 * The insight report behind the board's rail. Lane-derived at its core (flow, blocked, goal
 * status), so lane events are the honest refetch trigger — the same hook as the lane board.
 */
export function useReport(cfg: LiveConfig | null, envelopes: Envelope[]): Report | null {
  return useLaneFed(cfg, envelopes, fetchReport);
}
