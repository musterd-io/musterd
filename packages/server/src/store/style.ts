import {
  type ResolvedStyle,
  type StyleEnvelope,
  type StylePolicy,
  type StylePrefs,
  StylePrefsSchema,
  renderStyleBlock,
  resolveStyle,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { appendReplicatedEvent } from './audit.js';
import { listMembers } from './members.js';
import type { MemberRow } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * Agent style, server half (ADR 514): a human's own dials live on `members.style_prefs`, daemon-local
 * like `doorbell_prefs` (ADR 443); the floor and team defaults are `policy.style`. Resolution is
 * protocol's `resolveStyle`, called by the route and the roster with what this file reads.
 */

/** A member's own style prefs; a malformed blob reads as none (team defaults). Agents have none. */
export function memberStylePrefs(
  m: Pick<MemberRow, 'kind' | 'style_prefs'>,
): StylePrefs | undefined {
  if (m.kind !== 'human' || !m.style_prefs) return undefined;
  try {
    return StylePrefsSchema.safeParse(JSON.parse(m.style_prefs)).data;
  } catch {
    return undefined;
  }
}

export async function setStylePrefs(
  db: Driver,
  memberId: string,
  prefs: StylePrefs,
): Promise<void> {
  await db.run('UPDATE members SET style_prefs = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(prefs),
    Date.now(),
    memberId,
  ]);
}

/**
 * The hub-side write (ADR 514, lane 01M46RWP23): the prefs row and, in the same transaction, the
 * replicated `style.prefs` event every node folds into its own `members.style_prefs`. Replace
 * semantics all the way through, as the route has them. A daemon with no local node for the team
 * (never enrolled, never messaged) cannot allocate a seq; its row still lands, unreplicated —
 * the `appendAudit` fallback, and the state every single-machine team is in.
 */
export async function applyStylePrefs(
  db: Driver,
  teamId: string,
  member: Pick<MemberRow, 'id' | 'name'>,
  prefs: StylePrefs,
): Promise<void> {
  try {
    await db.tx(async (t) => {
      await setStylePrefs(t, member.id, prefs);
      await appendReplicatedEvent(t, teamId, {
        actor: member.name,
        action: 'style.prefs',
        target: null,
        result: 'allow',
        detail: { prefs },
      });
    });
  } catch (err) {
    log.warn({ msg: 'style_prefs_stamp_failed', actor: member.name, err: String(err) });
    await setStylePrefs(db, member.id, prefs);
  }
}

/** The team's effective style policy — floor, default dials, team prose (dense, ADR 185 read side). */
export async function teamStyle(db: Driver, teamId: string): Promise<StylePolicy> {
  return (await getPolicy(db, teamId)).style;
}

/** The driver a seat's newest live presence attested, if any (driver co-presence, ADR 021/155).
 *  Rows with no driver (an ambient touch, a bare `POST /presence`) are skipped, not read as none. */
