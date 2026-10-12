import {
  type Envelope,
  type Hearing,
  IDLE_BUSY_HOLD_MS,
  IDLE_BUSY_RECHECK_MS,
  IDLE_COALESCE_MS,
  IDLE_DEAF_AFTER_MS,
  IDLE_KEYBOARD_GUARD_MS,
  IDLE_QUIET_MS,
  IDLE_SENDER_CAP_PER_HOUR,
  IDLE_SESSION_CAP_PER_HOUR,
  type IdleWakeReport,
  type IdleWakeState,
  idleMayRing,
  isPushableLine,
} from '@musterd/protocol';
import type { InjectAdapter } from './inject.js';

const HOUR = 3_600_000;
/** After a failed inject the session is deaf; it tries again no sooner than this. A refused socket
 *  costs nothing to retry, but each attempt is an audit row, and a deaf session must not write one
 *  per ring. */
export const IDLE_RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** What `seam=idle` answered: a line to push, the seat's switch off, or nothing to say. */
export type IdleCheck = { line: string; act: string; from: string } | { off: true } | null;

export interface IdleWakeDeps {
  seat: () => string | null;
  adapter: () => InjectAdapter;
  /** `.musterd/idle-wake.json` — turn markers and the session switch. */
  readState: () => IdleWakeState;
  /** `MUSTERD_IDLE_WAKE=off` in the adapter's environment at launch. */
  envSwitchOff: boolean;
  /** MCP tool calls running in this adapter right now. */
  inFlight: () => number;
  transcriptMtime: () => number | undefined;
  /** `GET …/inbox/interrupt-check?seam=idle`. */
  check: () => Promise<IdleCheck>;
  /** Fire-and-forget `POST …/inbox/idle-wake`. */
  report: (r: IdleWakeReport) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

/**
 * The idle-wake core (ADR 558 §2–4). Pure over its deps so every guard is testable on a fake clock:
 * the daemon decides WHAT rings (`seam=idle`), this decides WHEN — from evidence only this machine
 * has. Every failure is silence: the boundary seams still carry the act at the next tool call.
 */
export class IdleWake {
  private timer: { cancel(): void } | null = null;
  private pending: { id: string; from: string }[] = [];
  private readonly injects: { at: number; from: string }[] = [];
  /** Why this session cannot be pushed, when it learned so itself (the probe is asked fresh). */
  private deaf: { reason: string; at: number } | null = null;
  private watch: { cancel(): void } | null = null;
  private firing = false;
  /** When the session was first found busy with acts still waiting; null when it is not. */
  private busySince: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<IdleWakeDeps['setTimer']>;

