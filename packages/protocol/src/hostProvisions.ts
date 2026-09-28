import { z } from 'zod';

/** ADR 463 §2: one row per sponsored agent awaiting a process on its sponsor's host. */
export const HostProvisionStateSchema = z.enum([
  'pending',
  'claimed',
  'ready',
  'failed',
  'cancelled',
]);
export type HostProvisionState = z.infer<typeof HostProvisionStateSchema>;

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
});
export type HostProvision = z.infer<typeof HostProvisionSchema>;

/** Body of `POST /teams/:slug/host/provisions` — the host's claim poll (host-key auth). */
export const HostProvisionsClaimBodySchema = z.object({ host: z.string().min(1).max(120) });
export type HostProvisionsClaimBody = z.infer<typeof HostProvisionsClaimBodySchema>;

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