export async function driverForSeat(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<string | null> {
  const row = await db.get<{ driver: string | null }>(
    'SELECT driver FROM presence WHERE team_id = ? AND member_id = ? AND held_until IS NULL AND driver IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
    [teamId, memberId],
  );
  return row?.driver ?? null;
}

/**
 * Whose block a caller gets — ONE rule for every route (review I5): a human (not an observer) gets
 * their own; a seat gets the driver it claimed with, else the one its live presence attested; a
 * null here means "the only-human rule, else team defaults" in {@link styleEnvelopeFor}. The claimed
 * driver is self-declared and recorded, never verified (ADR 514 Consequences, 2026-10-05).
 */
export async function styleDriverFor(
  db: Driver,
  teamId: string,
  member: Pick<MemberRow, 'id' | 'name' | 'kind' | 'observer'>,
  claimed: string | null,
): Promise<string | null> {
  if (member.kind === 'human' && member.observer !== 1) return member.name;
  return claimed ?? (await driverForSeat(db, teamId, member.id));
}

/**
 * The envelope a seat reads (ADR 514 inc 3, spec §4.3): the named driver's dials when they are a
 * human member; otherwise — no driver, or a name that is not a human member — the team's only
 * human; otherwise team defaults, and the block says why (unbound, or several humans). Observer
 * seats (the `/live` wall, watch links) are not humans here. The epoch is the chosen human's, else
 * the team's.
 */
export async function styleEnvelopeFor(
  db: Driver,
  teamId: string,
  driver: string | null,
): Promise<StyleEnvelope> {
  return styleEnvelopeFrom(await teamStyle(db, teamId), await styleHumans(db, teamId), driver);
}

/** The humans the only-human rule counts: on the team, not observers (review I4). */
export async function styleHumans(db: Driver, teamId: string): Promise<MemberRow[]> {
  return styleHumansOf(await listMembers(db, teamId));
}

/** {@link styleHumans} over members already loaded — the roster has them from `listPresence`. */
export function styleHumansOf(members: MemberRow[]): MemberRow[] {
  return members.filter((m) => m.kind === 'human' && m.observer !== 1 && m.left_at === null);
}

/**
 * The pure core of {@link styleEnvelopeFor}: the same rule over an already-loaded policy and human
 * list, so the roster (ADR 514 inc 4) can stamp every row's current epoch from one read of each.
 */
export function styleEnvelopeFrom(
  policy: StylePolicy,
  humans: MemberRow[],
  driver: string | null,
): StyleEnvelope {
  const team = resolveStyle(policy);
  const chosen = chosenHuman(humans, driver);
  if (chosen) {
    const style = resolveStyle(policy, memberStylePrefs(chosen));
    return {
      block: renderStyleBlock({ team, driver: { name: chosen.name, style } }),
      epoch: style.epoch,
      dials: style.dials,
      driver: chosen.name,
    };
  }
  const no_driver = humans.length > 1 ? 'several_humans' : 'unbound';
  return {
    block: renderStyleBlock({ team, no_driver }),
    epoch: team.epoch,
    dials: team.dials,
    driver: null,
  };
}

/** The human whose dials a seat gets: the named driver, else the team's only human. */
function chosenHuman(humans: MemberRow[], driver: string | null): MemberRow | undefined {
  const named = driver ? humans.find((m) => m.name === driver) : undefined;
  return named ?? (humans.length === 1 ? humans[0] : undefined);
}

/** Resolve a member's style (none: team defaults), as `resolveStyle(policy, memberStylePrefs(m))`. */
export type StyleResolver = (
  m: Pick<MemberRow, 'kind' | 'style_prefs'> | undefined,
) => ResolvedStyle;

/**
 * A {@link StyleResolver} that resolves each distinct input once (lane 01M4GQ2G7B): the roster
 * resolved and hashed a style per row, twice per human row, and nearly every agent row lands on the
 * same team defaults — 4.8 points of the app core at plateau (run 28). Keyed on the only member
 * fields `resolveStyle` reads, so it is correct for one policy; build one per request.
 */
export function styleResolver(policy: StylePolicy): StyleResolver {
  const cache = new Map<string, ResolvedStyle>();
  return (m) => {
    const key = m?.kind === 'human' ? (m.style_prefs ?? '') : '';
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = resolveStyle(policy, m ? memberStylePrefs(m) : undefined);
      cache.set(key, resolved);
    }
    return resolved;
  };
}

/**
 * The current style epoch a roster row should show (ADR 514 inc 4, spec §4.4 "Attestation"): a
 * human's own resolved style; an agent's is what its seat should attest — the driver its newest
 * live presence named, else the only-human rule, else team defaults — the `/style-block` rule, so
 * the roster's `style stale` and the adapter's change line can never disagree.
 */
export function currentStyleEpochFor(
  policy: StylePolicy,
  humans: MemberRow[],
  member: Pick<MemberRow, 'name' | 'kind' | 'observer'>,
  presenceDriver: string | null,
  resolve: StyleResolver = styleResolver(policy),
): string {
  if (member.kind === 'human' && member.observer !== 1) {
    return resolve(humans.find((m) => m.name === member.name)).epoch;
  }
  // The epoch alone: `styleEnvelopeFrom(...).epoch` rendered the whole block and resolved the team
  // style a second time for every agent row, only to throw both away (lane 01M477S003).
  return resolve(chosenHuman(humans, presenceDriver)).epoch;
}
