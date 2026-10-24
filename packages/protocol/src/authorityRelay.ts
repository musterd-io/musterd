import { z } from 'zod';
import { ApprovalDescriptorSchema, HIGH_AUTHORITY_ACTS } from './approval.js';
import { AUTHENTICATOR_KINDS } from './authority.js';
import { MemberCeilingSchema } from './capabilities.js';
import { LaneClaimsSchema } from './claims.js';
import { EnvelopeSchema } from './envelope.js';

const MemberNameSchema = z.string().min(1).max(64);
const KeyIdSchema = z.string().min(1).max(128);
const NonceSchema = z.string().min(16).max(128);

/** Approval proof at the node boundary. Bound encoded fields before they reach the hub. */
const RelayApprovalProofSchema = z
  .object({
    key_id: KeyIdSchema,
    nonce: NonceSchema,
    signature: z.string().min(1).max(8192),
    authenticator_data: z.string().min(1).max(8192).optional(),
    client_data_json: z.string().min(1).max(16_384).optional(),
  })
  .strict();

const CountersignSchema = z
  .object({
    confirmer: MemberNameSchema,
    approval: RelayApprovalProofSchema,
  })
  .strict();

const RegistrationSchema = z
  .object({
    attestation_object: z.string().min(1).max(65_536),
    client_data_json: z.string().min(1).max(16_384),
  })
  .strict();

const KeySummarySchema = z
  .object({
    id: KeyIdSchema,
    kind: z.enum(AUTHENTICATOR_KINDS),
    created_at: z.number().int().nonnegative(),
    revoked_at: z.number().int().nonnegative().nullable(),
  })
  .strict();

