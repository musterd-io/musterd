import { QUICK_ACTIONS, type QuickAction } from '@musterd/protocol/wire';
import { useEffect, useRef, useState } from 'react';
import { apiPost, sendAct, type LiveConfig } from './client';
import './QuickActions.css';

/**
 * The four quick actions (seats ask 2c, ADR 779): what a person used to type to a seat — "good
 * morning", "check your messages", "did the PR land?", "what were you on?" — as one button each. A
 * quick action is a person's `steer` with `meta.quick_action`; the daemon composes what the seat sees,
 * so the body here is only the label the log shows. Lazy: it rides the roster's and the triage card's
 * chunks, never /live's eager graph.
 */
export const QUICK_ACTION_LABEL: Record<QuickAction, string> = {
  start: 'Start',
  check_inbox: 'Check inbox',
  check_pr: 'Check PR',
  resume: 'Resume',
  stop: 'Stop',
};

/**
 * Which buttons a seat gets, by the rule the phone's Seats screen uses (`mobile/src/native/notice.ts`
 * `seatActions`, lane 01M6KZZ5WH): Start only for an offline seat that can be woken, Check PR only
 * with a lane, Stop while it is here or on shift (ADR 792: a shift can outlive one wake). Check inbox
 * and Resume always. The order is the vocabulary's own (`QUICK_ACTIONS`).
 */
export function seatActions(seat: {
  online: boolean;
  wakeable: boolean;
  lane: boolean;
  onShift?: boolean;
}): QuickAction[] {
  const on: Record<QuickAction, boolean> = {
    start: !seat.online && seat.wakeable,
    check_inbox: true,
    check_pr: seat.lane,
    resume: true,
    stop: seat.online || seat.onShift === true,
  };
  return QUICK_ACTIONS.filter((a) => on[a]);
}

const QUICK_ACTION_HINT: Record<QuickAction, string> = {
  start: 'Wake it to orient and answer what waits',
  check_inbox: 'Wake it to read its inbox and act',
  check_pr: "musterd checks its lane's PR and tells it",
  resume: 'Wake it on its last lane, branch and memory',
  stop: 'End its shift; a running wake finishes first',
};

export function sendQuickAction(cfg: LiveConfig, seat: string, action: QuickAction) {
  return sendAct(cfg, {
    act: 'steer',
    to: { kind: 'member', name: seat },
    body: QUICK_ACTION_LABEL[action],
    meta: { quick_action: action },
  });
}

export type StartResult = 'started' | 'offline';
export type StartAllReply = { seats: { seat: string; result: StartResult }[] };

