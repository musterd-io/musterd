import type { Hold, HoldList } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from './client';

/** How often the banner re-reads the Team's holds. A hold ends by its clock, not by an event, so a
 *  poll is the honest shape; 30s is well inside the shortest sensible hold. */
const HOLDS_POLL_MS = 30_000;

/**
 * ADR 516: the Team's active holds — what is paused, by whom, until when — above the room, from the
 * same `GET /holds` every other surface reads. Nothing is shown when nothing is in force, and a
 * failed read shows nothing rather than a guess: a banner that invents a freeze is the rumour this
 * exists to end.
 */
export function useTeamHolds(cfg: LiveConfig | null): Hold[] {
  const [holds, setHolds] = useState<Hold[]>([]);
  useEffect(() => {
    if (!cfg) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await apiGet<HoldList>(cfg, `/teams/${encodeURIComponent(cfg.team)}/holds`);
        if (alive) setHolds(res.holds);
      } catch {
        if (alive) setHolds([]);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), HOLDS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cfg]);
  return holds;
}
