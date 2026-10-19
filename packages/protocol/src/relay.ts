import { z } from 'zod';
import { RELAY_MAX_FRAME_BYTES, RELAY_PROTOCOL_VERSION } from './relay.wire.js';

/**
 * Away-relay frames (ADR 659 §2): the versioned protocol between a team's daemon and its relay
 * Durable Object. The daemon parses every inbound frame through these schemas at the boundary
 * (hard rule 4). No frame carries a token, nonce, signature, or credential — the ask token is
 * issued and redeemed daemon-side (ADR 623) and only ever transits inside a provider POST body
 * the adapter rendered, which the relay drops after posting.
 */
export {
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_PENDING,
  RELAY_PROVIDER_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  reconcileRelayPending,
  type RelayPendingRow,
} from './relay.wire.js';

const version = z.literal(RELAY_PROTOCOL_VERSION);
const askRef = z.string().min(1).max(128);

export const RelayPendingSchema = z.object({
  ask_ref: askRef,
  dedupe_id: z.string().min(1).max(128),
  expires_at: z.number().int().nonnegative(),
});
export type RelayPending = z.infer<typeof RelayPendingSchema>;

/** Daemon → relay: the live pending set after a (re)connect; the relay drops everything else. */
export const RelayReconcileFrameSchema = z.object({
  protocol: version,
  type: z.literal('reconcile'),
  pending: z.array(RelayPendingSchema),
});
export type RelayReconcileFrame = z.infer<typeof RelayReconcileFrameSchema>;

/** Daemon → relay: render one delivery. `post.body` is content in flight, never stored. */
export const RelayDeliverFrameSchema = z.object({
  protocol: version,
  type: z.literal('deliver'),
  ask_ref: askRef,
  dedupe_id: z.string().min(1).max(128),
  expires_at: z.number().int().nonnegative(),
  post: z.object({
    url: z.string().url(),
    body: z.string().max(RELAY_MAX_FRAME_BYTES),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});
export type RelayDeliverFrame = z.infer<typeof RelayDeliverFrameSchema>;

/** Daemon → relay: the ask resolved or expired daemon-side; drop its metadata row. */
export const RelayResolveFrameSchema = z.object({
  protocol: version,
  type: z.literal('resolve'),
  ask_ref: askRef,
});
export type RelayResolveFrame = z.infer<typeof RelayResolveFrameSchema>;

export const RelayDaemonFrameSchema = z.discriminatedUnion('type', [
  RelayReconcileFrameSchema,
  RelayDeliverFrameSchema,
  RelayResolveFrameSchema,
]);
export type RelayDaemonFrame = z.infer<typeof RelayDaemonFrameSchema>;

/** Relay → daemon: the reconcile outcome, both sides log the same kept/dropped story. */
export const RelayReconciledFrameSchema = z.object({
  protocol: version,
  type: z.literal('reconciled'),
  kept: z.array(askRef),
  dropped: z.array(askRef),
});
export type RelayReconciledFrame = z.infer<typeof RelayReconciledFrameSchema>;

/** Relay → daemon: the provider POST happened (or not); coordinates update the message later. */
export const RelayDeliveredFrameSchema = z.object({
  protocol: version,
  type: z.literal('delivered'),
  ask_ref: askRef,
  dedupe_id: z.string().min(1).max(128),
  ok: z.boolean(),
  status: z.number().int().optional(),
  provider_ref: z.string().max(256).optional(),
});
export type RelayDeliveredFrame = z.infer<typeof RelayDeliveredFrameSchema>;

/** Relay → daemon: a provider callback forwarded raw; parsing it is the adapter's job. */
export const RelayCallbackFrameSchema = z.object({
  protocol: version,
  type: z.literal('callback'),
  ask_ref: askRef,
  content_type: z.string().max(128).optional(),
  body: z.string().max(RELAY_MAX_FRAME_BYTES),
});
export type RelayCallbackFrame = z.infer<typeof RelayCallbackFrameSchema>;

/** Relay → daemon: a frame was refused; `reason` is a stable sentence, never a secret. */
export const RelayErrorFrameSchema = z.object({
  protocol: version,
  type: z.literal('error'),
  reason: z.string().min(1).max(256),
  ask_ref: askRef.optional(),
});
export type RelayErrorFrame = z.infer<typeof RelayErrorFrameSchema>;

export const RelayServerFrameSchema = z.discriminatedUnion('type', [
  RelayReconciledFrameSchema,
  RelayDeliveredFrameSchema,
  RelayCallbackFrameSchema,
  RelayErrorFrameSchema,
]);
export type RelayServerFrame = z.infer<typeof RelayServerFrameSchema>;
