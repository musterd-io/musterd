import { askContract, makeEnvelope, type AskContract, type Envelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { parseDuration } from '../service/hold.js';

/**
 * Spend approval (ADR 636). The host reads `spend_approval_usd` once at wake start and, for a
 * non-human seat, arms the metering gateway. When running cost reaches the threshold the gateway
 * holds the next provider call and this module sends one blocking approve ask. Accept forwards
 * that call and the rest of the wake. Decline refuses further calls. Silence records `ask.held`
 * and re-notifies (ADR 147); the call stays held. The gateway holds no credential and this module
 * never puts a prompt or a provider payload in the ask.
 */

/** The supplementary `residency.wake_cost` detail when the wake ends during the hold. */
export const SPEND_APPROVAL_WAKE_ENDED = 'wake ended during the spend approval hold';

/** How often the seat inbox is polled while a call is held. */
const POLL_MS = 1_000;

export type SpendApprovalVerdict = 'accept' | 'decline' | 'wake_ended';

/** The seat-credential client the waiter drives. Tests inject it; the loop builds the real one. */
export interface SpendApprovalSeat {
  send(envelope: Envelope): Promise<{ ask_contract?: AskContract }>;
  inbox(): Promise<{ messages: Envelope[] }>;
}

/** ADR 672: the threshold as the order carries it (`spend_approval_usd`, agent/service seats only
 *  — the daemon applies ADR 636 §1); absent or not a positive finite number arms nothing. */
export function armSpendApproval(threshold: number | undefined): number | undefined {
  if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) return undefined;
  return threshold;
}

/** Seat, lease, spent dollars, threshold, and the lane when the wake has one. */
export function spendApprovalAskBody(input: {
  seat: string;
  leaseId: string;
  spentUsd: number;
  thresholdUsd: number;
  laneId?: string | undefined;
}): string {
  const money = (n: number) => `$${n.toFixed(4)}`;
  const lane = input.laneId ? `, lane ${input.laneId}` : '';
  return (
    `${input.seat} lease ${input.leaseId} spent ${money(input.spentUsd)}, ` +
    `approval ${money(input.thresholdUsd)}${lane}`
  );
}

export interface AwaitSpendApprovalInput {
  team: string;
  from: string;
  seat: string;
  leaseId: string;
  spentUsd: number;
  thresholdUsd: number;
  laneId?: string | undefined;
  signal: AbortSignal;
  seatClient: SpendApprovalSeat;
  /** One narrator line when the ask cannot be sent — the verdict is `decline` either way, and a
   *  decline with no reason in `host.log` is what hid the ADR 672 gap for a week. */
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  mintId?: () => string;
}

function extendMs(until: unknown, windowMs: number): number {
  if (typeof until !== 'string' || until === 'indefinite') return windowMs;
  return parseDuration(until) ?? windowMs;
}

function answersAsk(env: Envelope, askId: string): boolean {
  if (env.act !== 'accept' && env.act !== 'decline' && env.act !== 'wait') return false;
  const meta = env.meta ?? {};
  return meta['in_reply_to'] === askId || meta['ask_ref'] === askId;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One blocking approve ask for this wake. Resolves on accept, decline, or the wake ending.
 * A `wait` extends the clock. On the blocking timeout the seat records `ask.held`, re-notifies
 * with a message (a second ask is not sent), and the call stays held. The host must abort
 * `signal` when the wake ends; this function then returns `wake_ended`.
 */
export async function awaitSpendApproval(
  input: AwaitSpendApprovalInput,
): Promise<SpendApprovalVerdict> {
  if (input.signal.aborted) return 'wake_ended';
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = input.pollMs ?? POLL_MS;
  const mintId = input.mintId ?? ulid;
  const body = spendApprovalAskBody(input);
  const askId = mintId();
  let windowMs = askContract('blocking').timeout_ms;
  try {
    const ack = await input.seatClient.send(
      makeEnvelope({
        id: askId,
        team: input.team,
        from: input.from,
        to: { kind: 'team' },
        act: 'ask',
        body,
        meta: { species: 'approve', tier: 'blocking' },
      }),
    );
    if (ack.ask_contract && ack.ask_contract.timeout_ms > 0) windowMs = ack.ask_contract.timeout_ms;
  } catch (err) {
    if (input.signal.aborted) return 'wake_ended';
    input.log?.(
      `spend approval ask failed for ${input.seat} (lease ${input.leaseId}) — declining: ` +
        `${(err as Error).message}`,
    );
    return 'decline';
  }
  if (input.signal.aborted) return 'wake_ended';

  const seenWaits = new Set<string>();
  let deadline = now() + windowMs;
  while (!input.signal.aborted) {
    let messages: Envelope[] = [];
    try {
      messages = (await input.seatClient.inbox()).messages;
    } catch {
      messages = [];
    }
    if (input.signal.aborted) return 'wake_ended';
    const replies = messages.filter((m) => answersAsk(m, askId));
    const terminal = replies.find((m) => m.act === 'accept' || m.act === 'decline');
    if (terminal?.act === 'accept' || terminal?.act === 'decline') return terminal.act;
    for (const reply of replies) {
      if (reply.act !== 'wait' || seenWaits.has(reply.id)) continue;
      seenWaits.add(reply.id);
      deadline = now() + extendMs(reply.meta?.['until'], windowMs);
    }
    if (now() >= deadline) {
      // ADR 147: record held, re-notify, stay paused. Proceeding here would put ask.held
      // before the call went out.
      try {
        await input.seatClient.send(
          makeEnvelope({
            id: mintId(),
            team: input.team,
            from: input.from,
            to: { kind: 'team' },
            act: 'status_update',
            body,
            meta: { ask_ref: askId, ask_outcome: 'held' },
          }),
        );
        await input.seatClient.send(
          makeEnvelope({
            id: mintId(),
            team: input.team,
            from: input.from,
            to: { kind: 'team' },
            act: 'message',
            body,
          }),
        );
      } catch {
        /* the call stays held; the next window tries the record again */
      }
      deadline = now() + windowMs;
    }
    try {
      const waitFor = Math.min(pollMs, Math.max(0, deadline - now()));
      await sleep(waitFor, input.signal);
    } catch {
      return 'wake_ended';
    }
  }
  return 'wake_ended';
}
