import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import { redact } from './log.js';

/**
 * The console's audit trail (ADR 620 decision 10). One INSERT per event — the runtime role can do
 * nothing else to this table (ADR 615). The detail goes through the same redaction as the log:
 * secret-named fields are dropped and every string is scrubbed, so a code, verifier, token hash,
 * cookie or magic URL cannot land here even if a caller passes one.
 */
export type AuditAction =
  | 'signin.start'
  | 'signin.result'
  | 'session.issue'
  | 'session.revoke'
  | 'session.revoke_all'
  | 'identity.link'
  | 'identity.unlink';

export async function appendAudit(
  db: Queryable,
  e: {
    action: AuditAction;
    requestId: string;
    actorAccountId?: string | null;
    detail?: Record<string, unknown>;
  },
  now: number,
): Promise<void> {
  await db.query(
    `INSERT INTO audit (id, ts, request_id, actor_account_id, action, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      now,
      e.requestId,
      e.actorAccountId ?? null,
      e.action,
      e.detail ? JSON.stringify(redact(e.detail)) : null,
    ],
  );
}
