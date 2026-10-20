import { z } from 'zod';
import { SealedBodySchema } from './appChannel.js';
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

/** Where the relay pushes one app delivery: the binding's APNs device token and environment. */
export const RelayAppPushTargetSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64,200}$/),
  environment: z.enum(['production', 'development']),
});
export type RelayAppPushTarget = z.infer<typeof RelayAppPushTargetSchema>;

/**
 * Daemon → relay: one sealed delivery to the musterd app (ADR 676 §2, §9). The relay sees the
 * route, the push target and the ciphertext, never the content; it pushes the body inline when it
 * fits (`APP_PUSH_INLINE_MAX_BYTES` by `sealedPushBytes`), else the ask ref, and stores no sealed
 * body either way.
 */
export const RelayAppDeliverFrameSchema = z.object({
  protocol: version,
  type: z.literal('app_deliver'),
  ask_ref: askRef,
  dedupe_id: z.string().min(1).max(128),
  expires_at: z.number().int().nonnegative(),
  binding: z.string().min(1).max(64),
  push: RelayAppPushTargetSchema,
  sealed: SealedBodySchema,
});
export type RelayAppDeliverFrame = z.infer<typeof RelayAppDeliverFrameSchema>;

/**
 * Daemon → relay: the answer to one `app_fetch` — the sealed body the push left out, or `null`
 * when nothing is live for that ask on that binding. The relay hands it to the waiting phone and
 * keeps nothing.
 */
export const RelayAppBodyFrameSchema = z.object({
  protocol: version,
  type: z.literal('app_body'),
  request_id: z.string().min(1).max(64),
  sealed: SealedBodySchema.nullable(),
  expires_at: z.number().int().nonnegative().optional(),
});
export type RelayAppBodyFrame = z.infer<typeof RelayAppBodyFrameSchema>;

/**
 * Daemon → relay: register one Slack install state this daemon minted (ADR 668 decision 2,
 * increment 9). Only the hash crosses; the relay's install flow accepts a state only when
 * the named team's own object holds its hash, so a state can never be re-bound to another
 * team by whoever happens to hold the install link.
 */
export const RelayInstallStateFrameSchema = z.object({
  protocol: version,
  type: z.literal('install_state'),
  state_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RelayInstallStateFrame = z.infer<typeof RelayInstallStateFrameSchema>;

/**
 * Daemon → relay: ask for any Slack install records the relay is holding for this team
 * (ADR 668 decision 2, increment 9). Sent on every connect, after reconcile; the relay
 * answers with `installs` and keeps each record until the daemon's `install_ack`.
 */
export const RelayInstallSyncFrameSchema = z.object({
  protocol: version,
  type: z.literal('install_sync'),
});
export type RelayInstallSyncFrame = z.infer<typeof RelayInstallSyncFrameSchema>;

/** Daemon → relay: these install records are stored daemon-side; the relay may drop them. */
export const RelayInstallAckFrameSchema = z.object({
  protocol: version,
  type: z.literal('install_ack'),
  slack_team_ids: z.array(z.string().min(1).max(64)).max(32),
});
export type RelayInstallAckFrame = z.infer<typeof RelayInstallAckFrameSchema>;

/**
 * One Slack install record (ADR 668 decision 2): the OAuth install for one workspace.
 * The bot token transits here once, daemon-bound — the relay drops its copy on the
 * daemon's ack and stores it nowhere else; it is never logged or audited (hard rule 5).
 */
export const RelaySlackInstallSchema = z.object({
  slack_team_id: z.string().min(1).max(64),
  bot_token: z.string().min(1).max(512),
  installer_slack_id: z.string().min(1).max(64),
  state: z.string().min(16).max(128),
  installed_at: z.number().int().nonnegative(),
});
export type RelaySlackInstall = z.infer<typeof RelaySlackInstallSchema>;

/** Relay → daemon: the install records held for this team, awaiting daemon-side storage. */
export const RelayInstallsFrameSchema = z.object({
  protocol: version,
  type: z.literal('installs'),
  installs: z.array(RelaySlackInstallSchema).max(32),
});
export type RelayInstallsFrame = z.infer<typeof RelayInstallsFrameSchema>;

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
  RelayAppDeliverFrameSchema,
  RelayAppBodyFrameSchema,
  RelayResolveFrameSchema,
  RelayInstallStateFrameSchema,
  RelayInstallSyncFrameSchema,
  RelayInstallAckFrameSchema,
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
  /** The provider's stable failure reason when it gave one (APNs: `Unregistered`, `BadDeviceToken`). */
  reason: z.string().max(128).optional(),
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

/**
 * Relay → daemon: the phone asked for the sealed body of an ask whose push carried only its ref
 * (ADR 676 §2). The daemon answers with `app_body` under the same `request_id`.
 */
export const RelayAppFetchFrameSchema = z.object({
  protocol: version,
  type: z.literal('app_fetch'),
  request_id: z.string().min(1).max(64),
  ask_ref: askRef,
  binding: z.string().min(1).max(64),
});
export type RelayAppFetchFrame = z.infer<typeof RelayAppFetchFrameSchema>;

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
  RelayAppFetchFrameSchema,
  RelayInstallsFrameSchema,
  RelayErrorFrameSchema,
]);
export type RelayServerFrame = z.infer<typeof RelayServerFrameSchema>;
