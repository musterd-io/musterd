import { useCallback, useEffect, useState } from 'react';
import type { LiveConfig } from './client';
import type { ChannelPairing } from './pairingClient';

/** How often a signed-in human's staged pairings are re-read. A pairing is staged from another
 *  device and confirmed here, so a slow poll is enough to light the calendar's dot. */
const POLL_MS = 30_000;

/**
 * The channel pairings staged for this human (ADR 618 §7) — what lights the dot on the office's
 * settings calendar and fills the You sheet's "Waiting for you". Only read for a signed-in human:
 * the daemon refuses agent and observer credentials, and a refusal reads as "nothing staged".
 */
export function usePendingPairings(
  cfg: LiveConfig | null,
  human: boolean,
): { pairings: ChannelPairing[]; refresh: () => void } {
  const [pairings, setPairings] = useState<ChannelPairing[]>([]);
  const refresh = useCallback(() => {
    if (!cfg || !human) {
      setPairings([]);
      return;
    }
    // The client is imported on first use, not with the route: /live's eager graph pays nothing
    // for a read only a signed-in human makes (ADR 151).
    import('./pairingClient')
      .then((m) => m.fetchChannelPairings(cfg))
      .then(setPairings, () => setPairings([]));
  }, [cfg, human]);
  useEffect(() => {
    refresh();
    if (!cfg || !human) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [cfg, human, refresh]);
  return { pairings, refresh };
}
