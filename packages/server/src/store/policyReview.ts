import { POLICY_REVIEW_DEFAULT_MS, type PolicyOverride, makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { joinerEnrollment, policyAtHub } from '../sync/claim.js';
import { appendAudit, listAudit } from './audit.js';
import { addMember, getMemberByName } from './members.js';
import { type MessageRow, resolveCapabilities, type MemberRow, type TeamRow } from './rows.js';
import { applyPolicyChange, getStoredPolicy, getTeamById, listActiveTeams } from './teams.js';

/** The service seat that asks (ADR 232: a ledger seat, never a lane owner), as the digest has one. */
export const POLICY_REVIEW_SEAT = 'policy';

/** The sweep's cadence. A review date is a day, so an hour is well inside its precision. */
export const POLICY_REVIEW_TICK_MS = 3600_000;
const FIRST_DELAY_MS = 60_000;

/** The server-controlled marker on the ask (stripped off any client copy, the ADR 225 rule). */
export interface PolicyReviewMeta {
  review_by: number;
  keys: string[];
}

/**
 * ADR 533: a stored team policy doc whose `review_by` has passed and whose ask has not been raised
 * yet. One ask per review date: `policy.review_due` with that `review_by` is the receipt, so a
 * daemon that ticks hourly asks once, and a re-confirm (which moves the date) makes the next one due
 * on its own schedule.
 */
export async function policyReviewDue(
  db: Driver,
  teamId: string,
  now: number,
): Promise<{ stored: PolicyOverride; review_by: number } | null> {
  const stored = await getStoredPolicy(db, teamId);
  if (stored.review_by === undefined || stored.review_by > now) return null;
  const asked = (await listAudit(db, teamId)).some(
    (r) =>
      r.action === 'policy.review_due' &&
      typeof r.detail === 'string' &&
      (JSON.parse(r.detail) as { review_by?: number }).review_by === stored.review_by,
  );
  return asked ? null : { stored, review_by: stored.review_by };
}

async function reviewSeat(db: Driver, team: TeamRow): Promise<MemberRow | null> {
  const existing = await getMemberByName(db, team.id, POLICY_REVIEW_SEAT);
  if (existing) return existing.kind === 'service' && existing.left_at === null ? existing : null;
  return (await addMember(db, team, { name: POLICY_REVIEW_SEAT, kind: 'service' })).row;
}

const clockDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Raise the review ask for one team: an `ask` (species `approve`, standard tier) from the `policy`
 * service seat to the Team — a non-directed ask rings the admin humans (ADR 443) — naming the knobs
 * the doc holds and what each answer does. `send` is how the act is stored and delivered
 * (`routeEnvelope` on the daemon); omitted, nothing is sent and only the receipt is written (tests
 * of the sweep itself). Returns the ask id, or null when nothing was due.
 */
export async function raisePolicyReview(
  db: Driver,
  team: TeamRow,
  now: number,
  send?: (from: MemberRow, env: ReturnType<typeof makeEnvelope>) => Promise<MessageRow>,
): Promise<string | null> {
  const due = await policyReviewDue(db, team.id, now);
  if (!due) return null;
  const from = await reviewSeat(db, team);
  if (!from) {
    log.warn({ msg: 'policy_review_seat_taken', team: team.slug, seat: POLICY_REVIEW_SEAT });
    return null;
  }
  const { review_by: _rb, ...knobs } = due.stored;
  const keys = Object.keys(knobs).sort();
  const policy_review: PolicyReviewMeta = { review_by: due.review_by, keys };
  const env = makeEnvelope({
    id: ulid(),
    team: team.slug,
    from: from.name,
    to: { kind: 'team' },
    act: 'ask',
    body:
      `[policy] the team policy passed its review date (${clockDate(due.review_by)}). ` +
      `Set: ${keys.join(', ')}. Accept to keep it for another ${Math.round(POLICY_REVIEW_DEFAULT_MS / 86_400_000)} days; ` +
      `decline to drop every knob and return to the defaults. \`musterd team policy\` shows the values; ` +
      `\`musterd team policy --review-by <date>\` picks a date of your own.`,
    meta: { species: 'approve', tier: 'standard', policy_review },
    ts: now,
  });
  if (send) await send(from, env);
  await appendAudit(db, team.id, {
    actor: null,
    action: 'policy.review_due',
    target: null,
    result: 'allow',
    detail: { review_by: due.review_by, ask: env.id, keys },
  });
  return env.id;
}

/**
 * A human admin's `accept` or `decline` naming a review ask IS the answer (the ADR 516 increment 3
 * shape): accept re-stamps `review_by` to the default window from now, keeping every knob; decline
 * stores `{}`, so every default comes back to life. Anyone else's reply, or a second answer, changes
 * nothing. The write rides `applyPolicyChange` as the human — the same `policy.change` every machine
 * folds — forwarded to the hub when this daemon is a joiner. Returns what happened, for the caller's
 * announcement, or null.
 */
export async function answerPolicyReview(
  db: Driver,
  team: TeamRow,
  decider: MemberRow,
  askId: string,
  act: 'accept' | 'decline',
  now: number = Date.now(),
): Promise<{ verdict: 'confirmed' | 'dropped'; review_by: number | null } | null> {
  if (decider.kind !== 'human' || !resolveCapabilities(decider).is_admin) return null;
  const ask = await db.get<MessageRow>(
    "SELECT * FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'",
    [team.id, askId],
  );
  if (!ask?.meta) return null;
  const meta = JSON.parse(ask.meta) as { policy_review?: PolicyReviewMeta };
  if (!meta.policy_review) return null;
  const answered = (await listAudit(db, team.id)).some(
    (r) =>
      r.action === 'policy.review_answered' &&
      typeof r.detail === 'string' &&
      (JSON.parse(r.detail) as { ask?: string }).ask === askId,
  );
  if (answered) return null;
  const stored = await getStoredPolicy(db, team.id);
  const { review_by: _rb, ...knobs } = stored;
  const next: PolicyOverride =
    act === 'accept' ? { ...knobs, review_by: now + POLICY_REVIEW_DEFAULT_MS } : {};
  const enrollment = await joinerEnrollment(db, team.id, team.slug);
  const applied = enrollment
    ? await policyAtHub(enrollment, team.slug, { actor: decider.name, policy: next })
    : await applyPolicyChange(db, team.id, decider.name, next);
  const verdict = act === 'accept' ? 'confirmed' : 'dropped';
  await appendAudit(db, team.id, {
    actor: decider.name,
    action: 'policy.review_answered',
    target: null,
    result: 'allow',
    detail: { ask: askId, verdict, review_by: applied.stored.review_by ?? null },
  });
  return { verdict, review_by: applied.stored.review_by ?? null };
}

/**
 * The hourly sweep (hub only: policy is hub-authoritative, and a joiner asking too would ask twice).
 * Returns the number of asks raised.
 */
export async function policyReviewTick(
  db: Driver,
  now = Date.now(),
  send?: Parameters<typeof raisePolicyReview>[3],
): Promise<number> {
  let raised = 0;
  for (const { id } of await listActiveTeams(db)) {
    const team = await getTeamById(db, id);
    if (!team || (await joinerEnrollment(db, team.id, team.slug))) continue;
    if (await raisePolicyReview(db, team, now, send)) raised++;
  }
  return raised;
}

export function startPolicyReviewSweep(
  db: Driver,
  send: Parameters<typeof raisePolicyReview>[3],
  onError: (err: unknown) => void,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await policyReviewTick(db, Date.now(), send);
      if (n > 0) log.info({ msg: 'policy_review_asked', count: n });
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
  first.unref?.();
  const every = setInterval(() => void tick(), POLICY_REVIEW_TICK_MS);
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