export function startEveryone(cfg: LiveConfig): Promise<StartAllReply> {
  return apiPost<StartAllReply>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/quick-actions/start-all`,
    {},
  );
}

/** "Started 3 · 2 offline" — the counts that are not zero, in that order. A Start passes the wake
 *  cap (ADR 790), so no seat is ever held back by it. */
export function startAllSummary(seats: StartAllReply['seats']): string {
  const n = (r: StartResult) => seats.filter((s) => s.result === r).length;
  const parts = [
    n('started') ? `Started ${n('started')}` : null,
    n('offline') ? `${n('offline')} offline` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No seats to start';
}

/** A button's moment after a press, as the phone has it: it says so, then settles back. */
export type QuickState = 'sending' | 'sent' | 'failed';
const SETTLE_MS = 4000;

export function quickStateLabel(action: QuickAction, state: QuickState | undefined): string {
  if (state === 'sending') return 'Sending…';
  if (state === 'sent') return 'Sent';
  if (state === 'failed') return 'Couldn’t send';
  return QUICK_ACTION_LABEL[action];
}

/** One seat's sends, one state per button: a press on Check inbox never greys out Start. */
export function useQuickSend(cfg: LiveConfig, seat: string) {
  const [states, setStates] = useState<Partial<Record<QuickAction, QuickState>>>({});
  const timers = useRef(new Map<QuickAction, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);
  const set = (action: QuickAction, state: QuickState | undefined) =>
    setStates((prev) => {
      const next = { ...prev };
      if (state) next[action] = state;
      else delete next[action];
      return next;
    });
  const send = async (action: QuickAction) => {
    if (states[action] === 'sending') return;
    clearTimeout(timers.current.get(action));
    set(action, 'sending');
    let ok = true;
    try {
      await sendQuickAction(cfg, seat, action);
    } catch {
      ok = false;
    }
    set(action, ok ? 'sent' : 'failed');
    timers.current.set(
      action,
      setTimeout(() => set(action, undefined), SETTLE_MS),
    );
  };
  return { states, send };
}

/** 12px glyphs, `currentColor`: the phone's SF Symbols, drawn small enough to ride a pill. */
const GLYPH: Record<QuickAction | QuickState, string> = {
  start: 'M4.5 2.8v6.4L9.6 6z',
  check_inbox: 'M2 6.5h2.6l.9 1.6h1l.9-1.6H10M2.6 3h6.8L10 6.5V9H2V6.5z',
  check_pr: 'M3.5 2.5v7M3.5 4.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4M8.5 10.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4M8.5 7.8V5a1.5 1.5 0 0 0-1.5-1.5H5.5',
  resume: 'M9.5 4.5H5a2.5 2.5 0 0 0 0 5h1.5M8 2.8l1.6 1.7L8 6.2',
  stop: 'M3.4 3.4h5.2v5.2H3.4z',
  sending: 'M3 6h.01M6 6h.01M9 6h.01',
  sent: 'M2.8 6.3 5 8.4l4.2-4.8',
  failed: 'M6 3.2v3.3M6 8.6h.01',
};

function Glyph({ d, fill }: { d: string; fill: boolean }) {
  return (
    <svg className="qa__glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path
        d={d}
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One contextual pill: its glyph and label, then its own Sending… / Sent / Couldn’t send. */
export function QuickButton({
  action,
  state,
  onPress,
  seat,
}: {
  action: QuickAction;
  state: QuickState | undefined;
  onPress: () => void;
  seat: string;
}) {
  const glyph = state ?? action;
  const said =
    state === 'sent'
      ? `${QUICK_ACTION_LABEL[action]} sent to ${seat}`
      : state === 'failed'
        ? `${QUICK_ACTION_LABEL[action]} couldn’t reach ${seat}`
        : '';
  return (
    <>
    <button
      type="button"
      className={`qa__btn qa__btn--${action}${state ? ` is-${state}` : ''}`}
      title={QUICK_ACTION_HINT[action]}
      aria-busy={state === 'sending' || undefined}
      onClick={onPress}
    >
      <Glyph d={GLYPH[glyph]} fill={glyph === 'start' || glyph === 'stop'} />
      <span className="qa__label">{quickStateLabel(action, state)}</span>
    </button>
    <span className="qa__sr" role="status">
      {said}
    </span>
    </>
  );
}

/** One seat's contextual buttons (`seatActions`), each saying what its press did, in place. */
export function QuickActionBar({
  cfg,
  seat,
  actions,
  compact = false,
}: {
  cfg: LiveConfig;
  seat: string;
  actions: readonly QuickAction[];
  compact?: boolean;
}) {
  const { states, send } = useQuickSend(cfg, seat);
  return (
    <div
      className={`qa${compact ? ' qa--compact' : ''}`}
      role="group"
      aria-label={`Quick actions for ${seat}`}
    >
      <div className="qa__row">
        {actions.map((a) => (
          <QuickButton key={a} action={a} seat={seat} state={states[a]} onPress={() => void send(a)} />
        ))}
      </div>
    </div>
  );
}

/** What **Start everyone** did, seat by seat. A daemon older than ADR 790 can still answer
 *  `capped`; an unknown result is shown as the word it sent, never as a blank. */
export function StartAllResults({ seats }: { seats: StartAllReply['seats'] }) {
  const word: Record<string, string> = { started: 'started', offline: 'offline' };
  return (
    <div className="qa-all" role="status">
      <p className="qa-all__sum">{startAllSummary(seats)}</p>
      {seats.length > 0 && (
        <ul className="qa-all__list">
          {seats.map((s) => (
            <li key={s.seat} className={`is-${s.result}`}>
              <span className="qa-all__seat">{s.seat}</span> {word[s.result] ?? s.result}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
