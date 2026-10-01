/**
 * Spec §12 (cloud design): the tenancy vocabulary every Postgres piece shares — the setting a
 * transaction stamps, the three database roles, the tables that are NOT team-owned, and the one
 * policy shape. Nothing here runs on SQLite (one team per file); the SQLite driver's `forTeam` /
 * `asOperator` return the handle itself.
 */

/** The per-transaction setting row-level security reads: `SET LOCAL app.team_id = <team>`. */
export const TENANT_SETTING = 'app.team_id';

/**
 * The three roles. `owner` runs migrations and owns every table; `app` serves requests, owns
 * nothing, has no BYPASSRLS, and sees only the rows of the team a transaction is stamped with;
 * `operator` (BYPASSRLS) is the cross-tenant handle for the loops that are legitimately about
 * every team. None can log in: a deployment creates login users and GRANTs them these roles.
 */
export const ROLE = {
  owner: 'musterd_owner',
  app: 'musterd_app',
  operator: 'musterd_operator',
} as const;

/**
 * Tables that are NOT team-owned. Everything else must carry `team_id` and a tenant policy; the
 * inventory test (tenancy.test.ts) fails on a table in neither set, so a new table cannot ship
 * unclassified. `teams` is team-owned by its own id (policy on `id`).
 */
export const GLOBAL_TABLES: readonly string[] = [
  'schema_meta',
  'footprint_machine',
  'footprint_stacks',
  // Cloud 1C (spec §4.3): a redeemed console-token id — about the console, not any one team.
  'console_token_jti',
];

/**
 * The one policy shape, derived — never hand-written per table. `current_setting(..., true)` is
 * NULL when no tenant is stamped, and NULL matches no row: the bare connection handle is
 * fail-closed. FORCE makes the policy bind the owner too, so only BYPASSRLS crosses tenants.
 */
export function tenantPolicySql(table: string): string {
  const col = table === 'teams' ? 'id' : 'team_id';
  return `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant ON "${table}";
CREATE POLICY tenant ON "${table}"
  USING (${col} = current_setting('${TENANT_SETTING}', true))
  WITH CHECK (${col} = current_setting('${TENANT_SETTING}', true));`;
}
