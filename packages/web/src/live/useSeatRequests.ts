import type { Request } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import { AuditFetchError, fetchRequests, type LiveConfig } from './client';

/** Seat claims wait an hour (ADR 069); a 30 s poll is well inside that and cheap. */
const POLL_MS = 30_000;

/**
 * What a read of the pending seat claims means for the briefing. `forbidden` is the ordinary answer
 * for anyone who is not an admin (ADR 077) and ends the polling; any other failure shows nothing
 * for now and tries again — a banner that invents a request is worse than one that is late.
 */
export type SeatRequestsRead =
  | { kind: 'ok'; requests: Request[] }
  | { kind: 'forbidden' }
  | { kind: 'failed' };

export function settleRequests(result: Request[] | unknown): SeatRequestsRead {
  if (Array.isArray(result)) return { kind: 'ok', requests: result as Request[] };
  if (result instanceof AuditFetchError && (result.status === 401 || result.status === 403)) {
    return { kind: 'forbidden' };
  }
  return { kind: 'failed' };
}

/**
 * The team's pending seat-claim requests, for a viewer who may see them — `[]` for everyone else.
 * Admin-only on the daemon (ADR 077), so this asks only once someone is signed in (`enabled`), and
 * stops asking after the daemon says no. The observer a stranger or the stream holds never calls it.
 */
export function useSeatRequests(cfg: LiveConfig | null, enabled: boolean): readonly Request[] {
  const [requests, setRequests] = useState<readonly Request[]>([]);
  useEffect(() => {
    if (!cfg || !enabled) {
      setRequests([]);
      return;
    }
    let alive = true;
    const tick = async () => {
      let result: Request[] | unknown;
      try {
        result = await fetchRequests(cfg, { pendingOnly: true });
      } catch (e) {
        result = e;
      }
      if (!alive) return;
      const read = settleRequests(result);
      if (read.kind === 'ok') setRequests(read.requests);
      else if (read.kind === 'forbidden') {
        setRequests([]);
        clearInterval(timer);
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cfg, enabled]);
  return requests;
}
