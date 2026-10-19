import './PairingPanel.css';
import { useCallback, useEffect, useState } from 'react';
import type { LiveConfig } from './client';
import {
  confirmChannelPairing,
  fetchChannelPairings,
  fetchChannelSettings,
  rejectChannelPairing,
  saveChannelSettings,
  type ChannelPairing,
  type ChannelSettings,
} from './pairingClient';

/**
 * ADR 618 §7 — the /live half of the original surface for channel pairing. A staged pairing
 * appears here with the provider tenant and user **exactly as the daemon holds them** (never a
 * relay-supplied copy), and only this human's Confirm creates the binding. The panel renders
 * nothing when nothing is staged, and stays silent for agent/observer credentials — the daemon
 * refuses those, and there is nothing for them to confirm.
 *
 * Below the confirmations sit this human's channel settings (away channels 6): per-channel
 * deliver/answer switches, presence gating, and a tier floor. Nothing is on by default.
 */
export function PairingPanel({ cfg }: { cfg: LiveConfig }) {
  const [pairings, setPairings] = useState<ChannelPairing[]>([]);
  const [settings, setSettings] = useState<ChannelSettings[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPairings(await fetchChannelPairings(cfg));
      setSettings(await fetchChannelSettings(cfg));
    } catch {
      // Not a human credential (agent/observer) or the daemon is unreachable: no panel.
      setPairings([]);
      setSettings([]);
    }
  }, [cfg]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (pairings.length === 0 && settings.length === 0) return null;

  const save = async (next: ChannelSettings) => {
    setBusy(`settings:${next.channel}`);
    setError(null);
    try {
      const saved = await saveChannelSettings(cfg, next);
      setSettings((rows) => rows.map((r) => (r.channel === saved.channel ? saved : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

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
      {settings.length > 0 && (
        <>
          <h2 className="pair-panel__title">Away channels</h2>
          {settings.map((s) => (
            <div className="pair-card" key={s.channel}>
              <div className="pair-card__row">
                <span className="pair-card__key">Channel</span>
                <span className="pair-card__val">{s.channel}</span>
              </div>
              <label className="pair-card__row">
                <span className="pair-card__key">Deliver asks here</span>
                <input
                  type="checkbox"
                  checked={s.deliver}
                  disabled={busy === `settings:${s.channel}`}
                  onChange={(e) => void save({ ...s, deliver: e.target.checked })}
                />
              </label>
              <label className="pair-card__row">
                <span className="pair-card__key">
                  Answer from here
                  {!s.deliver && s.answer ? ' — off while delivery is off' : ''}
                </span>
                <input
                  type="checkbox"
                  checked={s.answer}
                  disabled={busy === `settings:${s.channel}`}
                  onChange={(e) => void save({ ...s, answer: e.target.checked })}
                />
              </label>
              <label className="pair-card__row">
                <span className="pair-card__key">Only while I'm away</span>
                <input
                  type="checkbox"
                  checked={s.presenceGating}
                  disabled={busy === `settings:${s.channel}`}
                  onChange={(e) => void save({ ...s, presenceGating: e.target.checked })}
                />
              </label>
              <label className="pair-card__row">
                <span className="pair-card__key">Tier floor</span>
                <select
                  value={s.tierFloor ?? ''}
                  disabled={busy === `settings:${s.channel}`}
                  onChange={(e) =>
                    void save({
                      ...s,
                      tierFloor:
                        e.target.value === ''
                          ? null
                          : (e.target.value as ChannelSettings['tierFloor']),
                    })
                  }
                >
                  <option value="">any tier</option>
                  <option value="advisory">advisory and up</option>
                  <option value="standard">standard and up</option>
                  <option value="blocking">blocking only</option>
                </select>
              </label>
            </div>
          ))}
        </>
      )}
      {error && <p className="pair-panel__error">{error}</p>}
    </section>
  );
}
