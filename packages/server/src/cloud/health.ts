import { DATABASE_UNREACHABLE_SENTENCE, unavailableSentence, type Driver } from '../db/driver.js';

/**
 * Cloud `/health` (spec §5.5): ok, or not — with a reason that is one STABLE SENTENCE, so a probe or
 * the `/live` banner can match it. Nothing else: no database path, no connection counts, no build —
 * those describe a machine an operator owns, and on Cloud the caller is anyone. Self-hosted keeps
 * its detailed body.
 *
 * Both stores are asked: a server that can reach its coordination database but not its trace
 * database cannot accept a hook's post, so it is not ok. A pool with no client free in time is
 * "database pool exhausted" (the database is up; this server is saturated — lane 01M3ZC3G35); any
 * other failure is "database unreachable" — a `SELECT 1` that fails for another reason is no more
 * serviceable.
 */
export async function cloudHealth(
  db: Driver,
  traceDb: Driver,
): Promise<
  { status: 200; body: { ok: true } } | { status: 503; body: { ok: false; reason: string } }
> {
  try {
    await db.get('SELECT 1 AS ok');
    await traceDb.get('SELECT 1 AS ok');
    return { status: 200, body: { ok: true } };
  } catch (e) {
    const reason = unavailableSentence(e) ?? DATABASE_UNREACHABLE_SENTENCE;
    return { status: 503, body: { ok: false, reason } };
  }
}