const DescriptorReadSchema = z
  .object({
    descriptor: ApprovalDescriptorSchema,
    passkeys: z
      .array(
        z
          .object({
            key_id: KeyIdSchema,
            credential_id: z.string().min(1).max(2048),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

/**
 * ADR 729's node-authenticated relay. This is an operation protocol, not a general HTTP proxy:
 * every request has a closed discriminator and every success shape is separately closed so
 * bearer credentials cannot be added to a response unnoticed.
 */
export const AuthorityRelayRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keys.list'), actor: MemberNameSchema }).strict(),
  z.object({ op: z.literal('enrollment.challenge.create'), actor: MemberNameSchema }).strict(),
  z
    .object({
      op: z.literal('keys.enroll'),
      actor: MemberNameSchema,
      public_key: z.string().min(1).max(4096),
      kind: z.enum(AUTHENTICATOR_KINDS),
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('passkeys.enroll'),
      actor: MemberNameSchema,
      challenge: z.string().min(16).max(128),
      approval: RelayApprovalProofSchema.optional(),
      countersign: CountersignSchema.optional(),
      registration: RegistrationSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('keys.revoke'),
      actor: MemberNameSchema,
      key_id: KeyIdSchema,
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('descriptor.create'),
      actor: MemberNameSchema,
      act: z.enum(HIGH_AUTHORITY_ACTS),
      target: z.string().min(1).max(160),
      /** Canonical JSON is used so the request has an explicit byte bound and stable digest. */
      payload_json: z
        .string()
        .max(16_384)
        .refine((value) => {
          try {
            JSON.parse(value);
            return true;
          } catch {
            return false;
          }
        }, 'payload_json must contain valid JSON'),
    })
    .strict(),
  z.object({ op: z.literal('descriptor.read'), nonce: NonceSchema }).strict(),
  z.object({ op: z.literal('proof.present'), proof: RelayApprovalProofSchema }).strict(),
  z
    .object({
      op: z.literal('proof.read'),
      actor: MemberNameSchema,
      nonce: NonceSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.verdict'),
      actor: MemberNameSchema,
      lane: z.string().min(10).max(32),
      verdict: z.enum(['accept', 'decline']),
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.authorized_by'),
      actor: MemberNameSchema,
      lane: z.string().min(10).max(32),
      authorized_by: MemberNameSchema,
      pr: z.number().int().positive().optional(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.answer'),
      actor: MemberNameSchema,
      ask_id: z.string().min(16).max(128),
      act: z.enum(['accept', 'decline']),
      body: z.string().max(4096),
      approval: RelayApprovalProofSchema.optional(),
      claims: LaneClaimsSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('member.remove'),
      actor: MemberNameSchema,
      target: MemberNameSchema,
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('member.ceiling'),
      actor: MemberNameSchema,
      target: MemberNameSchema,
      ceiling: MemberCeilingSchema.nullable(),
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('team.archive'),
      actor: MemberNameSchema,
      approval: RelayApprovalProofSchema.optional(),
    })
    .strict(),
]);
export type AuthorityRelayRequest = z.infer<typeof AuthorityRelayRequestSchema>;

export const AuthorityRelayResponseSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('keys.list'), keys: z.array(KeySummarySchema).max(128) }).strict(),
  z
    .object({
      op: z.literal('enrollment.challenge.create'),
      challenge: z.string().min(16).max(128),
      expires_at: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      op: z.literal('keys.enroll'),
      key: z.object({ id: KeyIdSchema, kind: z.enum(AUTHENTICATOR_KINDS) }).strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal('passkeys.enroll'),
      key: z.object({ id: KeyIdSchema, kind: z.enum(AUTHENTICATOR_KINDS) }).strict(),
    })
    .strict(),
  z.object({ op: z.literal('keys.revoke'), ok: z.literal(true) }).strict(),
  z.object({ op: z.literal('descriptor.create'), descriptor: ApprovalDescriptorSchema }).strict(),
  z
    .object({
      op: z.literal('descriptor.read'),
      descriptor: DescriptorReadSchema.shape.descriptor,
      passkeys: DescriptorReadSchema.shape.passkeys,
    })
    .strict(),
  z.object({ op: z.literal('proof.present'), ok: z.literal(true) }).strict(),
  z
    .object({
      op: z.literal('proof.read'),
      proof: RelayApprovalProofSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.verdict'),
      lane: z.string().min(10).max(32),
      verdict: z.enum(['accept', 'decline']),
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.authorized_by'),
      lane: z.string().min(10).max(32),
      authorized_by: MemberNameSchema,
      pr: z.number().int().positive().nullable(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('lane.answer'),
      ack: EnvelopeSchema,
      lane_verdict: z
        .object({ lane: z.string().min(10).max(32), state: z.enum(['done', 'active']) })
        .strict()
        .optional(),
      lane_authority_refused: z
        .object({ lane: z.string().min(10).max(32), reason: z.string().min(1).max(64) })
        .strict()
        .optional(),
      lane_escalation: z
        .object({ lane: z.string().min(10).max(32), human: MemberNameSchema.nullable() })
        .strict()
        .optional(),
      lane_ack: z
        .object({ lane: z.string().min(10).max(32) })
        .strict()
        .optional(),
      lane_superseded: z
        .object({
          lane: z.string().min(10).max(32),
          ask: z.string().min(16).max(128),
          current: z
            .object({ ask: z.string().min(16).max(128), reviewer: MemberNameSchema })
            .strict()
            .nullable(),
        })
        .strict()
        .optional(),
      lane_advisory: z
        .object({
          lane: z.string().min(10).max(32),
          ask: z.string().min(16).max(128),
          verdict: z.enum(['accept', 'decline']),
        })
        .strict()
        .optional(),
      lane_unbound: z
        .object({
          lane: z.string().min(10).max(32),
          ask: z.string().min(16).max(128),
          verdict: z.enum(['accept', 'decline', 'wait']),
          state: z.string().min(1).max(64),
        })
        .strict()
        .optional(),
      dispute: z
        .object({
          lane: z.string().min(10).max(32),
          verdict: z.enum(['conceded', 'held']),
          tiebreak: z
            .object({ reviewer: MemberNameSchema, grade: z.string().min(1).max(64) })
            .strict()
            .nullable()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('member.remove'),
      target: MemberNameSchema,
      kind: z.enum(['agent', 'human']),
      removed: z.literal(true),
    })
    .strict(),
  z
    .object({
      op: z.literal('member.ceiling'),
      target: MemberNameSchema,
      ceiling: MemberCeilingSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('team.archive'),
      ok: z.literal(true),
      archived_at: z.number().int().positive(),
    })
    .strict(),
]);
export type AuthorityRelayResponse = z.infer<typeof AuthorityRelayResponseSchema>;
