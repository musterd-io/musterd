import type { LaneBoard, MemberSummary } from '@musterd/protocol';
// Runtime from the browser-safe entry: the root index also carries node-only modules (guidance-epoch).
import { pickerRows, type PickerRow, type PickerView } from '@musterd/protocol/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLaneBoard, updateLane, type LiveConfig } from './client';
import { pickAge, pickBlockedReason, pickItems, pickKey, pickPatch, type PickState } from './pickList';
import './PickOverlay.css';

/**
 * The /live lane picker (lane 01M5162T6H, musterd pick spec §5.4–§5.6). `/live?pick=<seat>` opens it:
 * the board's open lanes for that seat, from `pickerRows` — the same list the terminal picker shows,
 * computed by one function, never written or filtered by a model. The list is on the left, grouped by
 * goal; the highlighted lane's brief is on the right. A pick is the existing handoff from the
 * signed-in human to the seat, with a note asking for a short plan; the record says who asked.
 *
 * Keys: type to filter, ↑/↓ to move, Enter to pick, Esc to close. On the web Tab moves focus (the
 * dialog traps it), so claimable/blocked is a two-button switch rather than the terminal's Tab key.
 * The board is read when the picker opens and again just before a pick is sent (spec §6): if someone
 * took the lane meanwhile, the picker says who, refreshes, and keeps the filter.
 */
