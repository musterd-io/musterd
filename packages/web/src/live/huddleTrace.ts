import type { HuddleTrace } from '@musterd/protocol';
import { apiGet, type LiveConfig } from './client';
import { sinceOpen } from './huddles';

/**
 * Huddle replay increment 2 (lane 01M3WNPZ8K): one seat's path through a huddle — its wake, then
 * the tool calls and hooks it ran — read from the daemon's huddle trace (ADR 493,
 * `GET /teams/:slug/huddles/:id/trace`). The daemon does the join; this renders its rows as given.
 *
 * Lives in the log's lazy chunk (Stream imports it), and imports the protocol TYPE only — no zod in
 * /live's graph (the validator-free door, ADR 148): one shape check at the boundary, like the seat
 * timeline's fetch.
 */
export async function fetchHuddleTrace(cfg: LiveConfig, id: string): Promise<HuddleTrace> {
  const json = await apiGet<{ seats?: unknown; events?: unknown }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/huddles/${encodeURIComponent(id)}/trace`,
  );
  if (!Array.isArray(json?.seats) || !Array.isArray(json.events))
    throw new Error('huddle trace: unexpected shape');
  return json as HuddleTrace;
}

export interface PathLine {
  ts: number;
  /** Time since the huddle opened, in the close-note format. */
  since: string;
  kind: 'wake' | 'tool' | 'hook' | 'session';
  text: string;
  /** Shown faint after the text: a duration, or an outcome that was not ok. */
  note?: string;
}

/** The most steps one seat's path shows before it says how many more there were. */
export const PATH_MAX_LINES = 30;

const ms = (n: number) => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);

/** A seat's path in time order: its wake, then every tool, hook and session row it left. */
export function seatPath(trace: HuddleTrace, seat: string): PathLine[] {
  const t0 = trace.huddle.opened_at;
  const lines: PathLine[] = [];
  const s = trace.seats.find((x) => x.seat === seat);
  if (s?.wake) {
    const w = s.wake;
    const at = w.spawned_at ?? w.leased_at;
    const what = w.outcome === 'woke' ? 'woke' : `wake ${w.outcome}`;
    lines.push({
      ts: at,
      since: sinceOpen(at - t0),
      kind: 'wake',
      text: w.session ? `${what} · ${w.session} session` : what,
      ...(w.duration_ms != null ? { note: `ran ${ms(w.duration_ms)}` } : {}),
    });
  }
  for (const e of trace.events) {
    if (e.seat !== seat || e.kind === 'act' || e.kind === 'wake') continue;
    const bad = e.outcome && e.outcome !== 'ok' ? e.outcome : undefined;
    const note = [bad, e.duration_ms != null ? ms(e.duration_ms) : undefined]
      .filter(Boolean)
      .join(' · ');
    lines.push({
      ts: e.ts,
      since: sinceOpen(e.ts - t0),
      kind: e.kind,
      text: e.kind === 'tool' ? (e.tool_name ?? e.label) : e.label,
      ...(note ? { note } : {}),
    });
  }
  return lines.sort((a, b) => a.ts - b.ts);
}
