import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  ADMIN_ACCOUNT_STATUSES,
  CAN_MESSAGE_SCOPES,
  VISIBILITY_LEVELS,
  type CanMessage,
  type VisibilityLevel,
} from './capabilities.wire.js';

/**
 * The v0.3 seat capability model (ADR 070, P1 of ADR 069) — the **typed substrate** for governance.
 * P1 ships the shape + its projection only; **nothing here is enforced yet** (P2 wires the Universe-1
 * fields into `routeEnvelope` / the roster projection). The fixed v0.2 set — no RBAC engine (a tar pit
 * to avoid early). Split by universe (ADR 026): musterd **enforces** Universe-1 in-band; Universe-2 is
 * **declared/provisioned only** — stored and served, never enforced (filesystem/tool access is the
 * harness's job).
 */

export {
  ACCOUNT_STATUSES,
  ADMIN_ACCOUNT_STATUSES,
  CAN_MESSAGE_SCOPES,
  VISIBILITY_LEVELS,
  type AccountStatus,
  type AdminAccountStatus,
  type CanMessage,
  type VisibilityLevel,
} from './capabilities.wire.js';

export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES);
export const AdminAccountStatusSchema = z.enum(ADMIN_ACCOUNT_STATUSES);

/** `can_message` scope — whom a seat may message (`none` = muted). The "specific roles" scope the
 *  design mentions is a roadmap refinement; v0.3 ships `team | none`. */
export const CanMessageSchema = z.enum(CAN_MESSAGE_SCOPES);

/** What team state a seat may see. `admin` sees everything (credentials/grants/audit/policy/all
 *  charters); `team` is the need-to-know projection (teammate handles + presence + acts to it). */
export const VisibilityLevelSchema = z.enum(VISIBILITY_LEVELS);

/**
 * The full effective capability record a seat carries. Universe-1 (enforced in P2): `is_admin`,
 * `can_flag_urgent`, `can_observe`, `can_message`, `visibility_level`. Universe-2 (declared only):
 * `tool_allowlist`, `declared_resource_scopes`.
 */
