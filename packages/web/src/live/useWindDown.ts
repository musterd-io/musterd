import { useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from './client';
import { nextRedrawMs } from './windDown';

/** How often the card asks the daemon whether a stop is queued — slow, so a cancel still lands
 * within a minute without the stream polling hard for a card that is almost never up. */
const POLL_MS = 60_000;

/**
 * The queued stop's deadline plus a clock that ticks only as often as the sentence changes
 * (lane 01M5GDACC0). Returns `[stopAt, now]`; both null-safe, and no timer runs when nothing is
 * queued beyond the slow poll.
 */
export function useWindDown(cfg: LiveConfig | null): [number | null, number] {
  const [stopAt, setStopAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!cfg) return;
    let alive = true;
    const read = () =>
      apiGet<{ stop_at?: number | null }>(cfg, `/teams/${encodeURIComponent(cfg.team)}/stream/winddown`)
        .then((r) => alive && setStopAt(typeof r.stop_at === 'number' ? r.stop_at : null))
        // An unreachable daemon is not a reason to put a card up or take one down.
        .catch(() => {});
    void read();
    const id = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cfg]);

  useEffect(() => {
    setNow(Date.now());
    if (stopAt === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t < stopAt) timer = setTimeout(tick, nextRedrawMs(stopAt, t));
    };
    timer = setTimeout(tick, nextRedrawMs(stopAt, Date.now()));
    return () => clearTimeout(timer);
  }, [stopAt]);

  return [stopAt, now];
}
