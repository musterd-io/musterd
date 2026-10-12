import type { Envelope, LaneBoard } from '@musterd/protocol';
import { useEffect, useRef, useState } from 'react';
import { fetchLaneBoard, type LiveConfig } from './client';
import { lanesChangedSince } from './workingOn';

/**
 * Something /live and /board read from the daemon that changes only when a lane does — the lane
 * board, the insight report. One hook for both: they were the same code twice (2026-10-12, lane
 * 01M4RM16N0, folded to buy back /live's initial-JS margin, which stood at 4 bytes).
 *
 * **No polling.** One fetch when the connection comes up, then a re-fetch only when a lane act
 * arrives on the firehose we are already subscribed to. Lane changes are rare and self-announcing, so
 * idle cost is effectively zero — the ADR 151 contract every /live viewer pays into forever.
 *
 * A failed fetch keeps the previous value (a stale strap beats a flashing one) and is otherwise
 * silent: this is ambient chrome, never an error surface. On a stream there is nobody to tell.
 *
 * `fetcher` must be stable (a module-level function), or every render refetches.
 */
export function useLaneFed<T>(
  cfg: LiveConfig | null,
  envelopes: Envelope[],
  fetcher: (cfg: LiveConfig) => Promise<T>,
): T | null {
  const [value, setValue] = useState<T | null>(null);
  // The newest envelope we have already reacted to — so a re-render never re-fetches.
  const seenRef = useRef<string | null>(null);
  // Bumped to ask for a fetch; the mount and every lane change both go through it.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!cfg) {
      setValue(null);
      return;
    }
    let cancelled = false;
    fetcher(cfg).then(
      (next) => !cancelled && setValue(next),
      () => {
        /* keep the previous value */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cfg, fetcher, tick]);

  useEffect(() => {
    // `envelopes` is sorted oldest-first by useLiveStream, so the newest arrival is the last element.
    // Every arrival since the last look is checked, not just that one (lanesChangedSince).
    const latest = envelopes[envelopes.length - 1];
    if (!cfg || !latest || latest.id === seenRef.current) return;
    const changed = lanesChangedSince(envelopes, seenRef.current);
    seenRef.current = latest.id;
    if (changed) setTick((t) => t + 1);
  }, [cfg, envelopes]);

  return value;
}

/** The lane board behind the overlay's working-on strap. */
export function useWorkingOn(cfg: LiveConfig | null, envelopes: Envelope[]): LaneBoard | null {
  return useLaneFed(cfg, envelopes, fetchLaneBoard);
}
