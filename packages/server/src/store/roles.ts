import { type PartialCapabilities, PartialCapabilitiesSchema } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

/**
 * The `roles` table (ADR 070, v0.3 P1) — a projection of `roles/<name>.toml`, the durable role
 * defaults a seat's capabilities narrow under. The git file is the source of truth; reconcile keeps
 * this table in sync (upsert present roles, drop absent ones). Stored as a partial-capabilities JSON
 * blob + optional charter.
 */

export interface RoleRow {
  team_id: string;
  name: string;
  capabilities: string; // JSON of PartialCapabilities
  charter: string | null;
  /** One-line summary the roster surfaces (ADR 227). NULL on pre-227 role files. */
  summary: string | null;
  created_at: number;
  updated_at: number;
}

/** Upsert a role's defaults for a team (id/created_at preserved on update). */
export async function upsertRole(
  db: Driver,
  teamId: string,
  name: string,
  capabilities: PartialCapabilities,
  charter: string | null,
  summary: string | null = null,
): Promise<void> {
  const now = Date.now();
  await db.run(
    `INSERT INTO roles (team_id, name, capabilities, charter, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id, name) DO UPDATE SET
       capabilities = excluded.capabilities, charter = excluded.charter, summary = excluded.summary,
       updated_at = excluded.updated_at`,
    [teamId, name, JSON.stringify(capabilities), charter, summary, now, now],
  );
}

/** All role names declared for a team (for reconcile's drop-absent sweep). */
export async function listRoleNames(db: Driver, teamId: string): Promise<string[]> {
  return (await db.all<{ name: string }>('SELECT name FROM roles WHERE team_id = ?', [teamId])).map(
    (r) => r.name,
  );
}

/** Drop the named roles for a team (reconcile removes roles absent from the files). */
export async function deleteRoles(db: Driver, teamId: string, names: string[]): Promise<void> {
  if (names.length === 0) return;
  for (const name of names) {
    await db.run('DELETE FROM roles WHERE team_id = ? AND name = ?', [teamId, name]);
  }
}

/** The team's role library for the roster read (ADR 227 discovery): name-ordered so the response
 *  is stable. Charter + capability defaults ride along (close-out, additive) so `role show` can
 *  render a team role without a second route — they were always in the row. */
export async function listRoles(
  db: Driver,
  teamId: string,
): Promise<
  Array<{ name: string; summary: string | null; charter: string | null; capabilities: unknown }>
> {
  return (
    await db.all<{
      name: string;
      summary: string | null;
      charter: string | null;
      capabilities: string | null;
    }>('SELECT name, summary, charter, capabilities FROM roles WHERE team_id = ? ORDER BY name', [
      teamId,
    ])
  ).map((r) => ({ ...r, capabilities: r.capabilities ? JSON.parse(r.capabilities) : {} }));
}

/** The authenticated occupancy charter for a Member's Team Role, when that role declares one. */
export async function getRoleCharter(
  db: Driver,
  teamId: string,
  role: string,
): Promise<string | null> {
  return (
    (
      await db.get<{ charter: string | null }>(
        'SELECT charter FROM roles WHERE team_id = ? AND name = ?',
        [teamId, role],
      )
    )?.charter ?? null
  );
}

/** A team's role summaries as a name→summary map (ADR 227 discovery — the roster's one-line face
 *  per role; roles without a summary are absent). */
export async function roleSummariesMap(db: Driver, teamId: string): Promise<Map<string, string>> {
  const rows = await db.all<{ name: string; summary: string | null }>(
    'SELECT name, summary FROM roles WHERE team_id = ?',
    [teamId],
  );
  const map = new Map<string, string>();
  for (const r of rows) if (r.summary) map.set(r.name, r.summary);
  return map;
}

/** A team's role defaults as a name→partial-capabilities map (reconcile uses it to resolve seats). */
export async function roleDefaultsMap(
  db: Driver,
  teamId: string,
): Promise<Map<string, PartialCapabilities>> {
  const rows = await db.all<RoleRow>('SELECT * FROM roles WHERE team_id = ?', [teamId]);
  const map = new Map<string, PartialCapabilities>();
  for (const r of rows) {
    // Defensive parse: a corrupt blob degrades to no-defaults (generalist) rather than throwing.
    map.set(r.name, PartialCapabilitiesSchema.safeParse(JSON.parse(r.capabilities)).data ?? {});
  }
  return map;
}