export const CapabilitiesSchema = z.object({
  is_admin: z.boolean(),
  can_flag_urgent: z.boolean(),
  can_observe: z.boolean(),
  /**
   * Whether this seat may mint member-created agents (ADR 459, on ADR 449 §3). Default true:
   * every existing seat keeps exactly today's behavior, and old blobs parse unchanged. An admin
   * narrows it per seat through the ADR 070 machinery (`true→false` only); `createSponsoredAgent`
   * refuses a narrowed sponsor. False never widens anything else.
   */
  can_create_agents: z.boolean().default(true),
  /**
   * Whether this seat may coordinate: lanes, goals, seeds, memory, insights, reports, policy, agents,
   * and the coordination acts (ADR 621). Default true: every existing seat and stored blob keeps
   * today's behavior. `false` is **talk-only** — the seat may send `message`, `status_update`,
   * `request_help` and `ask`, and reply on a thread addressed to it ({@link TALK_ONLY_SEND_ACTS}).
   * The guest ceiling sets it false; it narrows like every capability (`true→false` only).
   */
  can_coordinate: z.boolean().default(true),
  can_message: CanMessageSchema,
  visibility_level: VisibilityLevelSchema,
  tool_allowlist: z.array(z.string()),
  declared_resource_scopes: z.array(z.string()),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** A partial capability override — what a `roles/<name>.toml` default or a per-seat narrowing carries
 *  (any subset of the fields). */
export const PartialCapabilitiesSchema = CapabilitiesSchema.partial();
export type PartialCapabilities = z.infer<typeof PartialCapabilitiesSchema>;

/**
 * The **generalist default** — preserves today's behaviour exactly (everyone may do everything): urgent
 * ungated, observe allowed, message the team, the `team` roster view, no declared scopes. `is_admin` is
 * the one non-permissive default (admin = creator-only); the team creator's seat sets it explicitly.
 */
export const GENERALIST_CAPABILITIES: Capabilities = {
  is_admin: false,
  can_flag_urgent: true,
  can_observe: true,
  can_create_agents: true,
  can_coordinate: true,
  can_message: 'team',
  visibility_level: 'team',
  tool_allowlist: [],
  declared_resource_scopes: [],
};

/**
 * The **guest** ceiling (ADR 621 §3, Cloud spec §4.6): talk, never coordinate. Applied at read time
 * to a member whose `members.ceiling` is `'guest'`, so nothing a role or seat file projects can widen
 * it. `can_observe` is left alone: the firehose a guest subscribes to is already filtered at its
 * `broadcast` grade (ADR 616 §4, `messageVisibilityOf`), so narrowing it would only take the live
 * stream away (ADR 621 §3, amended 2026-10-15).
 */
export const GUEST_CEILING: PartialCapabilities = {
  can_coordinate: false,
  can_create_agents: false,
  can_flag_urgent: false,
};

/** The per-member ceilings an invite or an admin may set (ADR 621 §4–6). */
export const MEMBER_CEILINGS = ['guest'] as const;
export type MemberCeiling = (typeof MEMBER_CEILINGS)[number];
export const MemberCeilingSchema = z.enum(MEMBER_CEILINGS);

/** Acts a talk-only seat may send to anyone (ADR 621 §2). */
export const TALK_ONLY_SEND_ACTS: ReadonlySet<string> = new Set([
  'message',
  'status_update',
  'request_help',
  'ask',
]);

/** Acts a talk-only seat may send only as a reply to an act addressed to it (ADR 621 §2). */
export const TALK_ONLY_REPLY_ACTS: ReadonlySet<string> = new Set([
  'accept',
  'decline',
  'wait',
  'resolve',
]);

// Narrowing order for the scoped fields: a seat may move DOWN this rank, never up.
const CAN_MESSAGE_RANK: Record<CanMessage, number> = { none: 0, team: 1 };
const VISIBILITY_RANK: Record<VisibilityLevel, number> = { team: 0, admin: 1 };

/**
 * Narrow `override` against a `ceiling`, **never widening** (ADR 070). A boolean may only go
 * `true→false`; a scope may only move down its rank (`team→none`, `admin→team`); a declared list may
 * only subset (an empty ceiling list = "unrestricted", so a seat may declare a narrowing list under it).
 * An absent override field leaves the ceiling untouched. Pure.
 */
export function clampNarrow(
  ceiling: Capabilities,
  override: PartialCapabilities = {},
): Capabilities {
  const bool = (c: boolean, o: boolean | undefined) => (o === undefined ? c : c && o);
  const list = (c: string[], o: string[] | undefined) =>
    o === undefined ? c : c.length === 0 ? o : o.filter((x) => c.includes(x));
  return {
    is_admin: bool(ceiling.is_admin, override.is_admin),
    can_flag_urgent: bool(ceiling.can_flag_urgent, override.can_flag_urgent),
    can_observe: bool(ceiling.can_observe, override.can_observe),
    can_create_agents: bool(ceiling.can_create_agents, override.can_create_agents),
    can_coordinate: bool(ceiling.can_coordinate, override.can_coordinate),
    can_message:
      override.can_message === undefined
        ? ceiling.can_message
        : CAN_MESSAGE_RANK[override.can_message] < CAN_MESSAGE_RANK[ceiling.can_message]
          ? override.can_message
          : ceiling.can_message,
    visibility_level:
      override.visibility_level === undefined
        ? ceiling.visibility_level
        : VISIBILITY_RANK[override.visibility_level] < VISIBILITY_RANK[ceiling.visibility_level]
          ? override.visibility_level
          : ceiling.visibility_level,
    tool_allowlist: list(ceiling.tool_allowlist, override.tool_allowlist),
    declared_resource_scopes: list(
      ceiling.declared_resource_scopes,
      override.declared_resource_scopes,
    ),
  };
}

/**
 * Merge the default capabilities of **every role a seat holds** (ADR 227 multi-role) into the one
 * partial `effectiveCapabilities` takes. Only **explicit** fields combine, restrictively — a grant
 * one role carries survives roles that are silent about it, and an explicit restriction in *any*
 * held role holds (booleans AND, scopes take the lower rank, explicit non-empty lists intersect; an
 * explicit empty list keeps ceiling semantics: unrestricted). Holding more roles therefore never
 * self-widens past what each admin-authored role file allows. Pure.
 */
export function mergeRoleDefaults(partials: PartialCapabilities[]): PartialCapabilities {
  const out: PartialCapabilities = {};
  const bool = (a: boolean | undefined, b: boolean | undefined) =>
    a === undefined ? b : b === undefined ? a : a && b;
  const list = (a: string[] | undefined, b: string[] | undefined) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a.length === 0) return b; // explicit [] = unrestricted (ceiling semantics)
    if (b.length === 0) return a;
    return a.filter((x) => b.includes(x));
  };
  for (const p of partials) {
    const isAdmin = bool(out.is_admin, p.is_admin);
    if (isAdmin !== undefined) out.is_admin = isAdmin;
    const urgent = bool(out.can_flag_urgent, p.can_flag_urgent);
    if (urgent !== undefined) out.can_flag_urgent = urgent;
    const observe = bool(out.can_observe, p.can_observe);
    if (observe !== undefined) out.can_observe = observe;
    const coordinate = bool(out.can_coordinate, p.can_coordinate);
    if (coordinate !== undefined) out.can_coordinate = coordinate;
    if (p.can_message !== undefined) {
      out.can_message =
        out.can_message === undefined ||
        CAN_MESSAGE_RANK[p.can_message] < CAN_MESSAGE_RANK[out.can_message]
          ? p.can_message
          : out.can_message;
    }
    if (p.visibility_level !== undefined) {
      out.visibility_level =
        out.visibility_level === undefined ||
        VISIBILITY_RANK[p.visibility_level] < VISIBILITY_RANK[out.visibility_level]
          ? p.visibility_level
          : out.visibility_level;
    }
    const tools = list(out.tool_allowlist, p.tool_allowlist);
    if (tools !== undefined) out.tool_allowlist = tools;
    const scopes = list(out.declared_resource_scopes, p.declared_resource_scopes);
    if (scopes !== undefined) out.declared_resource_scopes = scopes;
  }
  return out;
}

