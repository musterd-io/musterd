import { useState } from 'react';
import type { LiveConfig } from '../client';
import type { SheetNote } from '../StyleSheet';
import { resolveVouch, vouchFor, vouchGate, vouchRefusal, type VouchRequest } from '../vouch';

/**
 * ADR 769 step 3, the admin's side, under Waiting for you. The card does NOT show the check code:
 * the admin types the code the member reads them, and Vouch stays off until it matches — the
 * out-of-band identity check made a required step, not a sentence to agree with (slippy's design
 * read). The request's notification only links here; nothing outside this card vouches.
 */
export function VouchRequests({
  cfg,
  requests,
}: {
  cfg: LiveConfig;
  requests: readonly VouchRequest[];
}) {
  // Settled here before the stream shows the resolve, so a card does not linger after its answer.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const open = requests.filter((r) => !settled.has(r.id));
  if (open.length === 0) return null;
  return (
    <section className="lc-set__group lc-set__group--waiting" aria-labelledby="lc-set-vouch">
      <h3 id="lc-set-vouch" className="lc-set__h">
        Waiting for you
      </h3>
      {open.map((r) => (
        <VouchCard
          key={r.id}
          cfg={cfg}
          request={r}
          onSettled={() => setSettled((s) => new Set(s).add(r.id))}
        />
      ))}
    </section>
  );
}

function VouchCard({
  cfg,
  request,
  onSettled,
}: {
  cfg: LiveConfig;
  request: VouchRequest;
  onSettled: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SheetNote>(null);
  const gate = vouchGate(typed, request.digest);
  const matches = gate === 'match';
  const complete = gate !== 'partial';
  const inputId = `lc-vouch-code-${request.id}`;

  const vouch = async () => {
    setBusy(true);
    setNote(null);
    try {
      await vouchFor(cfg, request.member, request.digest);
      setNote({ tone: 'ok', text: `vouched — ${request.member}'s passkey is enrolled` });
      await resolveVouch(cfg, request, 'vouched').catch(() => undefined);
      onSettled();
    } catch (e) {
      setNote({ tone: 'err', text: vouchRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    setNote(null);
    try {
      await resolveVouch(cfg, request, 'declined');
      onSettled();
    } catch (e) {
      setNote({ tone: 'err', text: vouchRefusal(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lc-keys__vouch" role="group" aria-labelledby={`${inputId}-h`}>
      <p id={`${inputId}-h`} className="lc-set__lede">
        <b>{request.member}</b> asks you to vouch for a new passkey.
      </p>
      <p className="lc-set__hint">
        Only vouch if you know it is really them. Call {request.member} or ask in person, and enter
        the 6-digit code they read you from their screen.
      </p>
      <form
        className="lc-keys__vouchact"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches) void vouch();
        }}
      >
        <label className="lc-set__hint" htmlFor={inputId}>
          Their code
        </label>
        <input
          id={inputId}
          className="lc-set__input lc-keys__codein"
          value={typed}
          onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={6}
          aria-invalid={complete && !matches}
          aria-describedby={`${inputId}-why`}
          disabled={busy}
        />
        <button type="submit" className="lc-set__btn lc-set__btn--go" disabled={busy || !matches}>
          {busy ? 'Waiting for your passkey…' : 'Vouch with passkey'}
        </button>
        <button type="button" className="lc-set__btn" disabled={busy} onClick={() => void decline()}>
          Don’t vouch
        </button>
      </form>
      <p id={`${inputId}-why`} className="lc-set__hint" role="status" aria-live="polite">
        {complete && !matches
          ? `That is not the code on ${request.member}’s screen. Check you are talking to them.`
          : ''}
      </p>
      <p
        className={`lc-set__note${note ? ` lc-set__note--${note.tone}` : ''}`}
        role="status"
        aria-live="polite"
      >
        {note?.text ?? ''}
      </p>
    </div>
  );
}
