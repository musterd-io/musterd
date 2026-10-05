import {
  type StyleEnvelope,
  type StylePolicy,
  type StylePrefs,
  StylePrefsSchema,
  renderStyleBlock,
  resolveStyle,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { listMembers } from './members.js';
import type { MemberRow } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * Agent style, server half (ADR 514): a human's own dials live on `members.style_prefs`, daemon-local
 * like `doorbell_prefs` (ADR 443); the floor and team defaults are `policy.style`. Resolution is
 * protocol's `resolveStyle`, called by the route and the roster with what this file reads.
 */

/** A member's own style prefs; a malformed blob reads as none (team defaults). Agents have none. */
export function memberStylePrefs(m: MemberRow): StylePrefs | undefined {
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

/** The team's effective style policy — floor, default dials, team prose (dense, ADR 185 read side). */
export async function teamStyle(db: Driver, teamId: string): Promise<StylePolicy> {
  return (await getPolicy(db, teamId)).style;
}

/** The driver of a seat's newest live presence, if any (driver co-presence, ADR 021/155). */
export async function driverForSeat(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<string | null> {
  const row = await db.get<{ driver: string | null }>(
    'SELECT driver FROM presence WHERE team_id = ? AND member_id = ? AND held_until IS NULL ORDER BY last_seen_at DESC LIMIT 1',
    [teamId, memberId],
  );
  return row?.driver ?? null;
}

/**
 * The envelope a seat reads (ADR 514 inc 3, spec §4.3): the named driver's dials when they are a
 * human member; with no driver, the team's only human; otherwise team defaults, and the block says
 * why (unbound, or several humans). The epoch is the chosen human's, else the team's.
 */
export async function styleEnvelopeFor(
  db: Driver,
  teamId: string,
  driver: string | null,
): Promise<StyleEnvelope> {
  const policy = await teamStyle(db, teamId);
  const team = resolveStyle(policy);
  const humans = (await listMembers(db, teamId)).filter(
    (m) => m.kind === 'human' && m.left_at === null,
  );
  const named = driver ? humans.find((m) => m.name === driver) : undefined;
  const chosen = named ?? (!driver && humans.length === 1 ? humans[0] : undefined);
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
