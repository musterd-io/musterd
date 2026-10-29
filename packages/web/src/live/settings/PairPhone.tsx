import { useCallback, useEffect, useRef, useState } from 'react';
import { authorityProofForPhone } from '../authorityProof';
import type { LiveConfig } from '../client';
import {
  bindingDeviceName,
  confirmChannelPairing,
  fetchChannelBindings,
  fetchChannelPairings,
  rejectChannelPairing,
  revokeChannelBinding,
  startAppPairing,
  type AppPairingStart,
  type ChannelBinding,
  type ChannelPairing,
} from '../pairingClient';
import type { SheetNote } from '../StyleSheet';

/**
 * Pair a phone from /live (lane 01M64DSBQV): the QR `musterd channels pair --channel app` printed in
 * the terminal, drawn here, and the passkey confirm `musterd channels confirm` collected, run in this
 * browser. Nothing in it needs a terminal. The phone's sealed request arrives as a staged pairing; this
 * polls for it while the code is on screen, then shows the phone's key for the human to approve.
 *
 * `uqr` loads only when the human asks for a code (ADR 761), so the settings sheet pays nothing for it.
 */

type Stage =
  | { kind: 'idle' }
  | { kind: 'code'; start: AppPairingStart; svg: string }
  | { kind: 'phone'; pairing: ChannelPairing }
  | { kind: 'paired'; device: string };

const POLL_MS = 2_000;

