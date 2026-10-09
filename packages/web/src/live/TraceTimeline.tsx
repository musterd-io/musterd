import type { TraceSeatTimelineResponse, TraceSessionEvent } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import { apiGet, type LiveConfig } from './client';

/**
 * The `/live` per-seat trace timeline (ADR 445 increment 4b, human-gated; opened 2026-09-26).
 *
 * A seat's last N structural events — `time · kind · tool · duration` — in the `musterd trace show`
 * vocabulary. Rail R2 rows (reasoning / assistant_text / usage) are dimmed so the hook rail reads
 * first. It never fetches or shows content: the route it reads selects structural columns only,
 * and a row's `content` field is always null on this wire. ADR 128 scoping happens server-side —
 * a viewer who may not read this seat gets an empty list, which renders as "nothing to show", the
 * same as a seat that has never been traced.
 *
 * Two pieces on purpose: `TraceTimeline` is pure (props in, markup out) so a render test can pin
 * the vocabulary with no fetch; `SeatTraceToggle` owns the expand state and the fetch.
 */

const R2_KINDS = new Set(['reasoning', 'assistant_text', 'usage', 'unknown']);

/**
 * `GET /teams/:slug/trace/seats/:name` — lives HERE, in the lazy chunk, rather than in client.ts,
 * so /live's eager graph carries none of it (ADR 151/183). Member-authed; ADR 128 scoping is the
 * daemon's, so a seat this viewer may not read comes back empty rather than refused. The one shape
 * check with a consumer (the validator-free door, ADR 148): an array of rows under a seat name.
 */
export async function fetchSeatTrace(
  cfg: LiveConfig,
  seat: string,
  limit = 50,
): Promise<TraceSeatTimelineResponse> {
  const json = await apiGet<{ seat?: unknown; events?: unknown }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/trace/seats/${encodeURIComponent(seat)}?limit=${limit}`,
  );
  if (typeof json?.seat !== 'string' || !Array.isArray(json.events))
    throw new Error('trace seat timeline: unexpected shape');
  return json as TraceSeatTimelineResponse;
}

export function clockSec(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** One row's right-hand cell, in the kind's own vocabulary (mirrors `cli trace.ts` traceEventSummary). */
export function timelineSummary(e: TraceSessionEvent): string {
  const d = e.detail ?? {};
  if (e.kind === 'usage') {
    const parts: string[] = [];
    const inTok = num(d['input_tokens']);
    const outTok = num(d['output_tokens']);
    if (inTok !== undefined) parts.push(`in ${inTok}`);
    if (outTok !== undefined) parts.push(`out ${outTok}`);
    const model = typeof d['model'] === 'string' ? d['model'] : undefined;
    return [parts.join(' · '), model].filter(Boolean).join('  ');
  }
  if (e.kind === 'reasoning' || e.kind === 'assistant_text') {
    const size = num(d[e.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']);
    return size !== undefined ? `${size} bytes` : '';
  }
  if (e.kind === 'unknown') {
    return d['downgraded'] === true ? 'downgraded' : typeof d['type'] === 'string' ? d['type'] : '';
  }
  if (e.kind === 'HookOutcome') {
    const hook = typeof d['hook'] === 'string' ? d['hook'] : '';
    return [hook, e.outcome ?? ''].filter(Boolean).join(' · ');
  }
  const bits: string[] = [];
  if (e.tool_name) bits.push(e.tool_name);
  if (typeof e.duration_ms === 'number') bits.push(`${e.duration_ms}ms`);
  if (e.outcome && e.outcome !== 'ok') bits.push(e.outcome);
  return bits.join(' · ');
}

export function TraceTimeline({
  seat,
  events,
  state = 'ready',
}: {
  seat: string;
  /** Newest first, as the route returns them. */
  events: TraceSessionEvent[];
  state?: 'loading' | 'ready' | 'error';
}) {
  if (state === 'loading')
    return <p className="lc-trace__empty">Reading {seat}'s trace…</p>;
  if (state === 'error')
    return <p className="lc-trace__empty">Could not read {seat}'s trace.</p>;
  if (events.length === 0)
    return (
      <p className="lc-trace__empty">
        Nothing to show — {seat} is not traced, or not yours to read.
      </p>
    );
  return (
    <ol className="lc-trace" aria-label={`${seat}'s recent trace`}>
      {events.map((e) => (
        <li
          key={`${e.seat}:${e.ts}:${e.seq}`}
          className={`lc-trace__row${R2_KINDS.has(e.kind) ? ' is-r2' : ''}`}
        >
          <span className="lc-trace__time">{clockSec(e.ts)}</span>
          <span className="lc-trace__kind">{e.kind}</span>
          <span className="lc-trace__what">{timelineSummary(e)}</span>
        </li>
      ))}
    </ol>
  );
}

/** How often an open seat re-reads its trace. The route is a bounded structural read (ADR 445). */
export const TRACE_FOLLOW_MS = 4000;

export interface TraceView {
  state: 'loading' | 'ready' | 'error';
  events: TraceSessionEvent[];
}

/**
 * Fold one read into what the panel shows. A refresh that fails keeps the last list — only a read
 * that has never succeeded shows the error, so a blip on a followed trace does not blank it.
 */
export function foldTraceRead(
  prev: TraceView,
  read: { events: TraceSessionEvent[] } | null,
): TraceView {
  if (read) return { state: 'ready', events: read.events };
  return prev.state === 'ready' ? prev : { state: 'error', events: prev.events };
}

/**
 * The fetching half, mounted by the roster only while a seat is expanded — and loaded lazily
 * (`RosterPanel.tsx` `lazy()`s this module) so none of it rides /live's eager graph (ADR 151/183):
 * the roster pays one small button per row and nothing else until a reader reaches for a trace.
 *
 * While open it follows: it re-reads every `TRACE_FOLLOW_MS`, stops while the tab is hidden (and
 * reads at once when it returns), and keeps the last list when a refresh fails.
 */
export default function SeatTracePanel({ cfg, seat }: { cfg: LiveConfig; seat: string }) {
  const [view, setView] = useState<TraceView>({ state: 'loading', events: [] });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    setView({ state: 'loading', events: [] });

    const read = async () => {
      timer = undefined;
      inflight = true;
      let r: { events: TraceSessionEvent[] } | null = null;
      try {
        r = await fetchSeatTrace(cfg, seat);
      } catch {
        r = null;
      }
      inflight = false;
      if (cancelled) return;
      setView((v) => foldTraceRead(v, r));
      schedule();
    };
    const schedule = () => {
      if (cancelled || timer !== undefined || document.hidden) return;
      timer = setTimeout(() => void read(), TRACE_FOLLOW_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      } else if (timer === undefined && !inflight) {
        void read();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cfg, seat]);

  return <TraceTimeline seat={seat} events={view.events} state={view.state} />;
}
