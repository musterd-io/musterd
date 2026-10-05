import {
  type ResolvedStyle,
  type StylePolicy,
  type StylePrefs,
  StylePrefsSchema,
  resolveStyle,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import type { MemberRow } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * Agent style, server half (ADR 514): a human's own dials live on `members.style_prefs`, daemon-local
 * like `doorbell_prefs` (ADR 443); the floor and team defaults are `policy.style`. Resolution is
 * protocol's `resolveStyle`; this file only reads and writes the row.
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

/** How seats talk to this member: team style resolved against their prefs (agents: team style). */
export async function resolveMemberStyle(
  db: Driver,
  teamId: string,
  m: MemberRow,
): Promise<ResolvedStyle> {
  return resolveStyle(await teamStyle(db, teamId), memberStylePrefs(m));
}
