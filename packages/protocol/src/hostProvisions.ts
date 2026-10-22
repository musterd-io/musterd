import { z } from 'zod';
import { ResidencyPolicyOverrideSchema } from './residency.js';

/** ADR 463 §2: one row per sponsored agent awaiting a process on its sponsor's host. */
export const HostProvisionStateSchema = z.enum([
  'pending',
  'claimed',
  'ready',
  'failed',
  'cancelled',
]);
export type HostProvisionState = z.infer<typeof HostProvisionStateSchema>;

/**
 * ADR 696 / ADR 703: `mint` is ADR 463's sponsored-agent row (the default, so a payload from
 * before kind existed still parses). `move` is a seat already on the team, pinned to the target
 * machine's host, which stands its Workspace up.
 */
export const HostProvisionKindSchema = z.enum(['mint', 'move']);
export type HostProvisionKind = z.infer<typeof HostProvisionKindSchema>;

/** The harness and knobs a `move` row carries so the host can re-enroll the revoked wake. */
export const HostProvisionMoveSchema = z.object({
  harness: z.string().min(1),
  policy: ResidencyPolicyOverrideSchema.nullable(),
});
export type HostProvisionMove = z.infer<typeof HostProvisionMoveSchema>;

/** The public shape of a provision row — names, never member ids, and never a secret. */
export const HostProvisionSchema = z.object({
  id: z.string(),
  team: z.string(),
  agent: z.string(),
  sponsor: z.string(),
  host: z.string().nullable(),
  state: HostProvisionStateSchema,
  claimed_by: z.string().nullable(),
  claimed_at: z.number().int().nullable(),
  ready_at: z.number().int().nullable(),
  failed_reason: z.string().nullable(),
  created_at: z.number().int(),
  /** Absent on a row written before kind existed: that row is a mint. */
  kind: HostProvisionKindSchema.default('mint'),
  /** Set only for `kind: 'move'`. A mint row carries null. */
  move: HostProvisionMoveSchema.nullable().default(null),
});
export type HostProvision = z.infer<typeof HostProvisionSchema>;

/**
 * Body of `POST /teams/:slug/host/provisions` — the host's claim poll (host-key auth).
 * `kinds` omitted means mint only, so a host that does not know `move` never claims one and
 * tries to stand it up as a new agent (ADR 703).
 */
export const HostProvisionsClaimBodySchema = z.object({
  host: z.string().min(1).max(120),
  kinds: z.array(HostProvisionKindSchema).optional(),
});
export type HostProvisionsClaimBody = z.infer<typeof HostProvisionsClaimBodySchema>;

/** What `musterd move --to` polls while the target host stands the seat up. No secret. */
export const MoveProvisionStatusSchema = z.object({
  id: z.string(),
  state: HostProvisionStateSchema,
  host: z.string().nullable(),
  failed_reason: z.string().nullable(),
});
export type MoveProvisionStatus = z.infer<typeof MoveProvisionStatusSchema>;

export const HostProvisionsClaimResponseSchema = z.object({
  provisions: z.array(HostProvisionSchema),
});
export type HostProvisionsClaimResponse = z.infer<typeof HostProvisionsClaimResponseSchema>;

/** Body of `POST /teams/:slug/host/provisions/:id/report` — a failure names the step that failed. */
export const HostProvisionReportBodySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }).strict(),
  z.object({ state: z.literal('failed'), reason: z.string().min(1).max(200) }).strict(),
]);
export type HostProvisionReportBody = z.infer<typeof HostProvisionReportBodySchema>;

/** How `team_agent_create` answered: a host of the sponsor's will run it, or here is the link. */
export const SponsoredAgentHostingSchema = z.enum(['sponsor_host', 'connect_link']);
export type SponsoredAgentHosting = z.infer<typeof SponsoredAgentHostingSchema>;