/** The QR as one SVG path: dark modules on a white field, the standard four-module quiet zone. */
export async function qrSvg(text: string): Promise<string> {
  const { encode } = await import('uqr');
  const { data } = encode(text, { ecc: 'L', border: 4 });
  const n = data.length;
  let d = '';
  for (let y = 0; y < n; y++) {
    const row = data[y]!;
    for (let x = 0; x < n; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}

/** "Paired with iPhone · since 29 Oct" — the active app binding, as the panel names it. */
export function pairedLine(b: ChannelBinding, now: number = Date.now()): { device: string; since: string } {
  const at = new Date(b.created_at);
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  return {
    device: bindingDeviceName(b) ?? 'your phone',
    since: at.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    }),
  };
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PairPhone({
  cfg,
  me,
  waiting,
  onChanged,
}: {
  cfg: LiveConfig;
  me: string | null;
  /** App pairings already staged — one started from the CLI is confirmed here too. */
  waiting: ChannelPairing[];
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // The phone already paired (from here or the CLI), so the panel can say so instead of offering
  // a pairing nobody needs (lane 01M64M4PY5).
  const [paired, setPaired] = useState<ChannelBinding | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const loadPaired = useCallback(async () => {
    try {
      const bs = await fetchChannelBindings(cfg);
      if (mounted.current) setPaired(bs.find((b) => b.channel === 'app' && b.status === 'active') ?? null);
    } catch {
      // An older daemon or a blip: the panel still offers pairing.
    }
  }, [cfg]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const [now, setNow] = useState(() => Date.now());
  const pairingId = stage.kind === 'code' ? stage.start.pairing_id : null;
  useEffect(() => {
    void loadPaired();
  }, [loadPaired]);

  // A phone that sent its request before this panel opened (or from a CLI-started code).
  const staged = waiting.find((p) => p.app);
  useEffect(() => {
    if (staged && (stage.kind === 'idle' || stage.kind === 'code')) {
      setStage({ kind: 'phone', pairing: staged });
    }
  }, [staged, stage.kind]);

  const newCode = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const start = await startAppPairing(cfg);
      const svg = await qrSvg(JSON.stringify(start.qr));
      if (mounted.current) setStage({ kind: 'code', start, svg });
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  }, [cfg]);

  // While the code is up: tick the countdown, refresh it on expiry, and watch for the phone.
  useEffect(() => {
    if (stage.kind !== 'code') return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const poll = setInterval(() => {
      void fetchChannelPairings(cfg)
        .then((ps) => {
          const hit = ps.find((p) => p.id === pairingId && p.app);
          if (hit && mounted.current) setStage({ kind: 'phone', pairing: hit });
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [cfg, stage.kind, pairingId]);
  useEffect(() => {
    if (stage.kind === 'code' && now >= stage.start.expires_at && !busy) void newCode();
  }, [stage, now, busy, newCode]);

  const confirm = async (p: ChannelPairing) => {
    if (!me || !p.app) return;
    setBusy(true);
    setNote(null);
    try {
      const approval = await authorityProofForPhone(cfg, me, p.app.enroll_payload);
      if (!approval) {
        throw new Error(
          'confirming a phone needs a passkey on this team — run `musterd authority enroll` once, then confirm here',
        );
      }
      await confirmChannelPairing(cfg, p.id, approval);
      setStage({ kind: 'paired', device: p.app.device_name ?? 'your phone' });
      void loadPaired();
      onChanged();
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };

  const unpair = async (b: ChannelBinding) => {
    setBusy(true);
    setNote(null);
    try {
      await revokeChannelBinding(cfg, b.id);
      setUnpairing(false);
      setPaired(null);
      setStage({ kind: 'idle' });
      setNote({ tone: 'ok', text: `unpaired ${pairedLine(b).device} — asks no longer reach it` });
      onChanged();
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };

  const reject = async (p: ChannelPairing) => {
    setBusy(true);
    setNote(null);
    try {
      await rejectChannelPairing(cfg, p.id);
      setStage({ kind: 'idle' });
      setNote({ tone: 'ok', text: 'rejected — nothing was paired' });
      onChanged();
    } catch (e) {
      setNote({ tone: 'err', text: message(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lc-set__group lc-pair" aria-labelledby="lc-set-phone">
      <h3 id="lc-set-phone" className="lc-set__h">
        Your phone
      </h3>

      {stage.kind === 'idle' && paired && (
        <div className="lc-pair__have">
          <span className="lc-pair__tick" aria-hidden="true">
            ✓
          </span>
          <span className="lc-pair__havewho">
            <b>Paired with {pairedLine(paired).device}</b>
            <span className="lc-set__hint">
              since {pairedLine(paired).since} · asks reach it while you’re away
            </span>
          </span>
          {unpairing ? (
            <span className="lc-pair__act" role="group" aria-label="Unpair this phone?">
              <button
                type="button"
                className="lc-set__btn lc-pair__btn--danger"
                disabled={busy}
                onClick={() => void unpair(paired)}
              >
                {busy ? 'Unpairing…' : 'Unpair'}
              </button>
              <button
                type="button"
                className="lc-set__btn"
                disabled={busy}
                onClick={() => setUnpairing(false)}
              >
                Keep it
              </button>
            </span>
          ) : (
            <span className="lc-pair__act">
              <button
                type="button"
                className="lc-set__btn"
                disabled={busy}
                onClick={() => setUnpairing(true)}
              >
                Unpair
              </button>
              <button
                type="button"
                className="lc-set__btn"
                disabled={busy}
                onClick={() => void newCode()}
              >
                Pair another phone
              </button>
            </span>
          )}
        </div>
      )}

      {stage.kind === 'idle' && !paired && (
        <div className="lc-pair__idle">
          <p className="lc-set__lede">
            Get asks on your phone while you’re away, and answer them there. Scan a code with the
            musterd app, then confirm with your passkey.
          </p>
          <button
            type="button"
            className="lc-set__btn lc-set__btn--go"
            disabled={busy}
            onClick={() => void newCode()}
          >
            {busy ? 'Making a code…' : 'Pair a phone'}
          </button>
        </div>
      )}

      {stage.kind === 'code' && (
        <div className="lc-pair__code">
          <div
            className="lc-pair__qr"
            role="img"
            aria-label="Pairing code for the musterd app"
            // The SVG is built above from uqr's module grid, never from server text.
            dangerouslySetInnerHTML={{ __html: stage.svg }}
          />
          <div className="lc-pair__side">
            <p className="lc-pair__step">Open the musterd app and scan this code.</p>
            <p className="lc-set__hint">
              The app should show this daemon fingerprint:
              <span className="lc-pair__fp">{stage.start.daemon_fingerprint}</span>
            </p>
            <p className="lc-set__hint lc-pair__wait" aria-live="polite">
              <span className="lc-pair__pulse" aria-hidden="true" />
              Waiting for your phone · new code in {countdown(stage.start.expires_at - now)}
            </p>
            <button type="button" className="lc-set__btn" onClick={() => setStage({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'phone' && stage.pairing.app && (
        <div className="lc-pair__phone">
          <p className="lc-pair__device">{stage.pairing.app.device_name ?? 'A phone'} wants to pair</p>
          <p className="lc-set__hint">
            Phone key
            <span className="lc-pair__fp">{stage.pairing.app.fingerprint}</span>
            Check it matches what the app shows. Confirm only if this is your phone.
          </p>
          <span className="lc-pair__act">
            <button
              type="button"
              className="lc-set__btn lc-set__btn--go"
              disabled={busy || !me}
              onClick={() => void confirm(stage.pairing)}
            >
              {busy ? 'Waiting for your passkey…' : 'Confirm with passkey'}
            </button>
            <button
              type="button"
              className="lc-set__btn"
              disabled={busy}
              onClick={() => void reject(stage.pairing)}
            >
              Not my phone
            </button>
          </span>
        </div>
      )}

      {stage.kind === 'paired' && (
        <div className="lc-pair__done" role="status">
          <span className="lc-pair__tick" aria-hidden="true">
            ✓
          </span>
          <span>
            <b>Paired with {stage.device}.</b> Asks reach it while you’re away; it should buzz in a
            moment to say so.
          </span>
        </div>
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
