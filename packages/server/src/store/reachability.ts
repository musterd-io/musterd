import {
  AvailabilitySchema,
  type DoorbellPolicy,
  type DoorbellPrefs,
  type EnforcementPolicy,
  matchEnforcement,
  resolveRoute,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { getDoorbellPolicy, memberDoorbellPrefs } from './doorbell.js';
import { listMembers } from './members.js';
import { hasLivePresence, listLiveDrivers } from './presence.js';
import { type MemberRow, resolveCapabilities } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * The reachability projection (ADR 153 §1) — the one derived fact that gates the top-tier hold. Computed
 * on demand from current team + policy state (admin roster ADR 145 §1, ambient presence ADR 057, the
 * enforcement policy ADR 150), exactly like the tier→timeout contract it rides beside: no new timer, no
 * stored field, re-checkable at the terminal moment.
 *
 * `unblocker_reachable(ask)` = (any admin human is present or notifiable) OR (a live teammate seat other
 * than the raiser exists AND the blocked action's class still has an open, sanctioned teammate-completable
 * route). The two terms are deliberately asymmetric (izzo's review, ADR 153 §1):
 *   - the **human term is a settle** — an admin can grant the authorization the gate exists to require;
 *   - the **teammate term is a route-around** — a teammate cannot grant a Gate B approval, only land the
 *     work by a path the gate does not cover (the pilot D5 local ff-merge), so it counts **iff** that
 *     path is open per item 2 (`gate-b-costly-action-local-merge-scope.md`). When item 2 closes the
 *     bypass for a class, the term drops and reachability collapses to human-only for it.
 */

/**
 * "Present or notifiable": an un-left admin human seat exists AND (it has live presence, OR a raised
 * blocking ask reaches it off-machine). Since ADR 443 "off-machine" is any admin whose doorbell route
 * carries a `slack` or `webhook` sink with a URL behind it — the team's, or their own personal one —
 * not only ADR 149's `ask_slack_webhook` (which `getDoorbellPolicy` reads through as the team slack
 * URL). A team with no admin human seat at all is unreachable on this term regardless of surfaces.
 */
export async function adminHumanReachable(
  db: Driver,
  teamId: string,
  presenceTimeoutMs: number,
): Promise<boolean> {
  const adminHumans = (await listMembers(db, teamId)).filter(
    (m) => m.kind === 'human' && resolveCapabilities(m).is_admin,
  );
  if (adminHumans.length === 0) return false;
  const doorbell = await getDoorbellPolicy(db, teamId);
  if (adminHumans.some((m) => hasOffMachineSink(doorbell, memberDoorbellPrefs(m)))) return true;
  for (const m of adminHumans) if (await hasLivePresence(db, m.id, presenceTimeoutMs)) return true;
  return false;
}

/** Would a blocking ring reach this human through a configured Slack or webhook URL? */
function hasOffMachineSink(policy: DoorbellPolicy, prefs: DoorbellPrefs | undefined): boolean {
  return resolveRoute(policy, prefs, 'blocking').some((sink) => {
    if (sink === 'slack') return Boolean(prefs?.sinks.slack?.url ?? policy.slack_url);
    if (sink === 'webhook') return Boolean(prefs?.sinks.webhook?.url ?? policy.webhook_url);
    return false;
  });
}

/** The self-set availability statuses that compose as `away` posture (ADR 044 ∩ ADR 138). */
const AWAY_AVAILABILITY = new Set(['away', 'dnd', 'off_hours']);

/** Defensive availability read off the raw row — malformed/legacy blobs degrade to implicit-available. */
function isSelfSetAway(m: MemberRow): boolean {
  if (!m.availability) return false;
  try {
    const parsed = AvailabilitySchema.safeParse(JSON.parse(m.availability)).data;
    return parsed ? AWAY_AVAILABILITY.has(parsed.status) : false;
  } catch {
    return false;
  }
}

/**
 * "Present": an admin human who composes as `working`/`idle` on the roster right now — a live
 * presence row **or** a live driver link (steering marks you present, ADR 155 Inc 1), and no self-set
 * `away`/`dnd`/`off_hours` (availability outranks activity, ADR 044/138). The ADR 155 Increment 2
 * modulation input: present → the agent waits the full hold window quietly (the loud surface waits
 * for the re-notify); not present → the loud surface fires at raise. Strictly narrower than
 * {@link adminHumanReachable}: presence shifts only *escalation-eagerness* — which surface fires when
 * — never a hold's absolute timeout or its `held`/`stranded` terminal (the ADR 153 ceiling).
 */
export async function adminHumanPresent(
  db: Driver,
  teamId: string,
  presenceTimeoutMs: number,
): Promise<boolean> {
  const adminHumans = (await listMembers(db, teamId)).filter(
    (m) => m.kind === 'human' && resolveCapabilities(m).is_admin,
  );
  if (adminHumans.length === 0) return false;
  const drivers = await listLiveDrivers(db, teamId, presenceTimeoutMs);
  for (const m of adminHumans) if (await isPresent(db, m, drivers, presenceTimeoutMs)) return true;
  return false;
}

/**
 * One human composes as present — the {@link adminHumanPresent} test for a single member. The
 * doorbell (ADR 443 §4) uses it for a ring directed at one human: their own presence, not any
 * admin's, decides whether the off-machine sinks stay quiet at raise.
 */
export async function humanPresent(
  db: Driver,
  teamId: string,
  m: MemberRow,
  presenceTimeoutMs: number,
): Promise<boolean> {
  return await isPresent(
    db,
    m,
    await listLiveDrivers(db, teamId, presenceTimeoutMs),
    presenceTimeoutMs,
  );
}

async function isPresent(
  db: Driver,
  m: MemberRow,
  drivers: Set<string>,
  presenceTimeoutMs: number,
): Promise<boolean> {
  return (
    !isSelfSetAway(m) &&
    ((await hasLivePresence(db, m.id, presenceTimeoutMs)) || drivers.has(m.name))
  );
}

/** The representative local-merge landing command the route-around probe matches against — the item-2
 *  teammate-completable path (a teammate lands the blocked push's work via a local merge). Probed, not
 *  hardcoded-open: the answer is read off the live enforcement policy every time.
 *
 *  Deliberately the **worst-case sibling-worktree form** (`git -C <main> merge …`), not the plain
 *  `git merge …`: that is the command a teammate actually runs to land the work when `main` lives in a
 *  sibling worktree, and it is the form the ADR 153 exercise showed slipping past a `git merge*` class.
 *  `normalizeCommand` lifts the `-C <path>` global off before matching, so this probe and a real landing
 *  command classify identically — the derived `unblocker_reachable` agrees with real enforcement by
 *  construction, and stays in agreement even if that normalization ever regressed (both would read the
 *  route OPEN together, never one CLOSED while the other is OPEN). */
const LOCAL_MERGE_PROBE = 'git -C ../main merge lane-branch';

/**
 * Is the teammate route-around still open (item 2)? Today no class gates local merges, so this returns
 * true; the moment the team declares a block-posture class matching the local-merge landing command, it
 * flips false and the teammate term drops — the two ADRs move together instead of contradicting.
 */
export function teammateRouteOpen(policy: EnforcementPolicy): boolean {
  const m = matchEnforcement(policy, { tool: 'Bash', command: LOCAL_MERGE_PROBE });
  return !m || m.cls.posture !== 'block';
}

/** A live agent seat other than the raiser — the body that could land the work if the route is open. */
export async function liveTeammateExists(
  db: Driver,
  teamId: string,
  raiser: string,
  presenceTimeoutMs: number,
): Promise<boolean> {
  for (const m of await listMembers(db, teamId)) {
    if (
      m.kind === 'agent' &&
      m.name !== raiser &&
      (await hasLivePresence(db, m.id, presenceTimeoutMs))
    )
      return true;
  }
  return false;
}

/** The full projection: human settle-term OR (live teammate AND open route-around). */
export async function unblockerReachable(
  db: Driver,
  teamId: string,
  raiser: string,
  presenceTimeoutMs: number,
): Promise<boolean> {
  if (await adminHumanReachable(db, teamId, presenceTimeoutMs)) return true;
  return (
    (await liveTeammateExists(db, teamId, raiser, presenceTimeoutMs)) &&
    teammateRouteOpen((await getPolicy(db, teamId)).enforcement)
  );
}
