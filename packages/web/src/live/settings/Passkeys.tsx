import { useCallback, useEffect, useState } from 'react';
import type { LiveConfig } from '../client';
import {
  enrollPasskey,
  enrollPasskeyForVouch,
  enrollPasskeyViaPhone,
  enrollPasskeyWithRecoveryCode,
  enrollRefusal,
  fetchMyDeviceKeys,
  revokeDeviceKey,
  signsHere,
  type DeviceKey,
  type EnrollOutcome,
  type HeldEnrollment,
} from '../passkeyEnroll';
import type { SheetNote } from '../StyleSheet';
import { askVouch, replacedPasskeys, vouchCheckCode } from '../vouch';

/** How often a held enrollment's sheet looks for the vouched key to land (ADR 769 step 4). */
const VOUCH_POLL_MS = 3_000;

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
  const [revoking, setRevoking] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [note, setNote] = useState<SheetNote>(null);
  // ADR 769: a registration held for an admin's vouch, who was asked, and the key ids that stood
  // when it was held (the vouched key is the one not among them — ids, not clocks).
  const [held, setHeld] = useState<(HeldEnrollment & { before: readonly string[] }) | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  // After a vouch lands: the keys it replaces, offered for one dismissible revoke (never automatic).
  const [replaced, setReplaced] = useState<DeviceKey[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchMyDeviceKeys(cfg);
      setKeys(fresh);
      return fresh;
    } catch {
      setKeys(null);
      return null;
    }
  }, [cfg]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ADR 769 step 4: while a registration is held, look for the vouched key. The member does not
  // click again — the key was made when the registration was held.
  useEffect(() => {
    if (!held) return;
    const host = location.hostname;
    const t = setInterval(() => {
      if (Date.now() > held.expiresAt) {
        setHeld(null);
        setAsked(null);
        setNote({ tone: 'err', text: 'the request expired before an admin vouched; nothing was enrolled — start again' });
        return;
      }
      void refresh().then((fresh) => {
        const landed = fresh?.find(
          (k) =>
            k.kind === 'passkey' &&
            k.revoked_at === null &&
            !held.before.includes(k.id) &&
            signsHere(k, host) !== false,
        );
        if (!landed || !fresh) return;
        const gone = replacedPasskeys(fresh, host);
        setHeld(null);
        setNote({
          tone: 'ok',
          text: `${asked ?? 'an admin'} vouched — your passkey is enrolled and signs from now on`,
        });
        setAsked(null);
        const old = [...gone.away, ...gone.unrecorded].filter((k) => k.id !== landed.id);
        setReplaced(old.length > 0 ? old : null);
        onEnrolled?.();
      });
    }, VOUCH_POLL_MS);
    return () => clearInterval(t);
  }, [held, asked, refresh, onEnrolled]);
  if (keys === null || !me) return null;

  const active = keys.filter((k) => k.revoked_at === null && !k.pairing_ended);
  const passkeys = active.filter((k) => k.kind === 'passkey');
  const phones = active.filter((k) => k.kind === 'phone').length;
  // ADR 808: a passkey signs only on the hostname it was made for. `null` is a key from before
  // that was recorded — it may well work here, so it is offered, not refused.
  const host = location.hostname;
  const here = passkeys.filter((k) => signsHere(k, host) !== false);
  const elsewhere = passkeys.filter((k) => signsHere(k, host) === false);
  // No key on this page can approve a further enrollment: say so instead of starting a ceremony
  // the browser can only answer with a QR code (2026-11-04).
  const noneSignHere = passkeys.length > 0 && here.length === 0;
  const elsewhereOrigins = [...new Set(elsewhere.map((k) => k.origin ?? k.rp_id ?? ''))].filter(
    Boolean,
  );

  // ADR 808 inc B: a revoke is approved by a key that signs here; with none, the control is off and
  // the line above already says why. Retiring the last passkey is allowed (ADR 662 dec. 6) but named.
  const canApproveHere = here.length > 0;
  const revoke = async (k: DeviceKey) => {
    const last = passkeys.length === 1;
    const sure = window.confirm(
      last
        ? 'This is your only passkey. Revoking it leaves your phone (if paired) as your only signer, and a new passkey will need approval. Revoke it?'
        : `Revoke the passkey from ${since(k.created_at)}? It will no longer sign for you.`,
    );
    if (!sure) return;
    setRevoking(k.id);
    setNote(null);
    try {
      await revokeDeviceKey(cfg, me, k.id);
      setNote({ tone: 'ok', text: 'passkey revoked' });
      await refresh();
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setRevoking(null);
    }
  };

  // ADR 808 inc C: with no passkey that signs here but a paired phone, the phone approves.
  const enrollViaPhone = async () => {
    setBusy(true);
    setNote(null);
    try {
      await enrollPasskeyViaPhone(cfg, me, () =>
        setNote({ tone: 'ok', text: 'sent to your phone — approve it there, then come back here' }),
      );
      setNote({ tone: 'ok', text: 'passkey enrolled — it signs your high-authority acts from now on' });
      await refresh();
      onEnrolled?.();
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  // ADR 808 inc D: no key signs anywhere and no phone — the hub's operator minted a code.
  const enrollWithCode = async () => {
    setBusy(true);
    setNote(null);
    try {
      await enrollPasskeyWithRecoveryCode(cfg, me, recoveryCode);
      setRecoveryCode('');
      setNote({ tone: 'ok', text: 'passkey enrolled — it signs your high-authority acts from now on' });
      await refresh();
      onEnrolled?.();
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  // A registration came back enrolled, or held for an admin's vouch (ADR 769).
  const settle = async (outcome: EnrollOutcome) => {
    if (outcome.kind === 'held') {
      setHeld({ ...outcome.held, before: (keys ?? []).map((k) => k.id) });
      setAsked(null);
      setNote(null);
      return;
    }
    setNote({ tone: 'ok', text: 'passkey enrolled — it signs your high-authority acts from now on' });
    await refresh();
    onEnrolled?.();
  };

  const enroll = async () => {
    setBusy(true);
    setNote(null);
    try {
      await settle(await enrollPasskey(cfg, me, active.length > 0));
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  // ADR 769: none of your keys sign here and no phone — make the passkey, and an admin vouches.
  const enrollForVouch = async () => {
    setBusy(true);
    setNote(null);
    try {
      await settle(await enrollPasskeyForVouch(cfg, me));
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  const ask = async (admin: string) => {
    if (!held) return;
    setBusy(true);
    setNote(null);
    try {
      await askVouch(cfg, admin, me, held.digest);
      setAsked(admin);
    } catch (e) {
      setNote({ tone: 'err', text: enrollRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  // After the vouch: revoke the keys it replaces, signed by the new key. One action, the member's.
  const revokeReplaced = async () => {
    if (!replaced) return;
    setBusy(true);
    setNote(null);
    try {
      for (const k of replaced) await revokeDeviceKey(cfg, me, k.id);
      setReplaced(null);
      setNote({ tone: 'ok', text: replaced.length === 1 ? 'old passkey revoked' : 'old passkeys revoked' });
      await refresh();
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
          {passkeys.map((k) => {
            const signs = signsHere(k, host);
            return (
              <li
                key={k.id}
                className={`lc-keys__key${signs === false ? ' lc-keys__key--away' : ''}`}
              >
                <span className="lc-pair__tick" aria-hidden="true">
                  {signs === false ? '–' : '✓'}
                </span>
                <span>
                  Passkey <span className="lc-set__hint">since {since(k.created_at)}</span>
                  {signs === false && (
                    <span className="lc-set__hint">
                      {' '}
                      · made on {k.origin ?? k.rp_id}; cannot sign here
                    </span>
                  )}
                  {signs === null && (
                    <span className="lc-set__hint"> · made before its origin was recorded</span>
                  )}
                </span>
                <button
                  type="button"
                  className="lc-set__btn lc-keys__revoke"
                  disabled={busy || revoking !== null || !canApproveHere}
                  aria-label={`Revoke the passkey from ${since(k.created_at)}`}
                  onClick={() => void revoke(k)}
                >
                  {revoking === k.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {phones > 0 && (
        <p className="lc-set__hint">
          {phones === 1 ? 'Your paired phone also signs.' : `Your ${phones} paired phones also sign.`}
        </p>
      )}
      {noneSignHere && (
        <p className="lc-set__hint" role="status">
          None of your passkeys can sign on {host}
          {elsewhereOrigins.length > 0 ? ` — they were made on ${elsewhereOrigins.join(', ')}` : ''}
          . A new one here needs approval from a passkey that works
          {elsewhereOrigins.length > 0 ? ' on that origin' : ' elsewhere'}
          {phones > 0 ? ' or from your paired phone' : ''}; open musterd there to add one.
        </p>
      )}
      {held && (
        <HeldPanel
          held={held}
          asked={asked}
          busy={busy}
          replaced={replacedPasskeys(keys, host)}
          onAsk={(admin) => void ask(admin)}
        />
      )}
      {replaced && !held && (
        <div className="lc-keys__vouch" role="group" aria-label="Passkeys this one replaces">
          <p className="lc-set__hint">
            {replaced.length === 1
              ? 'Your old passkey does not sign here.'
              : `Your ${replaced.length} old passkeys do not sign here.`}{' '}
            Revoke {replaced.length === 1 ? 'it' : 'them'} now, or keep{' '}
            {replaced.length === 1 ? 'it' : 'them'} in case that address comes back. Revoking cannot
            be undone.
          </p>
          <div className="lc-keys__vouchact">
            <button
              type="button"
              className="lc-set__btn"
              disabled={busy}
              onClick={() => void revokeReplaced()}
            >
              {busy ? 'Revoking…' : 'Revoke these'}
            </button>
            <button
              type="button"
              className="lc-set__btn"
              disabled={busy}
              onClick={() => setReplaced(null)}
            >
              Keep them
            </button>
          </div>
        </div>
      )}
      {noneSignHere && phones === 0 && !held && (
        <button
          type="button"
          className="lc-set__btn lc-set__btn--go"
          disabled={busy}
          onClick={() => void enrollForVouch()}
        >
          {busy ? 'Waiting for your passkey…' : 'Add a passkey here, vouched for by an admin'}
        </button>
      )}
      {((noneSignHere && phones === 0) || (held && held.countersigners.length === 0)) && (
        <form
          className="lc-keys__recover"
          onSubmit={(e) => {
            e.preventDefault();
            void enrollWithCode();
          }}
        >
          <label className="lc-set__hint" htmlFor="lc-keys-recovery">
            I have a recovery code from the hub operator
          </label>
          <input
            id="lc-keys-recovery"
            className="lc-set__input"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="paste the code"
            disabled={busy}
          />
          <button
            type="submit"
            className="lc-set__btn lc-set__btn--go"
            disabled={busy || recoveryCode.trim().length < 16}
          >
            {busy ? 'Waiting for your passkey…' : 'Enroll a passkey with this code'}
          </button>
        </form>
      )}
      {noneSignHere && phones > 0 && (
        <button
          type="button"
          className="lc-set__btn lc-set__btn--go"
          disabled={busy}
          onClick={() => void enrollViaPhone()}
        >
          {busy ? 'Waiting for your phone…' : 'Add a passkey here, approved on your phone'}
        </button>
      )}
      <button
        type="button"
        className={`lc-set__btn${passkeys.length === 0 ? ' lc-set__btn--go' : ''}`}
        disabled={busy || noneSignHere || held !== null}
        onClick={() => void enroll()}
      >
        {busy
          ? 'Waiting for your passkey…'
          : passkeys.length === 0
            ? 'Enroll a passkey'
            : 'Add a passkey on this device'}
      </button>
      {active.length > 0 && !busy && !noneSignHere && (
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

/**
 * ADR 769 steps 2–3, the member's side: the check code to read the admin, the passkeys the new one
 * replaces (read-only here), and the admins whose vouch could be signed. With nobody to ask, the
 * recovery-code form below takes over instead of a dead end.
 */
function HeldPanel({
  held,
  asked,
  busy,
  replaced,
  onAsk,
}: {
  held: HeldEnrollment;
  asked: string | null;
  busy: boolean;
  replaced: { away: DeviceKey[]; unrecorded: DeviceKey[] };
  onAsk: (admin: string) => void;
}) {
  const code = vouchCheckCode(held.digest);
  const old = [...replaced.away, ...replaced.unrecorded];
  const origins = [...new Set(replaced.away.map((k) => k.origin ?? k.rp_id ?? ''))].filter(Boolean);
  return (
    <div className="lc-keys__vouch" role="group" aria-labelledby="lc-keys-vouch-h">
      <p id="lc-keys-vouch-h" className="lc-set__lede">
        An admin must vouch for this passkey. Read them this code on a call or in person:
      </p>
      <p className="lc-keys__code" aria-label={`check code ${code.split('').join(' ')}`}>
        {code}
      </p>
      {old.length > 0 && (
        <p className="lc-set__hint">
          {old.length === 1 ? 'Your passkey' : `Your ${old.length} passkeys`}
          {origins.length > 0 ? ` from ${origins.join(', ')}` : ''} {old.length === 1 ? "doesn't" : "don't"}{' '}
          sign here. This new one will.{' '}
          {old.map((k) => `since ${since(k.created_at)}${signsHere(k, location.hostname) === null ? ' (made before origins were recorded)' : ''}`).join(' · ')}
        </p>
      )}
      {held.countersigners.length === 0 ? (
        <p className="lc-set__hint" role="status">
          Nobody on the team can vouch for you here. Ask whoever runs the hub machine for a recovery
          code, and enter it below.
        </p>
      ) : asked ? (
        <p className="lc-set__hint" role="status" aria-live="polite">
          Asked {asked}. Once they have typed your code and vouched, your passkey appears here.
        </p>
      ) : (
        <div className="lc-keys__vouchact" role="group" aria-label="Ask an admin to vouch">
          {held.countersigners.map((admin) => (
            <button
              key={admin}
              type="button"
              className="lc-set__btn lc-set__btn--go"
              disabled={busy}
              onClick={() => onAsk(admin)}
            >
              Ask {admin}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
