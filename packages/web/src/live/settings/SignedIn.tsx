import { useCallback, useEffect, useState } from 'react';
import type { LiveConfig } from '../client';
import { fetchSignIns, lastUsedLabel, signInRows, signOutRow, type SignInRow } from './signIns';

/**
 * "Where you're signed in" (unified sign-in spec §7): every device and app signed in to this team
 * as you, each with Sign out, and Sign out everywhere behind one confirm. Strings are the sign-in
 * copy spec's §6, verbatim.
 */
export function SignedIn({ cfg, me }: { cfg: LiveConfig; me: string | null }) {
  const [rows, setRows] = useState<SignInRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!me) return;
    const lists = await fetchSignIns(cfg, me);
    setRows(signInRows({ ...lists, now: Date.now() }));
  }, [cfg, me]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!me || rows === null) return null;

  const signOut = async (row: SignInRow) => {
    setBusy(row.key);
    setFailed(null);
    try {
      await signOutRow(cfg, me, row);
      setDone(`${row.device} is signed out.`);
      await refresh();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const signOutEverywhere = async () => {
    setBusy('all');
    setFailed(null);
    // This browser goes last: ending it closes this page's own connection.
    const ordered = [...rows].sort((a, b) => Number(a.current) - Number(b.current));
    try {
      for (const row of ordered) await signOutRow(cfg, me, row);
      setDone(`Every device and app is signed out of ${cfg.team}.`);
      await refresh();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <SignedInList
      team={cfg.team}
      member={me}
      rows={rows}
      now={Date.now()}
      busy={busy}
      confirming={confirming}
      done={done}
      failed={failed}
      onSignOut={(row) => void signOut(row)}
      onAskAll={() => setConfirming(true)}
      onCancelAll={() => setConfirming(false)}
      onConfirmAll={() => void signOutEverywhere()}
    />
  );
}

/** The list itself, from props alone — what the render tests read. */
export function SignedInList(p: {
  team: string;
  member: string;
  rows: readonly SignInRow[];
  now: number;
  busy: string | null;
  confirming: boolean;
  done: string | null;
  failed: string | null;
  onSignOut: (row: SignInRow) => void;
  onAskAll: () => void;
  onCancelAll: () => void;
  onConfirmAll: () => void;
}) {
  const onlyHere = p.rows.length === 1 && p.rows[0]!.current;
  return (
    <section className="lc-set__group lc-keys" aria-labelledby="lc-set-signed-in">
      <h3 id="lc-set-signed-in" className="lc-set__h">
        Where you're signed in
      </h3>
      <p className="lc-set__lede">
        Every device and app signed in to {p.team} as {p.member}.
      </p>
      {onlyHere ? (
        <p className="lc-set__hint">Only this browser is signed in.</p>
      ) : (
        <ul className="lc-keys__list">
          {p.rows.map((row) => (
            <li key={row.key} className="lc-keys__key">
              <span
                className={`lc-signed__dot${row.current ? ' lc-signed__dot--here' : ''}`}
                aria-hidden="true"
              />
              <span>
                {row.device}{' '}
                <span className="lc-set__hint">
                  · {row.how} · {lastUsedLabel(row.lastUsedAt, p.now)}
                </span>
              </span>
              <button
                type="button"
                className="lc-set__btn lc-keys__revoke"
                disabled={p.busy !== null}
                aria-label={`Sign out ${row.device}`}
                onClick={() => p.onSignOut(row)}
              >
                {p.busy === row.key ? 'Signing out…' : row.action}
              </button>
            </li>
          ))}
        </ul>
      )}
      {p.rows.length > 0 &&
        (p.confirming ? (
          <div className="lc-signed__confirm" role="group" aria-label="Confirm sign out everywhere">
            <p className="lc-set__hint">
              This signs out every device and app on {p.team}, this one too.
            </p>
            <button
              type="button"
              className="lc-set__btn"
              disabled={p.busy !== null}
              onClick={p.onConfirmAll}
            >
              {p.busy === 'all' ? 'Signing out…' : 'Sign out everywhere'}
            </button>{' '}
            <button
              type="button"
              className="lc-set__btn"
              disabled={p.busy !== null}
              onClick={p.onCancelAll}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="lc-set__btn"
            disabled={p.busy !== null}
            onClick={p.onAskAll}
          >
            Sign out everywhere on {p.team}
          </button>
        ))}
      <p className="lc-set__hint" role="status" aria-live="polite">
        {p.failed ?? p.done ?? ''}
      </p>
    </section>
  );
}
