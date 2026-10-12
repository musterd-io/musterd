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
import { Confetti, LaneTicket } from './LaneTicket';
import {
  advance,
  agentNow,
  agentsOf,
  clock,
  hintFor,
  initialState,
  modelOf,
  READINESS_LABEL,
  readinessOf,
  stepIndex,
  stepLines,
  stepTitle,
  suggestAgent,
  ticketStage,
  timeline,
  TOUR_STEP_COUNT,
  entryLabel,
  tourEntry,
  ulidTime,
  type Readiness,
  type TicketStage,
  type TimelineEntry,
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
 *
 * The redesign (lane 01M4PSEV08) makes the lane something you watch rather than read about: a
 * ticket that lights up as the real acts land, a spotlight on the agent and the lane on the page
 * itself, a picker that suggests an awake agent, and a stamp when you accept.
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

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const cssId = (v: string) =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^\w-]/g, '');

/**
 * The spotlight: a ring on the agent's team card (/live) and on the lane's card (/board), as one
 * `<style>` rule keyed by `data-member` / `data-lane`. A rule rather than a class added to the node,
 * because React rewrites those nodes' className on every roster tick and would wipe a class it
 * does not own. It breathes while the tour waits on the agent, pops once on the claim, and rests
 * after. An element that is not on screen simply matches nothing.
 */
