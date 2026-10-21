import { useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from './client';
import { LIVE_POLL_MS, readLiveSamples, type LiveSampleWire } from './experimentReads';

/**
 * ADR 701: today's live point for each metric lane, polled from `GET …/experiments/live` every
 * {@link LIVE_POLL_MS} while there is a chart to move. The board refetches only when a lane changes,
 * and a dispute or a wake usually changes none, so the chart needs its own light read.
 *
 * Stops when unseen (web AGENTS.md: idle cost is paid by every viewer): no poll while the tab is
 * hidden, one read on its return. A failed read keeps the last points.
 */
export function useLiveSamples(cfg: LiveConfig | null, enabled: boolean): LiveSampleWire[] {
  const [samples, setSamples] = useState<LiveSampleWire[]>([]);
  useEffect(() => {
    if (!cfg || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = () => {
      apiGet<unknown>(cfg, `/teams/${encodeURIComponent(cfg.team)}/experiments/live`).then(
        (json) => !cancelled && setSamples(readLiveSamples(json)),
        () => {
          /* keep the last points */
        },
      );
    };
    const start = () => {
      if (timer !== null || document.hidden) return;
      read();
      timer = setInterval(read, LIVE_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cfg, enabled]);
  return samples;
}
