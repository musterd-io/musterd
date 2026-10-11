import type { Envelope, Lane, MemberSummary } from '@musterd/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fill, TOUR_LANE_TITLE, TOUR_MESSAGES, TOUR_REQUEST } from '../../content/generated/tour';
import {
  createLane,
  fetchHistory,
  sendAct,
  updateLane,
  type LiveConfig,
} from '../../live/client';
import {
  advance,
  agentsOf,
  hintFor,
  initialState,
  modelOf,
  stepLines,
  stepTitle,
  tourEntry,
  ulidTime,
  type TourState,
  type TourVars,
} from './tourMachine';
import './Tour.css';

/**
 * The first-run tour on /live and /board (lane 01M4M4DDYF, spec docs/design/tour-web-copy.md): the
 * entry button, portalled into the topbar slot, and the panel that walks a human through giving an
 * agent one small lane and judging what comes back. A lazy chunk with its own CSS, mounted only for a
 * viewer signed in as a human, so a watcher pays nothing for it.
 *
 * Acts come from the page's own firehose (`envelopes`), which since #2329 carries this browser's own
 * HTTP sends too; a resume adds the team's history from just before the lane opened (spec §5).
 */
export interface TourPort {
  openLane(cfg: LiveConfig, title: string): Promise<string>;
  abandon(cfg: LiveConfig, id: string): Promise<unknown>;
  send: typeof sendAct;
  history(cfg: LiveConfig, since: number): Promise<Envelope[]>;
}

const livePort: TourPort = {
  openLane: async (cfg, title) => (await createLane(cfg, { title, stakes: 'normal' })).lane.id,
  abandon: (cfg, id) => updateLane(cfg, id, { state: 'abandoned', abandon_reason: 'tour reset' }),
  send: sendAct,
  history: (cfg, since) => fetchHistory(cfg, { since, limit: 200 }),
};

/** How long `team` stays up before the tour moves on by itself (spec §3: it advances by itself). */
const TEAM_DWELL_MS = 6_000;
/** The resume replay starts this long before the lane opened (spec §5). */
const OVERLAP_MS = 5_000;
const STOPPED = 'Stopped. Resume the tour any time to pick up where you left off.';

interface Run {
  s: TourState;
  /** When the current step began; the hints count from here. */
  at: number;
  /** History fetched on resume, folded in beside the firehose. */
  extra: Envelope[];
}

