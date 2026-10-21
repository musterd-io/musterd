import type { Envelope, LaneBoard } from '@musterd/protocol';
import { isAwaitingAcceptance } from '@musterd/protocol/wire';
import { useEffect, useRef, useState } from 'react';
import type { LiveConfig } from './client';

/**
 * The review asks a fresh load's backfill window missed, fetched by date (lane 01M5G10DB2 — the rule
 * is in `recoverAsks.ts`, loaded only when the board shows a lane that may need it, so a viewer with
 * no such lane pays nothing beyond this hook). Held apart from the stream's 1,000-envelope cap, so a
 * long-open tab cannot age them back out. Each lane is tried once per connection.
 */
export function useRecoveredAsks(
  cfg: LiveConfig | null,
  board: LaneBoard | null,
  envelopes: Envelope[],
  humans: Set<string>,
  ready: boolean,
): Envelope[] {
  const [recovered, setRecovered] = useState<Envelope[]>([]);
  const tried = useRef(new Set<string>());
  // The connection a fetch began on. A board refresh mid-fetch keeps its result (the lane is already
  // marked tried); a new connection drops it.
  const gen = useRef(0);
  // Read at fetch time, not a dependency: every arrival would otherwise re-run the effect.
  const held = useRef(envelopes);
  useEffect(() => {
    held.current = envelopes;
  }, [envelopes]);

  useEffect(() => {
    gen.current += 1;
    tried.current = new Set();
    setRecovered([]);
  }, [cfg]);

  useEffect(() => {
    if (!cfg || !board || !ready) return;
    const maybe = board.lanes.some(
      (l) =>
        isAwaitingAcceptance(l.state) &&
        (l.acceptance_reviewer === undefined || humans.has(l.acceptance_reviewer)) &&
        !tried.current.has(l.id),
    );
    if (!maybe) return;
    const at = gen.current;
    import('./recoverAsks')
      .then(async (m) => {
        const ids = m.lanesMissingReviewAsk(board.lanes, held.current, humans).filter((id) => !tried.current.has(id));
        for (const id of ids) tried.current.add(id);
        const found = (await Promise.all(ids.map((id) => m.recoverReviewAsks(cfg, id).catch(() => [])))).flat();
        if (gen.current === at && found.length > 0) setRecovered((prev) => [...prev, ...found]);
      })
      .catch(() => {
        /* ambient: a failed recovery leaves the rail as the window drew it */
      });
  }, [cfg, board, humans, ready]);

  return recovered;
}
