import {
  foldPulseKind,
  projectPulse,
  PULSE_WINDOW_MS,
  type PulseInput,
  type SeatPulseFrame,
  type TraceEvent,
} from '@musterd/protocol';

/**
 * ADR 660: a seat's tool-call heartbeat. Each seat's harness tool calls from the last
 * `PULSE_WINDOW_MS` are kept in an in-memory ring, keyed by (team, seat), and pushed to firehose
 * subscribers as one coalesced `seat_pulse` at most every `PULSE_MIN_GAP_MS`. The first call into
 * a quiet ring arms the one timer. When the timer fires, the window is projected and pushed, and
 * nothing is re-armed until the next call. An idle seat sends nothing; silence is the idle signal,
 * and the client decays on `ts`. Nothing is persisted. Frames carry counts and kinds only: no
 * tool name, path, command, session or agent id ever leaves this module.
 */

/** The coalescing gap: one pulse per seat per this many ms, at most. */
export const PULSE_MIN_GAP_MS = 5_000;

/** A ceiling on one seat's ring, so a flooding tap costs bounded memory; far above any real cadence. */
const PULSE_RING_CAP = 2_048;

/** Only completed harness tool calls count, each once by its `tool_use_id` (ADR 660). */
const PULSE_EVENT_KINDS: ReadonlySet<string> = new Set(['PostToolUse', 'PostToolUseFailure']);

export interface SeatPulsesDeps {
  now: () => number;
  /** Run `fn` after `ms`; returns its cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
  push: (teamId: string, frame: SeatPulseFrame) => void;
}

interface SeatRing {
  ring: PulseInput[];
  cancel: (() => void) | null;
}

export class SeatPulses {
  private readonly teams = new Map<string, Map<string, SeatRing>>();

  constructor(private readonly deps: SeatPulsesDeps) {}

  /** Feed one ingested trace batch for `seat`; anything that is not a counted tool call is ignored. */
  feed(teamId: string, seat: string, events: readonly TraceEvent[]): void {
    const inputs: PulseInput[] = [];
    for (const ev of events) {
      if (!PULSE_EVENT_KINDS.has(ev.kind) || !ev.tool_use_id) continue;
      inputs.push({
        tool_use_id: ev.tool_use_id,
        ts: ev.ts,
        kind: foldPulseKind(ev.harness, ev.tool_name ?? 'other'),
      });
    }
    if (inputs.length === 0) return;
    let seats = this.teams.get(teamId);
    if (!seats) {
      seats = new Map();
      this.teams.set(teamId, seats);
    }
    let entry = seats.get(seat);
    if (!entry) {
      entry = { ring: [], cancel: null };
      seats.set(seat, entry);
    }
    entry.ring.push(...inputs);
    this.trim(entry);
    if (!entry.cancel) {
      const armed = entry;
      armed.cancel = this.deps.schedule(() => this.fire(teamId, seat, armed), PULSE_MIN_GAP_MS);
    }
  }

  /** The current pulse of every seat on `teamId` with calls in the window, for a new subscriber. */
  snapshot(teamId: string): SeatPulseFrame[] {
    const seats = this.teams.get(teamId);
    if (!seats) return [];
    const frames: SeatPulseFrame[] = [];
    for (const [seat, entry] of seats) {
      this.trim(entry);
      if (entry.ring.length === 0) {
        if (!entry.cancel) seats.delete(seat);
        continue;
      }
      const frame = this.frame(seat, entry);
      if (frame) frames.push(frame);
    }
    if (seats.size === 0) this.teams.delete(teamId);
    return frames;
  }

  /** Cancel every armed timer (daemon shutdown). */
  dispose(): void {
    for (const seats of this.teams.values()) {
      for (const entry of seats.values()) {
        entry.cancel?.();
        entry.cancel = null;
      }
    }
    this.teams.clear();
  }

  private fire(teamId: string, seat: string, entry: SeatRing): void {
    entry.cancel = null;
    this.trim(entry);
    const frame = this.frame(seat, entry);
    if (frame) this.deps.push(teamId, frame);
    else if (this.teams.get(teamId)?.get(seat) === entry) this.teams.get(teamId)!.delete(seat);
  }

  private frame(seat: string, entry: SeatRing): SeatPulseFrame | null {
    const now = this.deps.now();
    const pulse = projectPulse(entry.ring, now);
    if (pulse.intensity <= 0) return null;
    return {
      type: 'seat_pulse',
      member: seat,
      ts: now,
      intensity: pulse.intensity,
      kind: pulse.kind,
      last_ts: pulse.last_ts,
    };
  }

  /** Drop calls older than the window (`ts` is the producing machine's, so not assumed sorted). */
  private trim(entry: SeatRing): void {
    const floor = this.deps.now() - PULSE_WINDOW_MS;
    entry.ring = entry.ring.filter((input) => input.ts >= floor);
    if (entry.ring.length > PULSE_RING_CAP) entry.ring = entry.ring.slice(-PULSE_RING_CAP);
  }
}
