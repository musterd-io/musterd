import type { Hold, HoldList } from '@musterd/protocol';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from './client';

/** How often the banner re-reads the Team's holds. A hold ends by its clock, not by an event, so a
 *  poll is the honest shape; 30s is well inside the shortest sensible hold. */
const HOLDS_POLL_MS = 30_000;

export interface TeamHolds {
  holds: Hold[];
  /** ADR 516 increment 4: whether THIS viewer may set or lift — the daemon's answer (`can_set`),
   *  never derived from the viewer's role here. `false` while signed out, on a failed read, or on a
   *  daemon that predates the flag. */
  canSet: boolean;
  /** Re-read now — after a set or a lift, so the banner shows the daemon's row, not a guess. */
  refresh: () => void;
}

/**
 * ADR 516: the Team's active holds — what is paused, by whom, until when — above the room, from the
 * same `GET /holds` every other surface reads. Nothing is shown when nothing is in force, and a
 * failed read shows nothing rather than a guess: a banner that invents a freeze is the rumour this
 * exists to end.
 */
export function useTeamHolds(cfg: LiveConfig | null): TeamHolds {
  const [holds, setHolds] = useState<Hold[]>([]);
  const [canSet, setCanSet] = useState(false);
  const [tickN, setTickN] = useState(0);
  const refresh = useCallback(() => setTickN((n) => n + 1), []);
  useEffect(() => {
    if (!cfg) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await apiGet<HoldList>(cfg, `/teams/${encodeURIComponent(cfg.team)}/holds`);
        if (alive) {
          setHolds(res.holds);
          setCanSet(res.can_set === true);
        }
      } catch {
        if (alive) {
          setHolds([]);
          setCanSet(false);
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), HOLDS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cfg, tickN]);
  return { holds, canSet, refresh };
}
