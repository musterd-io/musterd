import type { Hold, HoldEffect } from '@musterd/protocol';
import { HOLD_EFFECTS, describeHoldLine } from '@musterd/protocol/wire';
import { useState } from 'react';
import { liftHold, setHold, type LiveConfig } from './client';

/** The "pause…" presets. Minutes, inside ADR 516's 12h cap; the daemon re-checks the cap. */
const FOR_PRESETS: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '2h', ms: 2 * 3600_000 },
  { label: '12h', ms: 12 * 3600_000 },
];

/** The effect's words in the picker — the same label `describeHoldLine` prints for it. */
const EFFECT_OPTION: Record<HoldEffect, string> = {
  autorefresh_paused: 'autorefresh paused',
  merges_paused: 'merges paused',
  notice: 'notice — not enforced',
};

/**
 * ADR 516: the Team's active holds above the room. Loaded lazily by `/live` and only once a hold is
 * in force or the viewer may set one — the line formatter lives in `@musterd/protocol/wire`, and
 * keeping that chunk out of the eager graph is what keeps /live inside its initial-JS budget on the
 * (usual) day nothing is paused.
 *
 * Increment 4: `canSet` is the daemon's `can_set` for this viewer (a human admin) and the lift and
 * "pause…" controls render from it ALONE — never from the viewer's role in this client (ADR 501
 * Decision 5's shape). The daemon still decides on the write; a refusal is shown in place, in its own
 * words. A viewer who may not set sees the banner exactly as before, and no controls.
 */
export function HoldsBanner({
  holds,
  now = Date.now(),
  cfg = null,
  canSet = false,
  onChanged,
}: {
  holds: Hold[];
  now?: number;
  cfg?: LiveConfig | null;
  canSet?: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const live = holds.filter((h) => h.lifted_at === null && h.expires_at > now);
  const controls = canSet && cfg !== null;
  if (live.length === 0) return null;
  return (
    <div className="lc-holds" role="status">
      {live.map((h) => (
        <div key={h.id} className="lc-holds__row">
          <span>⏸ {describeHoldLine(h, now)}</span>
          {controls && <LiftControl cfg={cfg} id={h.id} onChanged={onChanged} />}
        </div>
      ))}
    </div>
  );
}

/**
 * The "pause…" control on its own, for the topbar: an admin sets a hold from here, and the banner
 * above the room appears only once one is in force. Same `canSet` rule as the banner (ADR 501).
 */
export function HoldsPause({
  cfg,
  onChanged,
}: {
  cfg: LiveConfig;
  onChanged?: (() => void) | undefined;
}) {
  return (
    <span className="lc-holds lc-holds--inline">
      <SetControl cfg={cfg} onChanged={onChanged} />
    </span>
  );
}

function useRun(onChanged: (() => void) | undefined, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(() => {
        onDone?.();
        onChanged?.();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/** Lift one hold early — one click; the daemon answers `not_found` once it has already ended. */
function LiftControl({
  cfg,
  id,
  onChanged,
}: {
  cfg: LiveConfig;
  id: string;
  onChanged?: (() => void) | undefined;
}) {
  const { busy, error, run } = useRun(onChanged);
  return (
    <span className="lc-holds__box">
      <button
        type="button"
        className="lc-holds__btn lc-holds__btn--lift"
        disabled={busy}
        title="End this hold now, for every seat"
        onClick={() => run(() => liftHold(cfg, id))}
      >
        lift
      </button>
      {error && <span className="lc-holds__err">{error}</span>}
    </span>
  );
}

/** Set a hold: effect from the fixed list, a reason, a duration preset. No browser dialog. */
function SetControl({ cfg, onChanged }: { cfg: LiveConfig; onChanged?: (() => void) | undefined }) {
  const [asking, setAsking] = useState(false);
  const [effect, setEffect] = useState<HoldEffect>('autorefresh_paused');
  const [reason, setReason] = useState('');
  const [forMs, setForMs] = useState(FOR_PRESETS[1]!.ms);
  const { busy, error, run } = useRun(onChanged, () => {
    setAsking(false);
    setReason('');
  });
  if (!asking) {
    return (
      <span className="lc-holds__box">
        <button
          type="button"
          className="lc-holds__btn"
          disabled={busy}
          title="Pause something for the Team, by you, until a time — every seat sees it"
          onClick={() => setAsking(true)}
        >
          <svg className="lc-holds__icon" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5v7M8 2.5v7" />
          </svg>
          pause…
        </button>
        {error && <span className="lc-holds__err">{error}</span>}
      </span>
    );
  }
  return (
    <form
      className="lc-holds__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) run(() => setHold(cfg, { effect, reason: reason.trim(), for_ms: forMs }));
      }}
    >
      <select
        className="lc-holds__field"
        value={effect}
        aria-label="What to pause"
        onChange={(e) => setEffect(e.target.value as HoldEffect)}
      >
        {HOLD_EFFECTS.map((eff) => (
          <option key={eff} value={eff}>
            {EFFECT_OPTION[eff]}
          </option>
        ))}
      </select>
      <input
        className="lc-holds__field"
        value={reason}
        maxLength={280}
        placeholder="why"
        aria-label="Reason for the hold"
        onChange={(e) => setReason(e.target.value)}
      />
      <select
        className="lc-holds__field"
        value={forMs}
        aria-label="For how long"
        onChange={(e) => setForMs(Number(e.target.value))}
      >
        {FOR_PRESETS.map((p) => (
          <option key={p.label} value={p.ms}>
            for {p.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="lc-holds__btn lc-holds__btn--confirm"
        disabled={busy || !reason.trim()}
      >
        set hold
      </button>
      <button
        type="button"
        className="lc-holds__btn"
        disabled={busy}
        onClick={() => setAsking(false)}
      >
        cancel
      </button>
      {error && <span className="lc-holds__err">{error}</span>}
    </form>
  );
}
