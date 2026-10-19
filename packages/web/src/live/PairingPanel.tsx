import './PairingPanel.css';
import { useCallback, useEffect, useState } from 'react';
import {
  confirmChannelPairing,
  fetchChannelPairings,
  rejectChannelPairing,
  type ChannelPairing,
  type LiveConfig,
} from './client';

/**
 * ADR 618 §7 — the /live half of the original surface for channel pairing. A staged pairing
 * appears here with the provider tenant and user **exactly as the daemon holds them** (never a
 * relay-supplied copy), and only this human's Confirm creates the binding. The panel renders
 * nothing when nothing is staged, and stays silent for agent/observer credentials — the daemon
 * refuses those, and there is nothing for them to confirm.
 */
export function PairingPanel({ cfg }: { cfg: LiveConfig }) {
  const [pairings, setPairings] = useState<ChannelPairing[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPairings(await fetchChannelPairings(cfg));
    } catch {
      // Not a human credential (agent/observer) or the daemon is unreachable: no panel.
      setPairings([]);
    }
  }, [cfg]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (pairings.length === 0) return null;

  const act = async (id: string, action: 'confirm' | 'reject') => {
    setBusy(id);
    setError(null);
    try {
      if (action === 'confirm') await confirmChannelPairing(cfg, id);
      else await rejectChannelPairing(cfg, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="pair-panel" aria-label="Channel pairing confirmation">
      <h2 className="pair-panel__title">Confirm channel pairing</h2>
      {pairings.map((p) => (
        <div className="pair-card" key={p.id}>
          <div className="pair-card__row">
            <span className="pair-card__key">Channel</span>
            <span className="pair-card__val">{p.channel}</span>
          </div>
          <div className="pair-card__row">
            <span className="pair-card__key">Tenant</span>
            <span className="pair-card__val">{p.provider_tenant_id}</span>
          </div>
          <div className="pair-card__row">
            <span className="pair-card__key">User</span>
            <span className="pair-card__val">{p.provider_user_id}</span>
          </div>
          <div className="pair-card__row">
            <span className="pair-card__key">Check code</span>
            <span className="pair-card__val">{p.check_code}</span>
          </div>
          <p className="pair-card__note">
            This binds the identity above to you. Confirm only if you just paired this channel
            and the tenant and user are yours.
          </p>
          <div className="pair-card__actions">
            <button
              className="pair-card__confirm"
              disabled={busy === p.id}
              onClick={() => void act(p.id, 'confirm')}
            >
              Confirm binding
            </button>
            <button
              className="pair-card__reject"
              disabled={busy === p.id}
              onClick={() => void act(p.id, 'reject')}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
      {error && <p className="pair-panel__error">{error}</p>}
    </section>
  );
}
