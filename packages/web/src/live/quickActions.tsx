import { QUICK_ACTIONS, type QuickAction } from '@musterd/protocol/wire';
import { useState } from 'react';
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
};

const QUICK_ACTION_HINT: Record<QuickAction, string> = {
  start: 'Wake it to orient and answer what waits',
  check_inbox: 'Wake it to read its inbox and act',
  check_pr: "musterd checks its lane's PR and tells it",
  resume: 'Wake it on its last lane, branch and memory',
};

export function sendQuickAction(cfg: LiveConfig, seat: string, action: QuickAction) {
  return sendAct(cfg, {
    act: 'steer',
    to: { kind: 'member', name: seat },
    body: QUICK_ACTION_LABEL[action],
    meta: { quick_action: action },
  });
}

export type StartResult = 'started' | 'capped' | 'offline';
export type StartAllReply = { seats: { seat: string; result: StartResult }[] };

export function startEveryone(cfg: LiveConfig): Promise<StartAllReply> {
  return apiPost<StartAllReply>(cfg, `/teams/${encodeURIComponent(cfg.team)}/quick-actions/start-all`, {});
}

/** "Started 3 · 1 held by its wake cap · 2 offline" — the counts that are not zero, in that order. */
export function startAllSummary(seats: StartAllReply['seats']): string {
  const n = (r: StartResult) => seats.filter((s) => s.result === r).length;
  const parts = [
    n('started') ? `Started ${n('started')}` : null,
    n('capped') ? `${n('capped')} held by ${n('capped') === 1 ? 'its' : 'their'} wake cap` : null,
    n('offline') ? `${n('offline')} offline` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No seats to start';
}

type Sent = { action: QuickAction; ok: boolean; text: string } | null;

/** One seat's four buttons, with what just happened said beside them in plain words. */
export function QuickActionBar({ cfg, seat, compact = false }: { cfg: LiveConfig; seat: string; compact?: boolean }) {
  const [busy, setBusy] = useState<QuickAction | null>(null);
  const [sent, setSent] = useState<Sent>(null);
  const run = async (action: QuickAction) => {
    setBusy(action);
    try {
      await sendQuickAction(cfg, seat, action);
      setSent({ action, ok: true, text: `${QUICK_ACTION_LABEL[action]} sent to ${seat}` });
    } catch (e) {
      setSent({ action, ok: false, text: e instanceof Error ? e.message : 'Could not send' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`qa${compact ? ' qa--compact' : ''}`} role="group" aria-label={`Quick actions for ${seat}`}>
      <div className="qa__row">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            className="qa__btn"
            title={QUICK_ACTION_HINT[a]}
            disabled={busy !== null}
            onClick={() => void run(a)}
          >
            {busy === a ? 'Sending…' : QUICK_ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {sent && (
        <p className={`qa__said${sent.ok ? '' : ' is-error'}`} role="status">
          {sent.text}
        </p>
      )}
    </div>
  );
}

/** What **Start everyone** did, seat by seat — "capped" said in words, because it means the hourly
 *  wake cap held that seat, not that the button failed. */
export function StartAllResults({ seats }: { seats: StartAllReply['seats'] }) {
  const word: Record<StartResult, string> = { started: 'started', capped: 'held by wake cap', offline: 'offline' };
  return (
    <div className="qa-all" role="status">
      <p className="qa-all__sum">{startAllSummary(seats)}</p>
      {seats.length > 0 && (
        <ul className="qa-all__list">
          {seats.map((s) => (
            <li key={s.seat} className={`is-${s.result}`}>
              <span className="qa-all__seat">{s.seat}</span> {word[s.result]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