/**
 * Resolve a seat's effective capabilities: `generalist ⊕ roleDefaults` is the **ceiling** (roles are
 * admin-defined, so they set the ceiling freely — including `is_admin` for an admin role), then the
 * per-seat `override` **narrows** it (never widens). The single source of truth for what a seat may do,
 * shared by CLI, server, and (later) the MCP adapter.
 */
export function effectiveCapabilities(
  roleDefaults: PartialCapabilities = {},
  seatOverride: PartialCapabilities = {},
): Capabilities {
  // Roles set the ceiling freely (each unset field falls back to generalist). Explicit `??` per field
  // rather than a spread, so an absent partial key never reads as `undefined` under exactOptionalProps.
  const g = GENERALIST_CAPABILITIES;
  const ceiling: Capabilities = {
    is_admin: roleDefaults.is_admin ?? g.is_admin,
    can_flag_urgent: roleDefaults.can_flag_urgent ?? g.can_flag_urgent,
    can_observe: roleDefaults.can_observe ?? g.can_observe,
    can_create_agents: roleDefaults.can_create_agents ?? g.can_create_agents,
    can_coordinate: roleDefaults.can_coordinate ?? g.can_coordinate,
    can_message: roleDefaults.can_message ?? g.can_message,
    visibility_level: roleDefaults.visibility_level ?? g.visibility_level,
    tool_allowlist: roleDefaults.tool_allowlist ?? g.tool_allowlist,
    declared_resource_scopes: roleDefaults.declared_resource_scopes ?? g.declared_resource_scopes,
  };
  return clampNarrow(ceiling, seatOverride);
}

/** A Role: admin-defined default capabilities (partial — unset fields fall back to generalist) + an
 *  optional charter. Stored as `roles/<name>.toml`; the identity half of the CLI role-template that the
 *  server now owns (ADR 070). */
export const RoleSchema = z.object({
  name: z.string(),
  capabilities: PartialCapabilitiesSchema.default({}),
  charter: z.string().optional(),
});
export type Role = z.infer<typeof RoleSchema>;