export function PickOverlay({
  cfg,
  seat,
  signedIn,
  roster,
  onSignIn,
  onClose,
}: {
  cfg: LiveConfig | null;
  seat: string;
  signedIn: boolean;
  roster: MemberSummary[];
  onSignIn: () => void;
  onClose: () => void;
}) {
  const [board, setBoard] = useState<LaneBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PickState>({ tab: 'claimable', filter: '', cursor: 0 });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PickerRow | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const member = roster.find((m) => m.name === seat);
  const service = member?.kind === 'service';

  const load = useCallback(async (): Promise<LaneBoard | null> => {
    if (!cfg) return null;
    try {
      const b = await fetchLaneBoard(cfg);
      setBoard(b);
      setError(null);
      return b;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [cfg]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const view: PickerView | null = useMemo(
    () => (board ? pickerRows(board, seat, Date.now()) : null),
    [board, seat],
  );
  const items = useMemo(() => (view ? pickItems(view, state) : []), [view, state]);
  const current = items[Math.min(state.cursor, Math.max(0, items.length - 1))] ?? null;
  // Group headers interleave the flat list without changing the cursor's index space.
  const heads = useMemo(() => items.map((r, i) => i === 0 || r.goal_id !== items[i - 1]!.goal_id), [items]);
  const counts = useMemo(
    () => ({
      claimable: view ? pickItems(view, { ...state, tab: 'claimable' }).length : 0,
      blocked: view ? pickItems(view, { ...state, tab: 'blocked' }).length : 0,
    }),
    [view, state],
  );

  // Focus the filter on open, and whenever the picker becomes usable after sign-in.
  const ready = view !== null;
  useEffect(() => {
    (filterRef.current ?? panelRef.current)?.focus({ preventScroll: true });
  }, [signedIn, ready]);

  // Keep the highlighted row in view as the cursor moves.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [state.cursor, state.tab, state.filter]);

  const pick = useCallback(
    async (row: PickerRow | null) => {
      if (!row || !cfg || busy || picked) return;
      if (row.blocked_on.length > 0) {
        setNote(`${row.short} waits on ${pickBlockedReason(row)} — it can be picked once that is done.`);
        return;
      }
      setBusy(true);
      setNote(null);
      // Read the board again just before sending (spec §6): the list may be a minute old.
      const fresh = await load();
      const lane = fresh?.lanes.find((l) => l.id === row.id);
      if (lane && (lane.state !== 'open' || lane.owner_seat !== null)) {
        setNote(`${row.short} was just taken${lane.owner_seat ? ` by ${lane.owner_seat}` : ''} — the list is refreshed.`);
        setBusy(false);
        return;
      }
      const patch = pickPatch(row, seat, cfg.as);
      try {
        if (patch) await updateLane(cfg, row.id, patch);
        setPicked(row);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
        void load();
      } finally {
        setBusy(false);
      }
    },
    [cfg, busy, picked, load, seat],
  );

  // Document-level, like BoardOverlay's Escape: the keys work wherever focus sits inside the dialog.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      // The focus trap: Tab and Shift+Tab cycle inside the dialog.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex="0"]')];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (!view || picked) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if ((e.key === 'Home' || e.key === 'End') && e.target === filterRef.current) return;
      e.preventDefault();
      setState((s) => pickKey(s, e.key as 'ArrowDown', items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void pick(current);
    }
  };

  // Re-subscribed each render so the handler always sees the current list; cheap at this size.
  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  const switchTab = (tab: PickState['tab']) => {
    setState((s) => (s.tab === tab ? s : { ...s, tab, cursor: 0 }));
    setNote(null);
    filterRef.current?.focus();
  };


  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- backdrop dismissal; Escape is the keyboard path
    <div
      className="pick"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="pick__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pick-title"
        tabIndex={-1}
      >
        <header className="pick__head">
          <h2 id="pick-title" className="pick__title">
            Pick work for <b>{seat}</b>
            <span className="pick__team"> · {cfg?.team ?? ''}</span>
          </h2>
          {view && view.carrying.length > 0 && (
            <p className="pick__carrying">
              {seat} is carrying {view.carrying.join(', ')} — you can still pick more.
            </p>
          )}
          <button type="button" className="pick__close" onClick={onClose} aria-label="Close the picker">
            ×
          </button>
        </header>

        {!signedIn ? (
          <div className="pick__gate">
            <p>
              A pick hands the lane to {seat} as you, so sign in first. The picker stays open and comes
              back once you are in.
            </p>
            <button type="button" className="pick__primary" onClick={onSignIn}>
              Sign in to pick
            </button>
          </div>
        ) : service ? (
          <div className="pick__gate">
            <p>{seat} is a service seat. Lanes cannot be handed to a service seat (ADR 232).</p>
          </div>
        ) : picked ? (
          <div className="pick__done" role="status">
            <span className="pick__stamp" aria-hidden="true">
              ✓
            </span>
            <p className="pick__doneline">
              Handed <b>{picked.short}</b> to <b>{seat}</b>.
            </p>
            <p className="pick__donehint">They will reply with a short plan, then start.</p>
            <button type="button" className="pick__primary" onClick={onClose}>
              Back to the room
            </button>
          </div>
        ) : (
          <>
            <div className="pick__bar">
              <input
                ref={filterRef}
                className="pick__filter"
                type="search"
                placeholder="Type to filter — id, title, goal or area"
                aria-label="Filter lanes"
                aria-controls="pick-list"
                aria-activedescendant={current ? `pick-opt-${current.short}` : undefined}
                value={state.filter}
                onChange={(e) => setState((s) => pickKey(s, { filter: e.target.value }, 0))}
              />
              <div className="pick__tabs" role="group" aria-label="Which lanes">
                <button
                  type="button"
                  aria-pressed={state.tab === 'claimable'}
                  className="pick__tab"
                  onClick={() => switchTab('claimable')}
                >
                  {counts.claimable} claimable
                </button>
                <button
                  type="button"
                  aria-pressed={state.tab === 'blocked'}
                  className="pick__tab"
                  onClick={() => switchTab('blocked')}
                >
                  {counts.blocked} blocked
                </button>
              </div>
            </div>

            <div className="pick__panes">
              <ul ref={listRef} id="pick-list" className="pick__list" role="listbox" aria-label="Open lanes">
                {error && <li className="pick__empty">{error}</li>}
                {!error && !view && <li className="pick__empty">Reading the board…</li>}
                {view && items.length === 0 && (
                  <li className="pick__empty">
                    {state.filter ? 'Nothing matches that filter.' : `No ${state.tab} lanes right now.`}
                  </li>
                )}
                {items.map((r, i) => {
                  const selected = i === state.cursor;
                  return (
                    <li key={r.id} role="presentation" className="pick__item">
                      {heads[i] && <div className="pick__goal">{r.goal_id ?? 'no goal'}</div>}
                      {/* The listbox pattern: focus stays in the filter, which points at the highlighted
                          option with aria-activedescendant; ↑/↓/⏎ are the keyboard path, so the click
                          here is the pointer's equivalent of ⏎. */}
                      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard path is the filter's ↑/↓/⏎ (aria-activedescendant) */}
                      <div
                        id={`pick-opt-${r.short}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        className={`pick__row${selected ? ' is-on' : ''}`}
                        style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
                        onMouseMove={() => !selected && setState((s) => ({ ...s, cursor: i }))}
                        onClick={() => void pick(r)}
                      >
                        <span className="pick__id">{r.short}</span>
                        <span className="pick__rowtitle">{r.title}</span>
                        <span className="pick__age">{pickAge(r.age_ms)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <aside className="pick__brief" aria-live="polite">
                {current ? (
                  <Brief row={current} seat={seat} />
                ) : (
                  <p className="pick__empty">Highlight a lane to read its brief.</p>
                )}
              </aside>
            </div>

            <footer className="pick__foot">
              {note ? (
                <p className="pick__note" role="alert">
                  {note}
                </p>
              ) : (
                <p className="pick__keys">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move · <kbd>⏎</kbd> pick · <kbd>esc</kbd> close
                </p>
              )}
              <button
                type="button"
                className="pick__primary"
                disabled={!current || busy || current.blocked_on.length > 0}
                onClick={() => void pick(current)}
              >
                {busy ? 'Handing it over…' : current ? `Pick ${current.short} for ${seat}` : 'Pick'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** The highlighted lane's brief: what it is, where it sits, and anything that changes the pick. */
function Brief({ row, seat }: { row: PickerRow; seat: string }) {
  return (
    <div key={row.id} className="pick__briefin">
      <p className="pick__briefid">{row.short}</p>
      <h3 className="pick__brieftitle">{row.title}</h3>
      <p className="pick__meta">
        {row.goal_id ? `goal ${row.goal_id}` : 'no goal'}
        {row.areas.length > 0 && ` · ${row.areas.join(', ')}`} · opened {pickAge(row.age_ms)} ago
      </p>
      {row.blocked_on.length > 0 && (
        <p className="pick__flag pick__flag--blocked">Waits on {pickBlockedReason(row)}.</p>
      )}
      {row.risk.length > 0 && (
        <p className="pick__flag">
          {row.risk.join(', ')} — acceptance goes to a human.
        </p>
      )}
      {row.declined && (
        <p className="pick__flag pick__flag--declined">
          {row.declined.by} declined this{row.declined.reason ? `: “${row.declined.reason}”` : '.'}
        </p>
      )}
      {row.detail && <p className="pick__detail">{row.detail}</p>}
      {row.scope.length > 0 && (
        <p className="pick__scope">
          scope {row.scope.slice(0, 4).join(', ')}
          {row.scope.length > 4 && ` +${row.scope.length - 4}`}
        </p>
      )}
      <p className="pick__for">Picking hands it to {seat}, as you.</p>
    </div>
  );
}