  constructor(private readonly deps: IdleWakeDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return { cancel: () => clearTimeout(h) };
      });
  }

  /** Every directed act the socket delivers. Cheap pre-filter; the daemon is the authority. */
  onDeliver(env: Envelope): void {
    const seat = this.deps.seat();
    if (!seat || !idleMayRing(env, seat)) return;
    this.pending.push({ id: env.id, from: env.from });
    this.arm();
  }

  /** First join and every reconnect: acts that landed while the socket was down get one check. */
  onConnected(): void {
    this.arm();
  }

  hearing(): { hearing: Hearing; reason?: string } {
    if (this.switchedOff()) return { hearing: 'deaf', reason: 'switch-off' };
    this.recover();
    if (this.deaf) return { hearing: 'deaf', reason: this.deaf.reason };
    const p = this.deps.adapter().probe();
    return p.ready ? { hearing: 'idle' } : { hearing: 'deaf', reason: p.reason };
  }

  armed(): boolean {
    return this.hearing().hearing === 'idle';
  }

  private switchedOff(): boolean {
    return this.deps.envSwitchOff || this.deps.readState().switch === 'off';
  }

  /** `no-turn-after-inject` clears once the transcript moves past the inject (the session did take
   *  a turn — late, or after a dialog closed). The other reasons clear where they are learned. */
  private recover(): void {
    if (this.deaf?.reason !== 'no-turn-after-inject') return;
    const m = this.deps.transcriptMtime();
    if (m !== undefined && m > this.deaf.at) this.deaf = null;
  }

  private arm(ms: number = IDLE_COALESCE_MS): void {
    if (this.timer) return; // already coalescing: the burst becomes one line
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.fire();
    }, ms);
  }

  /**
   * The session was busy: keep what waits and look again, for up to `IDLE_BUSY_HOLD_MS`. This is
   * what rings an act that landed mid-turn with no tool boundary after it, once the turn ends. A
   * re-look costs a file read until the session is idle; the daemon is asked only then, and drops
   * whatever a boundary seam delivered in the meantime.
   */
  private hold(pending: { id: string; from: string }[]): void {
    const now = this.now();
    this.busySince ??= now;
    if (now - this.busySince >= IDLE_BUSY_HOLD_MS) {
      this.busySince = null;
      return;
    }
    this.pending = [...pending, ...this.pending];
    this.arm(IDLE_BUSY_RECHECK_MS);
  }

  /**
   * Idle = no tool call in flight, the last turn has stopped, the human has not prompted within the
   * keyboard guard, and the transcript has been quiet ≥ 15 s. With no evidence at all — no markers
   * and no transcript — it is not idle: the guards cannot run, so nothing is pushed.
   */
  private idle(state: IdleWakeState, now: number): boolean {
    if (this.deps.inFlight() > 0) return false;
    const { last_prompt_at: p, last_stop_at: s } = state;
    if (p !== undefined && (s === undefined || p > s)) return false; // a turn is running
    if (p !== undefined && now - p < IDLE_KEYBOARD_GUARD_MS) return false;
    const m = this.deps.transcriptMtime();
    if (m === undefined) return p !== undefined || s !== undefined;
    return now - m >= IDLE_QUIET_MS;
  }

  private capFor(from: readonly string[], now: number): 'sender' | 'session' | null {
    const recent = this.injects.filter((i) => now - i.at < HOUR);
    if (recent.length >= IDLE_SESSION_CAP_PER_HOUR) return 'session';
    if (
      from.length > 0 &&
      from.every((f) => recent.filter((i) => i.from === f).length >= IDLE_SENDER_CAP_PER_HOUR)
    )
      return 'sender';
    return null;
  }

  private async fire(): Promise<void> {
    if (this.firing) return void this.arm(); // one inject at a time; look again after this one
    const pending = this.pending;
    this.pending = [];
    this.firing = true;
    try {
      if ((await this.fireOnce(pending)) === 'busy') this.hold(pending);
      else this.busySince = null;
    } catch {
      // fail-open by contract: the boundary seams still carry the act
    } finally {
      this.firing = false;
    }
  }

  private async fireOnce(pending: { id: string; from: string }[]): Promise<'busy' | undefined> {
    if (this.switchedOff()) return;
    const now = this.now();
    this.recover();
    if (this.deaf?.reason === 'no-turn-after-inject') return;
    if (this.deaf && this.deaf.reason !== 'policy-off') {
      if (now - this.deaf.at < IDLE_RETRY_AFTER_FAILURE_MS) return;
    }
    if (!this.idle(this.deps.readState(), now)) return 'busy';
    const adapter = this.deps.adapter();
    if (!adapter.probe().ready) return;
    // A cap known before asking keeps the daemon from recording a raise nobody will hear.
    const early = this.capFor(
      pending.map((p) => p.from),
      now,
    );
    const last = pending[pending.length - 1];
    if (early && last) {
      this.deps.report({ act: last.id, outcome: 'capped', harness: adapter.harness, cap: early });
      return;
    }
    const res = await this.deps.check();
    if (res === null) {
      if (this.deaf?.reason === 'policy-off') this.deaf = null;
      return;
    }
    if ('off' in res) {
      this.deaf = { reason: 'policy-off', at: now };
      return;
    }
    if (this.deaf?.reason === 'policy-off') this.deaf = null;
    const cap = this.capFor([res.from], now);
    if (cap) {
      this.deps.report({ act: res.act, outcome: 'capped', harness: adapter.harness, cap });
      return;
    }
    // Defence in depth (ADR 558): what is pushed becomes a USER-role turn, so it must be what the
    // daemon composes — one short printable line. Anything else is not pushed and not retried.
    if (!isPushableLine(res.line)) {
      this.deps.report({
        act: res.act,
        outcome: 'failed',
        harness: adapter.harness,
        reason: 'line-shape',
      });
      return;
    }
    const r = await adapter.inject(res.line);
    // The harness saw a turn running that this machine's evidence missed: not a failure, and not
    // deaf. Nothing was pushed; look again as for any busy session.
    if (!r.ok && r.reason === 'busy') return 'busy';
    if (!r.ok) {
      this.deaf = { reason: r.reason, at: now };
      this.deps.report({
        act: res.act,
        outcome: 'failed',
        harness: adapter.harness,
        reason: r.reason,
      });
      return;
    }
    this.injects.push({ at: now, from: res.from });
    this.deaf = null;
    this.deps.report({ act: res.act, outcome: 'injected', harness: adapter.harness });
    this.watchForTurn(now);
  }

  /** No transcript movement within 60 s of an ok inject → deaf until the transcript moves. */
  private watchForTurn(injectedAt: number): void {
    this.watch?.cancel();
    this.watch = this.setTimer(() => {
      this.watch = null;
      const m = this.deps.transcriptMtime();
      if (m === undefined || m <= injectedAt)
        this.deaf = { reason: 'no-turn-after-inject', at: injectedAt };
    }, IDLE_DEAF_AFTER_MS);
  }
}
