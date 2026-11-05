import { POLL_LIMITS, type OpenPollReply, type PollSpec } from '@musterd/protocol/wire';
import { useCallback, useEffect, useState } from 'react';
import { closeOpenPoll, getOpenPoll, openPoll, type LiveConfig } from '../client';
import { headline, timeLeft } from '../poll';
import './PollPanel.css';

/**
 * Twitch polls from /live (ADR 807, lane 01M6ME5EPX) — in the admin Team tab. Start one while the
 * stream is live on Twitch (the passkey signs it), watch its count, end it early or cancel it. The
 * daemon decides who may (human admin, enrolled passkey) and when (Twitch says live); this panel
 * only says why when it refuses.
 */

/** What the admin is typing. Options are kept as typed; blanks are dropped when the poll is sent. */
export interface PollDraft {
  question: string;
  options: string[];
  minutes: string;
}

export const EMPTY_DRAFT: PollDraft = {
  question: '',
  options: ['', ''],
  minutes: String(POLL_LIMITS.defaultMinutes),
};

/** The spec the daemon will parse, or the first thing wrong with the draft. */
export function draftSpec(d: PollDraft): { ok: true; spec: PollSpec } | { ok: false; problem: string } {
  const question = d.question.trim();
  const options = d.options.map((o) => o.trim()).filter((o) => o !== '');
  const minutes = Number(d.minutes);
  if (!question) return { ok: false, problem: 'Ask a question.' };
  if (question.length > POLL_LIMITS.questionMax)
    return { ok: false, problem: `Keep the question under ${POLL_LIMITS.questionMax} characters.` };
  if (options.length < POLL_LIMITS.minOptions)
    return { ok: false, problem: `Give at least ${POLL_LIMITS.minOptions} options.` };
  if (options.length > POLL_LIMITS.maxOptions)
    return { ok: false, problem: `At most ${POLL_LIMITS.maxOptions} options.` };
  if (options.some((o) => o.length > POLL_LIMITS.optionMax))
    return { ok: false, problem: `Keep each option under ${POLL_LIMITS.optionMax} characters.` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
    return { ok: false, problem: 'Two options say the same thing.' };
  if (
    !Number.isInteger(minutes) ||
    minutes < POLL_LIMITS.minMinutes ||
    minutes > POLL_LIMITS.maxMinutes
  )
    return {
      ok: false,
      problem: `Run it for ${POLL_LIMITS.minMinutes}–${POLL_LIMITS.maxMinutes} minutes.`,
    };
  return { ok: true, spec: { question, options, minutes } };
}

export const NOT_LIVE = 'Polls open while you’re live on Twitch.';
export const NEEDS_PASSKEY = 'Add a passkey in Settings → You to start polls.';

/** A daemon refusal, said as what to do about it. */
export function refusalText(message: string): string {
  if (/needs a passkey/i.test(message)) return NEEDS_PASSKEY;
  if (/not live on Twitch/i.test(message)) return NOT_LIVE;
  if (/already open/i.test(message)) return 'A poll is already running.';
  if (/hub_local_required|on a Surface attached to the hub/i.test(message))
    return 'End or cancel the poll from /live on the hub for now.';
  return message;
}

/** The team's last poll, for the 5 minutes the daemon keeps it (ADR 807). */
export function lastLine(r: NonNullable<OpenPollReply['last']>): string {
  const votes = `${r.voters} ${r.voters === 1 ? 'vote' : 'votes'}`;
  if (r.end === 'cancelled') return `Last poll cancelled: ${r.question}`;
  if (r.end === 'interrupted') return `Last poll ended when the stream dropped: ${r.question} (${votes})`;
  return `Last poll: ${r.question} — ${headline(r)} (${votes})`;
}

export interface PollPanelViewProps {
  reply: OpenPollReply | null;
  draft: PollDraft;
  busy: boolean;
  note: { tone: 'ok' | 'err'; text: string } | null;
  now: number;
  onDraft: (d: PollDraft) => void;
  onStart: () => void;
  onClose: (how: 'end' | 'cancel') => void;
}

/** The panel's markup, from data alone — what the tests render. */
export function PollPanelView({
  reply,
  draft,
  busy,
  note,
  now,
  onDraft,
  onStart,
  onClose,
}: PollPanelViewProps) {
  const poll = reply?.poll ?? null;
  const live = reply?.live === true;
  const last = !poll ? (reply?.last ?? null) : null;
  const check = draftSpec(draft);
  const setOption = (i: number, v: string) =>
    onDraft({ ...draft, options: draft.options.map((o, j) => (j === i ? v : o)) });

  return (
    <section className="lc-set__group lc-poll" aria-labelledby="lc-set-poll">
      <h3 id="lc-set-poll" className="lc-set__h">
        Twitch poll
        <span className={`lc-poll__live${live ? ' is-live' : ''}`}>
          {reply === null ? 'checking…' : live ? 'live on Twitch' : 'not live'}
        </span>
      </h3>

      {poll ? (
        <div className="lc-poll__open">
          <p className="lc-poll__q">{poll.question}</p>
          <ol className="lc-poll__counts">
            {poll.options.map((o, i) => {
              const c = poll.counts[i] ?? 0;
              const pct = poll.voters > 0 ? Math.round((c / poll.voters) * 100) : 0;
              return (
                <li key={i}>
                  <span className="lc-poll__n">!vote {i + 1}</span>
                  <span className="lc-poll__opt">{o}</span>
                  <span className="lc-poll__c">
                    {c} · {pct}%
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="lc-set__hint">
            {poll.voters} {poll.voters === 1 ? 'vote' : 'votes'} · {timeLeft(poll.closes_at, now)}{' '}
            left · opened by {poll.opened_by}
          </p>
          {poll.post_failed && (
            <p className="lc-set__note lc-set__note--err">
              musterdbot couldn’t post in chat — votes still count, but viewers may not have seen
              the poll.
            </p>
          )}
          <div className="lc-poll__acts">
            <button
              type="button"
              className="lc-set__btn lc-set__btn--go"
              disabled={busy}
              onClick={() => onClose('end')}
            >
              End now
            </button>
            <button
              type="button"
              className="lc-set__btn"
              disabled={busy}
              onClick={() => onClose('cancel')}
            >
              Cancel poll
            </button>
          </div>
          <p className="lc-set__hint">End keeps the votes so far. Cancel names no winner.</p>
        </div>
      ) : (
        <form
          className="lc-poll__form"
          onSubmit={(e) => {
            e.preventDefault();
            onStart();
          }}
        >
          {last && <p className="lc-poll__last">{lastLine(last)}</p>}
          <label className="lc-poll__field">
            <span className="lc-set__label">Question</span>
            <input
              className="lc-set__text lc-poll__input"
              value={draft.question}
              maxLength={POLL_LIMITS.questionMax}
              placeholder="What should we work on next?"
              disabled={busy}
              onChange={(e) => onDraft({ ...draft, question: e.target.value })}
            />
          </label>
          {draft.options.map((o, i) => (
            <label key={i} className="lc-poll__field lc-poll__field--opt">
              <span className="lc-set__label">Option {i + 1}</span>
              <span className="lc-poll__optrow">
                <input
                  className="lc-set__text lc-poll__input"
                  value={o}
                  maxLength={POLL_LIMITS.optionMax}
                  disabled={busy}
                  onChange={(e) => setOption(i, e.target.value)}
                />
                {draft.options.length > POLL_LIMITS.minOptions && (
                  <button
                    type="button"
                    className="lc-set__reset"
                    aria-label={`Remove option ${i + 1}`}
                    disabled={busy}
                    onClick={() =>
                      onDraft({ ...draft, options: draft.options.filter((_, j) => j !== i) })
                    }
                  >
                    remove
                  </button>
                )}
              </span>
            </label>
          ))}
          <div className="lc-poll__row">
            {draft.options.length < POLL_LIMITS.maxOptions && (
              <button
                type="button"
                className="lc-set__btn"
                disabled={busy}
                onClick={() => onDraft({ ...draft, options: [...draft.options, ''] })}
              >
                Add an option
              </button>
            )}
            <label className="lc-poll__mins">
              <span className="lc-set__label">Runs for</span>
              <input
                className="lc-set__num"
                type="number"
                inputMode="numeric"
                min={POLL_LIMITS.minMinutes}
                max={POLL_LIMITS.maxMinutes}
                value={draft.minutes}
                disabled={busy}
                onChange={(e) => onDraft({ ...draft, minutes: e.target.value })}
              />
              <span className="lc-set__unit">min</span>
            </label>
          </div>
          <div className="lc-poll__acts">
            <button
              type="submit"
              className="lc-set__btn lc-set__btn--go"
              disabled={busy || !live || !check.ok}
            >
              {busy ? 'Starting…' : 'Start poll'}
            </button>
            <span className="lc-set__hint">
              {!live
                ? NOT_LIVE
                : !check.ok
                  ? check.problem
                  : 'Your passkey signs it. musterdbot posts it in chat.'}
            </span>
          </div>
        </form>
      )}
      {note && <p className={`lc-set__note lc-set__note--${note.tone}`}>{note.text}</p>}
    </section>
  );
}

/** The panel, wired: reads the poll every 5 s while settings is open. */
export function PollPanel({ cfg }: { cfg: LiveConfig }) {
  const [reply, setReply] = useState<OpenPollReply | null>(null);
  const [draft, setDraft] = useState<PollDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<PollPanelViewProps['note']>(null);
  const [now, setNow] = useState(() => Date.now());

  const read = useCallback(
    () =>
      getOpenPoll(cfg).then(
        (r) => {
          setReply(r);
          setNow(Date.now());
        },
        () => {},
      ),
    [cfg],
  );
  useEffect(() => {
    void read();
    const id = setInterval(() => void read(), 5_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(id);
      clearInterval(tick);
    };
  }, [read]);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await what();
      setNote({ tone: 'ok', text: done });
      await read();
    } catch (e) {
      setNote({ tone: 'err', text: refusalText(e instanceof Error ? e.message : String(e)) });
    } finally {
      setBusy(false);
    }
  };

  const onStart = () => {
    const check = draftSpec(draft);
    if (!check.ok) return;
    void run(async () => {
      // ADR 807 §5: opening mints the poll's credential, so the admin's passkey signs the exact spec.
      const { authorityProofForPoll } = await import('../authorityProof');
      const proof = await authorityProofForPoll(cfg, check.spec);
      await openPoll(cfg, check.spec, proof);
      setDraft(EMPTY_DRAFT);
    }, 'Poll started — musterdbot is posting it in chat.');
  };
  const onClose = (how: 'end' | 'cancel') => {
    const id = reply?.poll?.id;
    if (!id) return;
    void run(
      () => closeOpenPoll(cfg, id, how),
      how === 'end' ? 'Poll ended.' : 'Poll cancelled.',
    );
  };

  return (
    <PollPanelView
      reply={reply}
      draft={draft}
      busy={busy}
      note={note}
      now={now}
      onDraft={setDraft}
      onStart={onStart}
      onClose={onClose}
    />
  );
}
