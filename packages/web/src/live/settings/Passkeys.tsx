import { useCallback, useEffect, useState } from 'react';
import type { LiveConfig } from '../client';
import { enrollPasskey, enrollRefusal, fetchMyDeviceKeys, type DeviceKey } from '../passkeyEnroll';
import type { SheetNote } from '../StyleSheet';

/**
 * Your passkeys (ADR 767): what signs this human's high-authority acts — a verdict, a policy write,
 * a phone's pairing — and the enrollment ceremony, run here instead of `musterd authority enroll`.
 * Phone keys are counted but enrolled by pairing, not here.
 */

const since = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function Passkeys({
  cfg,
  me,
  onEnrolled,
}: {
  cfg: LiveConfig;
  me: string | null;
  onEnrolled?: () => void;
}) {
  const [keys, setKeys] = useState<DeviceKey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const refresh = useCallback(async () => {
    try {
      setKeys(await fetchMyDeviceKeys(cfg));
    } catch {
      setKeys(null);
    }
  }, [cfg]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (keys === null || !me) return null;

  const active = keys.filter((k) => k.revoked_at === null);
  const passkeys = active.filter((k) => k.kind === 'passkey');
  const phones = active.filter((k) => k.kind === 'phone').length;

  const enroll = async () => {
    setBusy(true);
    setNote(null);
    try {
      await enrollPasskey(cfg, me, active.length > 0);
      setNote({ tone: 'ok', text: 'passkey enrolled — it signs your high-authority acts from now on' });
      await refresh();
      onEnrolled?.();
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lc-set__group lc-keys" aria-labelledby="lc-set-keys">
      <h3 id="lc-set-keys" className="lc-set__h">
        Your passkeys
      </h3>
      {passkeys.length === 0 ? (
        <p className="lc-set__lede">
          A passkey is how you approve the things only you should: accepting work, team settings,
          a new phone. It stays on this device and asks for your face or fingerprint.
        </p>
      ) : (
        <ul className="lc-keys__list">
          {passkeys.map((k) => (
            <li key={k.id} className="lc-keys__key">
              <span className="lc-pair__tick" aria-hidden="true">
                ✓
              </span>
              <span>
                Passkey <span className="lc-set__hint">since {since(k.created_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {phones > 0 && (
        <p className="lc-set__hint">
          {phones === 1 ? 'Your paired phone also signs.' : `Your ${phones} paired phones also sign.`}
        </p>
      )}
      <button
        type="button"
        className={`lc-set__btn${passkeys.length === 0 ? ' lc-set__btn--go' : ''}`}
        disabled={busy}
        onClick={() => void enroll()}
      >
        {busy
          ? 'Waiting for your passkey…'
          : passkeys.length === 0
            ? 'Enroll a passkey'
            : 'Add a passkey on this device'}
      </button>
      {active.length > 0 && !busy && (
        <p className="lc-set__hint">
          A new passkey is approved by one you already have, so you’ll be asked twice.
        </p>
      )}
      <p
        className={`lc-set__note${note ? ` lc-set__note--${note.tone}` : ''}`}
        role="status"
        aria-live="polite"
      >
        {note?.text ?? ''}
      </p>
    </section>
  );
}