export function spotlightCss(s: TourState, motion: boolean): string {
  const lit = s.agent && s.step !== 'what' && s.step !== 'next' && s.step !== 'add_seat';
  if (!lit) return '';
  const sels = [`[data-member="${cssId(s.agent)}"]`];
  if (s.laneId) sels.push(`[data-lane="${cssId(s.laneId)}"]`);
  const anim = !motion
    ? 'none'
    : s.step === 'claims' && s.outcome !== 'declined'
      ? 'tour-spot-breathe 1.6s ease-in-out infinite'
      : s.step === 'hands_back'
        ? 'tour-spot-pop .6s ease-out 1'
        : 'none';
  return `${sels.join(',')}{box-shadow:0 0 0 2px var(--lc-accent),0 0 20px color-mix(in srgb,var(--lc-accent) 38%,transparent);animation:${anim};position:relative;z-index:1}`;
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
  const [mini, setMini] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const seen = useRef(new Set<string>());
  const opening = useRef(false);
  const panel = useRef<HTMLElement | null>(null);

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
    setMini(false);
    setError(null);
    setNote(null);
    setRun({ s: initialState(viewer, agent), at: Date.now(), extra: [] });
  };

  const resume = (lane: Lane) => {
    const agent = lane.owner_seat ?? (agents.length === 1 ? agents[0]! : '');
    seen.current = new Set();
    setStopped(false);
    setMini(false);
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
        setRun(
          (r) =>
            r && {
              ...r,
              s: advance(r.s, { type: 'lane_opened', laneId, requestId: ack.id }),
              at: Date.now(),
            },
        );
      } catch (e) {
        opening.current = false;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [s, cfg, port, viewer]);

  // A clock for the elapsed line and the hints, only while the tour waits on the agent. A decline
  // stops the wait: nothing more is coming.
  const waiting = (s?.step === 'claims' && s.outcome !== 'declined') || s?.step === 'hands_back';
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [waiting]);

  useEffect(() => {
    if (!stopped) return;
    const t = setTimeout(() => setStopped(false), 8_000);
    return () => clearTimeout(t);
  }, [stopped]);

  // Bring the spotlit thing into view when it first lights: the agent on `team`, the lane once it
  // opens. Once per step, and only by the least scroll, so the page never yanks under the viewer.
  const step = s?.step;
  const agent = s?.agent;
  const laneId = s?.laneId;
  useEffect(() => {
    if (step !== 'team' && step !== 'claims') return;
    const target =
      (laneId ? document.querySelector(`[data-lane="${cssId(laneId)}"]`) : null) ??
      (agent ? document.querySelector(`[data-member="${cssId(agent)}"]`) : null);
    target?.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [step, agent, laneId]);

  // Enter takes the step's main action and Esc tucks the panel away — but never while the viewer
  // is typing or has a control focused, so the composer and every button keep their own keys.
  useEffect(() => {
    if (!run || mini) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const inPanel = !!t && !!panel.current?.contains(t);
      const typing =
        !!t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === 'Escape' && (inPanel || t === document.body)) {
        setMini(true);
      } else if (e.key === 'Enter' && !typing) {
        const primary = panel.current?.querySelector<HTMLButtonElement>(
          '[data-primary]:not(:disabled)',
        );
        if (!primary) return;
        e.preventDefault();
        primary.click();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [run, mini]);

  const detail = (laneId && lanes?.find((l) => l.id === laneId)?.detail) || '';
  const acts = run ? [...run.extra, ...envelopes] : [];

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
    ) : entryLabel(entry) ? (
      <button
        type="button"
        className="tour-entry"
        onClick={() => start(agents.length === 1 ? agents[0]! : '')}
      >
        {entryLabel(entry)}
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

  const elapsed = waiting && run ? clock(now - run.at) : null;

  return (
    <>
      {slot && entryButtons && createPortal(entryButtons, slot)}
      {s && <style>{spotlightCss(s, !reducedMotion())}</style>}
      {s && mini && (
        <button
          type="button"
          className="tour-pill"
          aria-label={`Open the tour, ${stepTitle(s.step)}`}
          onClick={() => setMini(false)}
        >
          {waiting && <span className="tour__dot" aria-hidden="true" />}
          Tour · {stepIndex(s.step) + 1}/{TOUR_STEP_COUNT}
          {elapsed && <span className="tour__clock">{elapsed}</span>}
        </button>
      )}
      {s && !mini && (
        <TourPanel
          panelRef={panel}
          s={s}
          vars={vars}
          hint={waiting && run ? hintFor(s.step, now - run.at, vars) : null}
          wait={
            elapsed ? { elapsed, now: agentNow(roster.find((m) => m.name === s.agent), s.step) } : null
          }
          ticket={
            s.laneId
              ? {
                  title:
                    lanes?.find((l) => l.id === s.laneId)?.title ??
                    fill(TOUR_LANE_TITLE, { you: viewer }),
                  stage: ticketStage(s),
                  entries: timeline(acts, s),
                }
              : null
          }
          picks={agents.map((name) => ({
            name,
            readiness: readinessOf(roster.find((m) => m.name === name)),
          }))}
          suggested={suggestAgent(roster, agents)}
          detail={detail}
          note={note}
          busy={busy}
          error={error}
          onPick={(picked) => go({ ...s, agent: picked })}
          onContinue={() => go(advance(s, { type: 'continue' }))}
          onSkip={() => go(advance(s, { type: 'skip_to_record' }))}
          onToNext={() => go({ ...s, step: 'next' })}
          onDone={() => setRun(null)}
          onStop={stop}
          onMinimize={() => setMini(true)}
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

/** What the panel shows while it waits on the agent, so the wait never reads as a stall. */
export interface TourWait {
  elapsed: string;
  now: string | null;
}

export interface TourTicket {
  title: string;
  stage: TicketStage;
  entries: readonly TimelineEntry[];
}

export interface TourPick {
  name: string;
  readiness: Readiness;
}

export function TourPanel({
  panelRef,
  s,
  vars,
  hint,
  wait = null,
  ticket = null,
  picks,
  suggested = '',
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
  onMinimize,
  onNote,
  onVerdict,
}: {
  panelRef?: { current: HTMLElement | null };
  s: TourState;
  vars: TourVars;
  hint: string | null;
  wait?: TourWait | null;
  ticket?: TourTicket | null;
  picks: readonly TourPick[];
  suggested?: string;
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
  onMinimize?: () => void;
  onNote: (note: string | null) => void;
  onVerdict: (accept: boolean, note?: string) => void;
}) {
  const declined = s.step === 'claims' && s.outcome === 'declined';
  const lines = stepLines(s, vars);
  const atRecord = s.step === 'record';
  const stoppable = !atRecord && s.step !== 'add_seat' && s.step !== 'next';
  const here = stepIndex(s.step);
  const title = useRef<HTMLHeadingElement | null>(null);

  // Focus follows the step for a keyboard or screen-reader viewer — but only when focus is already
  // in the panel or nowhere, so an agent's claim never pulls the caret out of the composer.
  useEffect(() => {
    const active = document.activeElement;
    if (active === document.body || (active && panelRef?.current?.contains(active))) {
      title.current?.focus({ preventScroll: true });
    }
  }, [s.step, panelRef]);

  let body: ReactNode = <Lines lines={lines} mono={s.step === 'next'} />;
  let actions: ReactNode = null;

  if (!s.agent && picks.length > 1 && (s.step === 'what' || s.step === 'team')) {
    actions = (
      <div className="tour__pick" role="group" aria-label={TOUR_MESSAGES.pickAgent}>
        <p>{TOUR_MESSAGES.pickAgent}</p>
        {picks.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`tour-chip tour-chip--${p.readiness}${p.name === suggested ? ' is-suggested' : ''}`}
            data-primary={p.name === suggested ? '' : undefined}
            onClick={() => onPick(p.name)}
          >
            <span className="tour-chip__dot" aria-hidden="true" />
            <span className="tour-chip__name">{p.name}</span>
            <span className="tour-chip__state">
              {p.name === suggested ? `Suggested · ${READINESS_LABEL[p.readiness]}` : READINESS_LABEL[p.readiness]}
            </span>
          </button>
        ))}
      </div>
    );
  } else if (!s.agent && picks.length === 0) {
    body = <p>{TOUR_MESSAGES.noAgent}</p>;
  } else if (s.step === 'what' || s.step === 'add_seat') {
    actions = (
      <button
        type="button"
        className="lc-ask__btn lc-ask__btn--accept"
        data-primary=""
        onClick={onContinue}
      >
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
        <button
          type="button"
          className="lc-ask__btn lc-ask__btn--accept"
          data-primary=""
          onClick={onSkip}
        >
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
            data-primary=""
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
      <button
        type="button"
        className="lc-ask__btn lc-ask__btn--accept"
        data-primary=""
        onClick={onToNext}
      >
        Continue
      </button>
    );
  } else if (s.step === 'next') {
    actions = (
      <button
        type="button"
        className="lc-ask__btn lc-ask__btn--accept"
        data-primary=""
        onClick={onDone}
      >
        Done
      </button>
    );
  }

  const showTicket = ticket && s.step !== 'next';
  const celebrate = atRecord && s.outcome === 'accepted';

  return (
    <aside
      ref={panelRef}
      className={`tour${celebrate ? ' tour--won' : ''}`}
      aria-label="The musterd tour"
    >
      <div className="tour__top">
        <ol className="tour-rail" aria-hidden="true">
          {Array.from({ length: TOUR_STEP_COUNT }, (_, i) => (
            <li key={i} className={i < here ? 'is-done' : i === here ? 'is-now' : ''} />
          ))}
        </ol>
        {onMinimize && (
          <button
            type="button"
            className="tour__mini"
            aria-label="Minimize the tour (Esc)"
            title="Minimize (Esc)"
            onClick={onMinimize}
          >
            –
          </button>
        )}
      </div>
      <h2 className="tour__title" tabIndex={-1} ref={title}>
        {stepTitle(s.step)}
      </h2>
      {showTicket && (
        <LaneTicket
          laneId={s.laneId ?? ''}
          title={ticket.title}
          agent={s.agent}
          stage={ticket.stage}
          declined={declined}
          outcome={s.outcome}
          you={vars.you}
          entries={ticket.entries}
        />
      )}
      <div className="tour__body" aria-live="polite">
        <div key={s.step} className="tour__step">
          {s.step === 'hands_back' && s.sentBack > 0 && <p>{fill(TOUR_MESSAGES.sentBack, vars)}</p>}
          {body}
        </div>
        {wait && (
          <div className="tour__wait">
            <p className="tour__waiting">
              <span className="tour__dot" aria-hidden="true" />
              Waiting on {s.agent} ·{' '}
              {/* Every second inside a live region would chatter at a screen reader; the line
                  below carries the news. */}
              <span className="tour__clock" aria-hidden="true">
                {wait.elapsed}
              </span>
            </p>
            {wait.now && <p className="tour__muted">{wait.now}</p>}
          </div>
        )}
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
      {celebrate && <Confetti />}
    </aside>
  );
}