export function Tour({
  cfg,
  viewer,
  roster,
  envelopes,
  lanes,
  slotId,
  port = livePort,
}: {
  cfg: LiveConfig;
  viewer: string;
  roster: readonly MemberSummary[];
  envelopes: readonly Envelope[];
  lanes: readonly Lane[] | null;
  slotId: string;
  port?: TourPort;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const seen = useRef(new Set<string>());
  const opening = useRef(false);

  useEffect(() => setSlot(document.getElementById(slotId)), [slotId]);

  const entry = tourEntry(lanes, roster, viewer);
  const agents = agentsOf(roster, viewer);
  const s = run?.s;
  const vars: TourVars = {
    you: viewer,
    agent: s?.agent ?? '',
    lane: s?.laneId ?? '',
    model: s?.agent ? modelOf(roster, s.agent) : '',
  };

  const go = (next: TourState) =>
    setRun((r) => r && { ...r, s: next, at: next.step === r.s.step ? r.at : Date.now() });

  const start = (agent: string) => {
    seen.current = new Set();
    opening.current = false;
    setStopped(false);
    setError(null);
    setNote(null);
    setRun({ s: initialState(viewer, agent), at: Date.now(), extra: [] });
  };

  const resume = (lane: Lane) => {
    const agent = lane.owner_seat ?? (agents.length === 1 ? agents[0]! : '');
    seen.current = new Set();
    setStopped(false);
    setError(null);
    const s0: TourState = { ...initialState(viewer, agent), step: 'claims', laneId: lane.id };
    setRun({ s: s0, at: Date.now(), extra: [] });
    port
      .history(cfg, ulidTime(lane.id) - OVERLAP_MS)
      .then((extra) => setRun((r) => r && { ...r, extra }))
      .catch(() => {
        /* the firehose still moves it; the replay only saves a wait */
      });
  };

  const startOver = async (lane: Lane) => {
    setBusy(true);
    try {
      await port.abandon(cfg, lane.id);
      start(agents.length === 1 ? agents[0]! : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    setRun(null);
    setStopped(true);
  };

  // Fold the acts about this lane, oldest first, each once (spec §5).
  useEffect(() => {
    if (!run?.s.laneId) return;
    const fresh = [...run.extra, ...envelopes]
      .filter((e) => !seen.current.has(e.id))
      .sort((a, b) => a.ts - b.ts);
    if (fresh.length === 0) return;
    let next = run.s;
    for (const env of fresh) {
      seen.current.add(env.id);
      next = advance(next, { type: 'act', env });
    }
    if (next !== run.s) go(next);
  }, [envelopes, run]);

  // `team` moves on by itself once an agent is chosen.
  useEffect(() => {
    if (s?.step !== 'team' || !s.agent) return;
    const t = setTimeout(() => go(advance(s, { type: 'continue' })), TEAM_DWELL_MS);
    return () => clearTimeout(t);
  }, [s]);

  // `give_work` opens the lane in the viewer's name, unowned, and asks the agent to take it.
  useEffect(() => {
    if (s?.step !== 'give_work' || opening.current) return;
    opening.current = true;
    setBusy(true);
    void (async () => {
      try {
        const laneId = await port.openLane(cfg, fill(TOUR_LANE_TITLE, { you: viewer }));
        const ack = await port.send(cfg, {
          act: 'request_help',
          to: { kind: 'member', name: s.agent },
          body: fill(TOUR_REQUEST, { you: viewer, lane: laneId }),
        });
        setRun((r) => r && { ...r, s: advance(r.s, { type: 'lane_opened', laneId, requestId: ack.id }), at: Date.now() });
      } catch (e) {
        opening.current = false;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [s, cfg, port, viewer]);

  // A clock for the hints, only while the tour waits on the agent.
  const waiting = s?.step === 'claims' || s?.step === 'hands_back';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [waiting]);

  useEffect(() => {
    if (!stopped) return;
    const t = setTimeout(() => setStopped(false), 8_000);
    return () => clearTimeout(t);
  }, [stopped]);

  const laneId = s?.laneId;
  const detail = (laneId && lanes?.find((l) => l.id === laneId)?.detail) || '';

  const verdict = async (accept: boolean, text = '') => {
    if (!s?.askId) return;
    setBusy(true);
    try {
      await port.send(cfg, {
        act: accept ? 'accept' : 'decline',
        to: { kind: 'team' },
        body: text || (accept ? 'accepted in the tour' : 'sent back in the tour'),
        meta: { in_reply_to: s.askId },
      });
      setNote(null);
      go(advance(s, { type: 'verdict', accept }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const entryButtons =
    !run &&
    (stopped ? (
      <span className="tour-entry__note" role="status">
        {STOPPED}
      </span>
    ) : entry.kind === 'take' ? (
      <button type="button" className="tour-entry" onClick={() => start(agents.length === 1 ? agents[0]! : '')}>
        Take the tour
      </button>
    ) : entry.kind === 'resume' ? (
      <>
        <button type="button" className="tour-entry" onClick={() => resume(entry.lane)}>
          Resume the tour
        </button>
        <button
          type="button"
          className="tour-entry tour-entry--link"
          disabled={busy}
          onClick={() => void startOver(entry.lane)}
        >
          Start over
        </button>
      </>
    ) : null);

  return (
    <>
      {slot && entryButtons && createPortal(entryButtons, slot)}
      {s && (
        <TourPanel
          s={s}
          vars={vars}
          hint={waiting && run ? hintFor(s.step, now - run.at, vars) : null}
          agents={agents}
          detail={detail}
          note={note}
          busy={busy}
          error={error}
          onPick={(agent) => go({ ...s, agent })}
          onContinue={() => go(advance(s, { type: 'continue' }))}
          onSkip={() => go(advance(s, { type: 'skip_to_record' }))}
          onToNext={() => go({ ...s, step: 'next' })}
          onDone={() => setRun(null)}
          onStop={stop}
          onNote={setNote}
          onVerdict={verdict}
        />
      )}
    </>
  );
}

/** Body lines as paragraphs; on `add_seat` a run of two-space lines is a list (spec §3). */
function Lines({ lines, mono }: { lines: string[]; mono?: boolean }) {
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    out.push(
      <ul key={`l${out.length}`} className="tour__list">
        {list.map((l) => (
          <li key={l}>{l.trim()}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith('  ')) {
      list.push(line);
      continue;
    }
    flush();
    out.push(
      mono ? (
        <code key={line} className="tour__cmd">
          {line}
        </code>
      ) : (
        <p key={line}>{line}</p>
      ),
    );
  }
  flush();
  return <>{out}</>;
}

export function TourPanel({
  s,
  vars,
  hint,
  agents,
  detail,
  note,
  busy,
  error,
  onPick,
  onContinue,
  onSkip,
  onToNext,
  onDone,
  onStop,
  onNote,
  onVerdict,
}: {
  s: TourState;
  vars: TourVars;
  hint: string | null;
  agents: readonly string[];
  detail: string;
  note: string | null;
  busy: boolean;
  error: string | null;
  onPick: (agent: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  onToNext: () => void;
  onDone: () => void;
  onStop: () => void;
  onNote: (note: string | null) => void;
  onVerdict: (accept: boolean, note?: string) => void;
}) {
  const declined = s.step === 'claims' && s.outcome === 'declined';
  const lines = stepLines(s, vars);
  const atRecord = s.step === 'record';
  const stoppable = !atRecord && s.step !== 'add_seat' && s.step !== 'next';

  let body: ReactNode = <Lines lines={lines} mono={s.step === 'next'} />;
  let actions: ReactNode = null;

  if (!s.agent && agents.length > 1 && (s.step === 'what' || s.step === 'team')) {
    actions = (
      <div className="tour__pick" role="group" aria-label={TOUR_MESSAGES.pickAgent}>
        <p>{TOUR_MESSAGES.pickAgent}</p>
        {agents.map((a) => (
          <button key={a} type="button" className="lc-ask__btn" onClick={() => onPick(a)}>
            {a}
          </button>
        ))}
      </div>
    );
  } else if (!s.agent && agents.length === 0) {
    body = <p>{TOUR_MESSAGES.noAgent}</p>;
  } else if (s.step === 'what' || s.step === 'add_seat') {
    actions = (
      <button type="button" className="lc-ask__btn lc-ask__btn--accept" onClick={onContinue}>
        Continue
      </button>
    );
  } else if (declined) {
    body = (
      <p>
        {fill(TOUR_MESSAGES.declined, vars)} <span className="tour__quote">{s.declineReason}</span>
      </p>
    );
    actions = (
      <>
        <button type="button" className="lc-ask__btn lc-ask__btn--accept" onClick={onSkip}>
          See the record
        </button>
        <button type="button" className="tour__link" onClick={onStop}>
          Stop here
        </button>
      </>
    );
  } else if (s.step === 'judge') {
    body = (
      <>
        <Lines lines={lines} />
        {detail ? (
          <p className="tour__quote">{detail}</p>
        ) : (
          <p className="tour__muted">The lane has no summary yet.</p>
        )}
      </>
    );
    actions =
      note === null ? (
        <>
          <button
            type="button"
            className="lc-ask__btn lc-ask__btn--accept"
            disabled={busy || !s.askId}
            onClick={() => onVerdict(true)}
          >
            Accept it
          </button>
          <button type="button" className="lc-ask__btn" disabled={busy} onClick={() => onNote('')}>
            Send it back with a note
          </button>
        </>
      ) : (
        <form
          className="tour__note"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) onVerdict(false, note.trim());
          }}
        >
          <label htmlFor="tour-note">What should change?</label>
          <textarea
            id="tour-note"
            required
            rows={3}
            value={note}
            onChange={(e) => onNote(e.target.value)}
          />
          <button
            type="submit"
            className="lc-ask__btn lc-ask__btn--decline"
            disabled={busy || !note.trim()}
          >
            Send it back
          </button>
        </form>
      );
  } else if (atRecord) {
    // `record` and `add_seat` read as one screen, as the CLI shows them; Continue goes to `next`.
    body = (
      <>
        {s.outcome === 'self_closed' && <p>{fill(TOUR_MESSAGES.selfClosed, vars)}</p>}
        <Lines lines={lines} />
        <h3 className="tour__title">{stepTitle('add_seat')}</h3>
        <Lines lines={stepLines({ ...s, step: 'add_seat' }, vars)} />
      </>
    );
    actions = (
      <button type="button" className="lc-ask__btn lc-ask__btn--accept" onClick={onToNext}>
        Continue
      </button>
    );
  } else if (s.step === 'next') {
    actions = (
      <button type="button" className="lc-ask__btn lc-ask__btn--accept" onClick={onDone}>
        Done
      </button>
    );
  }

  return (
    <aside className="tour" aria-label="The musterd tour">
      <h2 className="tour__title">{stepTitle(s.step)}</h2>
      <div className="tour__body" aria-live="polite">
        {s.step === 'hands_back' && s.sentBack > 0 && <p>{fill(TOUR_MESSAGES.sentBack, vars)}</p>}
        {body}
        {hint && <p className="tour__muted">{hint}</p>}
        {error && (
          <p className="tour__error" role="alert">
            {error}
          </p>
        )}
      </div>
      {(actions || stoppable) && (
        <div className="tour__actions">
          {actions}
          {stoppable && !declined && (
            <button type="button" className="tour__link" onClick={onStop}>
              Stop
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
