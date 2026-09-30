import type { Ctx } from '../context.js';
import type { ReconcileResult } from '../projection/reconcile.js';
import { getTeamBySlug } from '../store/teams.js';
import type { Hub } from './hub.js';

/**
 * A Member was just created: tell every live connection on the team (lane 01M3F81DD9).
 *
 * The frame is the existing `presence` frame with `status: 'offline'` — true of a Member who has never
 * connected, and it is exactly what makes `/live` refetch its roster (useLiveStream refetches on any
 * presence frame). A dedicated `member_added` frame would be a protocol schema change (hard rule 1)
 * that no consumer needs: `/live` tells a new name from a known one by diffing rosters.
 * Removal already broadcasts `offline`; this closes the asymmetry.
 */
export function broadcastMemberAdded(
  hub: Pick<Hub, 'broadcastTeam'>,
  teamId: string,
  name: string,
): void {
  hub.broadcastTeam(teamId, { type: 'presence', member: name, status: 'offline' });
}

/** The seat-file projection's version: every seat a reconcile pass added or revived is announced. */
export async function broadcastReconciled(
  ctx: Pick<Ctx, 'db' | 'hub'>,
  results: readonly Pick<ReconcileResult, 'slug' | 'added' | 'revived'>[],
): Promise<void> {
  for (const r of results) {
    const names = [...r.added, ...r.revived];
    if (names.length === 0) continue;
    const team = await getTeamBySlug(ctx.db, r.slug);
    if (!team) continue;
    for (const name of names) broadcastMemberAdded(ctx.hub, team.id, name);
  }
}
