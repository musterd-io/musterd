import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';
import { revokeGrant } from './grants.js';
import { cascadeSponsoredRevocation } from './members.js';
import { burnUnexchangedCodes, revokeAllForMember } from './oauth.js';
import { clearMemberPresence } from './presence.js';
import { revokeResidency } from './residency.js';
import type { MemberRow } from './rows.js';

/** What losing standing took from one descendant (ADR 463 §4.2). */
export interface DescendantRevocation {
  member: MemberRow;
  oauth_revoked: number;
  residency_host: string | null;
}

/**
 * ADR 463 §4.2: when a sponsor loses standing — removed or expired — every live member
 * their `sponsored_by` chain reaches is disabled (ADR 449 §3), AND loses every way it could still
 * run: residency (and its standing grant, so no host wakes it), OAuth chains and unexchanged codes
 * (so no connected device acts as it), and its presence rows. One implementation for every trigger,
 * because a trigger that disabled without revoking would leave a hosted agent waking on schedule
 * under a sponsor who no longer stands. Writes one `member.revoked_cascade` audit row each, naming
 * the root and the trigger. The caller drops live WS sessions (it owns the hub).
 */
/**
 * ADR 463 §4.4: the expiry sweep's half. An expired member gains `left_at` (ADR 459), which already
 * stops its wakes — but its enrollment and standing grant would linger, so revoke them here, then
 * cascade to anything it sponsored exactly as a removal would.
 */
export async function revokeExpiredMember(
  db: Driver,
  teamId: string,
  member: { id: string; name: string },
  now = Date.now(),
): Promise<DescendantRevocation[]> {
  return db.tx(async (t) => {
    const residency = await revokeResidency(t, teamId, member.id);
    if (residency?.grant_id) await revokeGrant(t, teamId, residency.grant_id);
    return await revokeSponsoredDescendants(t, teamId, member, 'expired', null, now);
  });
}

export async function revokeSponsoredDescendants(
  db: Driver,
  teamId: string,
  root: { id: string; name: string },
  trigger: 'remove' | 'expired',
  actor: string | null,
  now = Date.now(),
): Promise<DescendantRevocation[]> {
  return db.tx(async (t) => {
    const out: DescendantRevocation[] = [];
    for (const member of await cascadeSponsoredRevocation(t, teamId, root.id)) {
      const residency = await revokeResidency(t, teamId, member.id);
      if (residency?.grant_id) await revokeGrant(t, teamId, residency.grant_id);
      const oauth_revoked = await revokeAllForMember(t, teamId, member.id, now);
      await burnUnexchangedCodes(t, teamId, member.id, now);
      await clearMemberPresence(t, member.id);
      await appendAudit(t, teamId, {
        actor,
        action: 'member.revoked_cascade',
        target: member.name,
        result: 'allow',
        detail: {
          root: root.name,
          trigger,
          oauth_revoked,
          ...(residency ? { residency_host: residency.host } : {}),
        },
      });
      out.push({ member, oauth_revoked, residency_host: residency?.host ?? null });
    }
    return out;
  });
}
