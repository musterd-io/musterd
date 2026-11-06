import { z } from 'zod';
import { ApprovalDescriptorSchema } from './approval.js';
import { OpenPollSchema, PollMetaSchema, PollSpecSchema } from './poll.js';
import type { PollSpec } from './poll.wire.js';
import { AnswerSchema, QuestionSchema, type Answer } from './question.js';
import { QUICK_ACTIONS, type QuickAction } from './quickAction.wire.js';

/**
 * The musterd app's channel (ADR 676): what the pairing QR carries and what the phone sends back,
 * sealed, to pair. Every key travels as raw bytes, base64url: Ed25519 is 32 bytes, a P-256 point
 * is the 65-byte uncompressed form. The daemon parses an opened pairing request through
 * {@link AppPairRequestSchema} before it reads a field (hard rule 4).
 *
 * No `node:` import, here or in `approval.ts`: the app imports both through the
 * `@musterd/protocol/app-channel` and `@musterd/protocol/approval` subpaths (ADR 694).
 */

export const APP_CHANNEL = 'app';
export const APP_QR_VERSION = 1;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const ed25519Raw = b64url.length(43);
const p256Raw = b64url.length(87);
/** An APNs device token: hex, 32 bytes today, up to 100 by Apple's note that the length may grow. */
const APNS_DEVICE_TOKEN = z.string().regex(/^[0-9a-f]{64,200}$/);

/**
 * What the daemon's own page shows as a QR code (ADR 676 §5). `code` is the one-time pairing
 * nonce: it never reaches the relay in the clear, because the phone sends it back sealed.
 */
export const AppPairingQrSchema = z.object({
  v: z.literal(APP_QR_VERSION),
  /** The team's away-relay origin (`https:`), where the phone sends its sealed request. */
  relay: z.string().url().max(512),
  team: z.string().min(1).max(64),
  pairing: z.string().min(1).max(64),
  code: b64url.min(32).max(64),
  expires_at: z.number().int().nonnegative(),
  daemon_identity_public_key: ed25519Raw,
  daemon_receive_public_key: p256Raw,
});
export type AppPairingQr = z.infer<typeof AppPairingQrSchema>;

/**
 * The phone's pairing request, opened from a body sealed to the daemon's receive key with the
 * route `{team, binding: 'pairing', ref: <pairing id>, expires_at}` and purpose `pair`.
 * `attestation` is App Attest's CBOR attestation object over the challenge
 * sha256(code ‖ signing public key ‖ receive public key).
 */
export const AppPairRequestSchema = z.object({
  v: z.literal(1),
  code: b64url.min(32).max(64),
  signing_public_key: p256Raw,
  receive_public_key: p256Raw,
  attest_key_id: b64url.length(43),
  attestation: b64url.max(16_384),
  device_name: z.string().max(64).optional(),
  /**
   * The phone's APNs device token (hex) and the APNs environment it was issued in. The daemon keeps
   * them on the binding and names them on each `app_deliver`, so the relay pushes without storing
   * a device table. Absent, the binding is paired but receives no push until it pairs again.
   */
  push_token: APNS_DEVICE_TOKEN.optional(),
  push_environment: z.enum(['production', 'development']).optional(),
});
export type AppPairRequest = z.infer<typeof AppPairRequestSchema>;

/** The relay route a pairing request is sealed under: the pairing, not yet a binding. */
export const APP_PAIRING_BINDING = 'pairing';

/** A sealed body on the wire (`notify/appSeal.ts`): HPKE encapsulated key and ciphertext, base64url. */
export const SealedBodySchema = z.object({
  v: z.literal(1),
  enc: b64url.max(256),
  ct: b64url.max(65_536),
});
export type SealedBodyWire = z.infer<typeof SealedBodySchema>;

/**
 * At or under this many bytes of sealed body the relay puts it in the push; over it the push carries
 * only the ask ref and the phone fetches the body through the relay (ADR 676 §2). Measured by
 * {@link sealedPushBytes}, on the encoded form, so the push stays inside APNs' 4 KB payload.
 */
export const APP_PUSH_INLINE_MAX_BYTES = 3_072;

/** The bytes a sealed body takes in a push: its two base64url fields, as sent. */
export function sealedPushBytes(sealed: { enc: string; ct: string }): number {
  return sealed.enc.length + sealed.ct.length;
}

/**
 * What the phone sends through the relay (ADR 676 §6, §8): the relay forwards it as a callback body.
 * The route fields are what the seal was made under; the daemon opens with them and nothing else.
 * - `pair`: the pairing request, `binding: 'pairing'`, `ref` = the pairing id.
 * - `answer`: an answer, `ref` = the ask id, `expires_at` = the delivery's expiry.
 * - `redeliver`: on open, re-send this binding's pending asks (no body — the daemon is the source
 *   of truth, and a re-send reaches only the paired phone).
 * - `quick_action` (ADR 791): a person's quick action for one seat, `ref` = the body's nonce,
 *   sealed with purpose `quick_action`; the body is an {@link AppQuickActionSchema}.
 * - `poll_open` (ADR 807 §5): a human admin opens the team's Twitch poll, `ref` = the body's nonce,
 *   sealed with purpose `poll_open`; the body is an {@link AppPollOpenSchema}, signed by the Face ID
 *   key — the phone's A2 path for `credential_mint`.
 * - `poll_close` (ADR 807): end or cancel the open poll, `ref` = the body's nonce, sealed with
 *   purpose `poll_close`; the body is an {@link AppPollCloseSchema}.
 */
export const AppCallbackSchema = z.discriminatedUnion('kind', [
  z.object({
    app: z.literal(1),
    kind: z.literal('pair'),
    binding: z.literal(APP_PAIRING_BINDING),
    ref: z.string().min(1).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('answer'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(1).max(128),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('redeliver'),
    binding: z.string().min(1).max(64),
  }),
  /** ADR 774 §5: enroll the phone's question key. Sealed with purpose `question_key`; the body is
   *  an {@link AppQuestionKeyEnrollSchema} signed by the binding's Face ID phone key. */
  z.object({
    app: z.literal(1),
    kind: z.literal('question_key'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(1).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('quick_action'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(16).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('poll_open'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(16).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('poll_close'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(16).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
]);
export type AppCallback = z.infer<typeof AppCallbackSchema>;

/**
 * One decision's offer on a listed-act ask (ADR 694): the descriptor the daemon built for the act
 * that decision performs, and the payload its `payload_digest` commits to. The app never trusts
 * `payload_digest`: it hashes `canonicalJson(payload)` itself, shows nothing if the two differ,
 * renders the header with `approvalWording`, and signs `descriptorSigningBytes` of the descriptor
 * it rebuilt from what it showed. A descriptor lives five minutes; the app fetches the ask by ref
 * when it opens the descriptor screen, which re-issues it with fresh descriptors.
 */
export const AppApprovalOfferSchema = z.object({
  descriptor: ApprovalDescriptorSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type AppApprovalOffer = z.infer<typeof AppApprovalOfferSchema>;

/** Both offers of a listed-act ask: `approve` and `reject` are different acts with different nonces. */
export const AppApprovalSchema = z.object({
  approve: AppApprovalOfferSchema,
  reject: AppApprovalOfferSchema,
});
export type AppApproval = z.infer<typeof AppApprovalSchema>;

/**
 * The fatigue ceiling (ADR 676 §8), per human. At most {@link APP_LISTED_ACT_OPEN_MAX} listed-act
 * ask is live on the app at a time — the rest wait, and the live one says how many (`waiting`). At
 * most {@link APP_LISTED_ACT_HOURLY_MAX} listed-act asks from agent seats are first delivered in any
 * rolling hour; past that they are held and one `held` summary is sent. Nothing locks the human
 * out: a held ask is still answerable on /live, and the phone gets it once the hour allows.
 */
export const APP_LISTED_ACT_OPEN_MAX = 1;
export const APP_LISTED_ACT_HOURLY_MAX = 6;

/** ADR 791: a quick action's result for one seat. */
export const QUICK_ACTION_RESULTS = ['started', 'offline'] as const;
export type QuickActionResult = (typeof QUICK_ACTION_RESULTS)[number];
/** The most seats one roster carries. */
export const APP_ROSTER_MAX = 64;

/** ADR 797: a member portrait is a 64×64 PNG of at most this many bytes. */
export const PORTRAIT_MAX_BYTES = 16 * 1024;
/** ADR 797: a portrait's side, in pixels. */
export const PORTRAIT_SIZE = 64;
/** ADR 797: a portrait's digest — the first 16 hex characters of the PNG's sha256. */
export const PortraitDigestSchema = z.string().regex(/^[0-9a-f]{16}$/);
/** ADR 797: the relay ref a phone fetches one portrait by. */
export const portraitRef = (digest: string) => `portrait-${digest}`;
/** ADR 797: the PNG bytes, base64url, at most `PORTRAIT_MAX_BYTES` once decoded. */
const portraitPng = b64url.max(Math.ceil((PORTRAIT_MAX_BYTES * 4) / 3));

/** ADR 797: what /live sends to store a member's portrait (`PUT …/members/:name/portrait`). */
export const PortraitUploadSchema = z.object({ png: portraitPng });
export type PortraitUpload = z.infer<typeof PortraitUploadSchema>;
/** ADR 814: /live's six card states, as `teamCards()` computes them — the phone invents none. */
export const APP_MEMBER_STATES = [
  'working',
  'review',
  'blocked',
  'asking',
  'between',
  'away',
] as const;
export type AppMemberState = (typeof APP_MEMBER_STATES)[number];

/**
 * ADR 814 decision 2: one member of the team as /live's team card reads it. `label` is the card's
 * `stateLabel` verbatim ("working on", "waiting for review", "asking nick", "waiting on nick · 42m");
 * `title`/`source` the shown lane's title or the member's own status; `goal` the lane's goal name;
 * `since` what the age counts from; `model` the model badge's label ("opus 5.5", "human", "model
 * unknown"). The seat fields the phone already uses (ADR 791/797/806) ride along, so one row has
 * what the Seats screen had.
 */
export const AppMemberSchema = z.object({
  name: z.string(),
  kind: z.enum(['agent', 'human']),
  state: z.enum(APP_MEMBER_STATES),
  label: z.string(),
  title: z.string().nullable(),
  source: z.enum(['lane', 'status']).nullable(),
  goal: z.string().nullable(),
  since: z.number().int().nullable(),
  more_lanes: z.number().int().nonnegative(),
  model: z.string().nullable(),
  online: z.boolean(),
  wakeable: z.boolean(),
  lane: z.object({ id: z.string(), title: z.string() }).nullable(),
  portrait: PortraitDigestSchema.nullable(),
  waiting: z.object({ to: z.string().nullable(), since: z.number().int() }).optional(),
});
export type AppMember = z.infer<typeof AppMemberSchema>;

/** ADR 814 decision 3: at most this many for-you items ride a roster. */
export const APP_FOR_YOU_MAX = 32;
/** ADR 814 decision 3: a for-you summary is one line of at most this many characters. */
export const APP_FOR_YOU_SUMMARY_MAX = 200;

/**
 * ADR 814 decision 3: one thing waiting on the binding's person, as /live counts it — an open ask
 * to them or the team, or an open question to them. The phone unions this with the asks that
 * reached it as pushes, by `id`, so its badge and /live agree even for a held ask.
 */
export const AppForYouSchema = z.object({
  id: z.string(),
  from: z.string(),
  kind: z.enum(['approve', 'question', 'review', 'help']),
  summary: z.string().max(APP_FOR_YOU_SUMMARY_MAX),
  ts: z.number().int(),
});
export type AppForYou = z.infer<typeof AppForYouSchema>;

/** A quick action's seal must expire within this window of the daemon's clock (replay bound). */
export const APP_QUICK_ACTION_WINDOW_MS = 10 * 60_000;

/**
 * What the daemon signs and seals to the phone. `nonce` is unique per token (the phone's seen-nonce
 * store drops a replay before display); `token` is the ADR 623 ask token the answer redeems.
 */
export const AppDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('ask'),
    team: z.string(),
    binding: z.string(),
    ask: z.object({
      id: z.string(),
      from: z.string(),
      from_kind: z.enum(['agent', 'human']),
      body: z.string(),
      tier: z.string(),
      species: z.string().nullable(),
      action_class: z.enum(['advisory', 'privileged']),
      ts: z.number().int(),
      /** ADR 773: present when the ask is a question — options, why, context, audience. The app
       *  answers it with {@link AppQuestionAnswerSchema}, never approve/reject. */
      question: QuestionSchema.optional(),
      /** How loud (ADR 773 notification defaults): `active` buzzes, `passive` lands quietly. Absent
       *  on a non-question ask, where the app keeps its tier-based behaviour. */
      interruption: z.enum(['active', 'passive']).optional(),
    }),
    /**
     * Present exactly when `action_class` is `privileged` (ADR 694): the ask's answer is a listed
     * act, answered only from the descriptor screen, never from the notification (ADR 676 §7).
     */
    approval: AppApprovalSchema.optional(),
    /**
     * The lane a verdict ask judges. `title` is the lane's own text, written by a seat: shown
     * below the descriptor and labelled as theirs, never in the approval header (ADR 676 §6).
     */
    lane: z.object({ id: z.string(), title: z.string() }).optional(),
    /** On a listed-act ask: how many more wait behind it for this human (ADR 676 §8). */
    waiting: z.number().int().nonnegative().optional(),
    token: z.string(),
    nonce: z.string(),
    expires_at: z.number().int(),
    /**
     * On a question delivery: the question key the daemon holds for this binding (ADR 774), as
     * base64url (no padding) of SHA-256 over its raw 65-byte point. Absent when it holds none. The
     * phone offers lock-screen answers only when this matches its own enrolled key.
     */
    question_key: z.string().length(43).optional(),
  }),
  z.object({
    v: z.literal(1),
    /**
     * The hourly ceiling held listed-act asks from agent seats (ADR 676 §8): sent once, when the
     * first is held. `count` held now; `until` is when the oldest delivery leaves the hour.
     */
    kind: z.literal('held'),
    team: z.string(),
    binding: z.string(),
    count: z.number().int().positive(),
    until: z.number().int(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('paired'),
    team: z.string(),
    binding: z.string(),
    member: z.string(),
    device_key_id: z.string(),
  }),
  /**
   * ADR 791: what a phone quick action did. `nonce` is the request's, so the phone matches the
   * result to the button it pressed. `offline`: the seat is neither live nor enrolled for wakes —
   * the steer still waits in its inbox.
   */
  z.object({
    v: z.literal(1),
    kind: z.literal('quick_action_result'),
    team: z.string(),
    binding: z.string(),
    nonce: z.string(),
    action: z.enum(QUICK_ACTIONS),
    seat: z.string(),
    result: z.enum(QUICK_ACTION_RESULTS),
  }),
  /**
   * ADR 791: the team's agent seats as the phone shows them — online (a live session) or not,
   * whether a host can wake it, and its one claimed lane, if it has exactly one. `lane.title` is
   * the seat's own text: the phone labels it as theirs. Sent after pairing and on every
   * `redeliver`; `ts` orders two rosters, and the phone keeps the newest.
   */
  z.object({
    v: z.literal(1),
    kind: z.literal('roster'),
    team: z.string(),
    binding: z.string(),
    ts: z.number().int(),
    seats: z
      .array(
        z.object({
          seat: z.string(),
          online: z.boolean(),
          wakeable: z.boolean(),
          lane: z.object({ id: z.string(), title: z.string() }).nullable(),
          /** ADR 797: the seat's portrait digest; the phone fetches the PNG by `portraitRef`. */
          portrait: PortraitDigestSchema.nullable().optional(),
          /** ADR 806: the seat's oldest open question — to whom (null: the team) and since when. */
          waiting: z.object({ to: z.string().nullable(), since: z.number().int() }).optional(),
        }),
      )
      .max(APP_ROSTER_MAX),
    /** ADR 807: the team's Twitch poll, for a binding whose person is a human admin. */
    poll: z.lazy(() => AppPollStateSchema).optional(),
    /**
     * ADR 814: every standing member with /live's card state. Optional: a daemon before ADR 814
     * sends none and the phone draws the team from `seats`; a phone before it ignores this.
     */
    members: z.array(AppMemberSchema).max(APP_ROSTER_MAX).optional(),
    /** ADR 814: what waits on the binding's person, oldest first. Optional for the same reason. */
    for_you: z.array(AppForYouSchema).max(APP_FOR_YOU_MAX).optional(),
  }),
  /**
   * ADR 807: what a phone poll request did, and the poll as it stands after it. `nonce` is the
   * request's. `reason` is set when `ok` is false: `not_admin`, `not_live`, `already_open`,
   * `not_open`, `no_passkey`, `hub_only`, or a signature refusal.
   */
  z.object({
    v: z.literal(1),
    kind: z.literal('poll_result'),
    team: z.string(),
    binding: z.string(),
    nonce: z.string(),
    op: z.enum(['open', 'end', 'cancel']),
    ok: z.boolean(),
    reason: z.string().max(64).optional(),
    poll: z.lazy(() => AppPollStateSchema),
  }),
  /** ADR 797: one member portrait, fetched by `portraitRef(digest)` and cached by digest. */
  z.object({
    v: z.literal(1),
    kind: z.literal('portrait'),
    team: z.string(),
    binding: z.string(),
    digest: PortraitDigestSchema,
    png: portraitPng,
  }),
]);
export type AppDelivery = z.infer<typeof AppDeliverySchema>;

/** The phone's answer, opened from a body sealed to the daemon with purpose `answer`. */
export const AppAnswerSchema = z.object({
  v: z.literal(1),
  token: z.string().min(1).max(128),
  decision: z.enum(['approve', 'reject']),
  nonce: z.string().min(1).max(64),
  /** The phone signing key's ECDSA P-256 / SHA-256 signature, DER, over {@link appAnswerSigningBytes}. */
  signature: b64url.max(256),
  /** "I did not expect this" — only on a reject (ADR 676 §8). */
  reported: z.boolean().optional(),
  /**
   * Required on a privileged ask's answer, absent otherwise (ADR 694): the A2 proof for the offer
   * `decision` names. `nonce` is that descriptor's nonce; `signature` is the phone signing key's
   * ECDSA P-256 / SHA-256, DER, over `descriptorSigningBytes` of the descriptor the app rebuilt.
   * Both signatures on one answer are made under one Face ID evaluation.
   */
  approval: z
    .object({
      key_id: z.string().min(1).max(64),
      nonce: z.string().min(16).max(64),
      signature: b64url.max(256),
    })
    .optional(),
});
export type AppAnswer = z.infer<typeof AppAnswerSchema>;

/**
 * The phone's answer to a **question** ask (ADR 773/774), opened from a body sealed with purpose
 * `answer`. A separate schema from {@link AppAnswerSchema}: a question is answered with an option
 * and/or text, never approve/reject, and its signature is over {@link appQuestionAnswerSigningBytes}
 * — its own domain tag, so a question-key signature can never verify as a decision.
 */
export const AppQuestionAnswerSchema = z.object({
  v: z.literal(1),
  token: z.string().min(1).max(128),
  answer: AnswerSchema,
  nonce: z.string().min(1).max(64),
  /** Which phone key signed: the silent question key (ADR 774 §5) or the Face ID signing key. */
  key: z.enum(['question', 'signing']),
  /** ECDSA P-256 / SHA-256, DER, over {@link appQuestionAnswerSigningBytes}. */
  signature: b64url.max(256),
});
export type AppQuestionAnswer = z.infer<typeof AppQuestionAnswerSchema>;

/** The exact bytes a question answer's signature covers. `text` is last and JSON-quoted, so a
 *  newline in it cannot forge a field. */
export function appQuestionAnswerSigningBytes(input: {
  team: string;
  binding: string;
  ask: string;
  token: string;
  nonce: string;
  answer: Answer;
}): string {
  return [
    'musterd-app-question-answer/v1',
    input.team,
    input.binding,
    input.ask,
    input.token,
    input.nonce,
    input.answer.choice === undefined ? '-' : String(input.answer.choice),
    input.answer.text === undefined ? '-' : JSON.stringify(input.answer.text),
  ].join('\n');
}

/**
 * Enrolling the phone's question key (ADR 774 §5): P-256, `ThisDeviceOnly`, no biometry, so a
 * notification action can sign an answer to a question while the phone is locked. The enrollment
 * itself is signed by the Face ID signing key over {@link questionKeyEnrollBytes}.
 */
export const AppQuestionKeyEnrollSchema = z.object({
  v: z.literal(1),
  binding: z.string().min(1).max(64),
  /** The question key's uncompressed P-256 public point (65 bytes), base64url. */
  question_key: b64url.min(86).max(88),
  nonce: z.string().min(16).max(64),
  signature: b64url.max(256),
});
export type AppQuestionKeyEnroll = z.infer<typeof AppQuestionKeyEnrollSchema>;

export function questionKeyEnrollBytes(input: {
  team: string;
  binding: string;
  question_key: string;
  nonce: string;
}): string {
  return [
    'musterd-app-question-key/v1',
    input.team,
    input.binding,
    input.question_key,
    input.nonce,
  ].join('\n');
}

/**
 * The bytes the phone signs for an answer: domain-separated canonical JSON of everything the answer
 * means, so a signature for one ask, binding, decision or delivery is a signature for no other.
 */
export function appAnswerSigningBytes(input: {
  team: string;
  binding: string;
  ask: string;
  token: string;
  decision: 'approve' | 'reject';
  nonce: string;
  reported: boolean;
}): string {
  return [
    'musterd-app-answer/v1',
    input.team,
    input.binding,
    input.ask,
    input.token,
    input.decision,
    input.nonce,
    input.reported ? 'reported' : '-',
  ].join('\n');
}

/**
 * A person's quick action from the phone (ADR 791), opened from a body sealed with purpose
 * `quick_action`: one seat, one action. Signed by the silent question key (nick, 2026-11-03: no
 * Face ID for a quick action) or by the Face ID signing key, over {@link appQuickActionSigningBytes}.
 * There is no Start everyone from the phone (nick, 2026-11-03: not one he would use).
 */
export const AppQuickActionSchema = z.object({
  v: z.literal(1),
  seat: z.string().min(1).max(64),
  action: z.enum(QUICK_ACTIONS),
  nonce: z.string().min(16).max(64),
  /** The phone's clock when the button was pressed, ms. */
  ts: z.number().int().nonnegative(),
  key: z.enum(['question', 'signing']),
  signature: b64url.max(256),
});
export type AppQuickAction = z.infer<typeof AppQuickActionSchema>;

/** The exact bytes a quick action's signature covers; its own domain tag, so no other signature
 *  verifies as one. */
export function appQuickActionSigningBytes(input: {
  team: string;
  binding: string;
  seat: string;
  action: QuickAction;
  nonce: string;
  ts: number;
}): string {
  return [
    'musterd-app-quick-action/v1',
    input.team,
    input.binding,
    input.seat,
    input.action,
    input.nonce,
    String(input.ts),
  ].join('\n');
}

/**
 * The team's Twitch poll as the phone shows it (ADR 807): Twitch's live state, the open poll
 * (never its counts token) and the last closed one for the minutes the daemon keeps it.
 */
export const AppPollStateSchema = z.object({
  live: z.boolean(),
  open: OpenPollSchema.omit({ poll_token: true }).nullable(),
  last: PollMetaSchema.options[1].nullable(),
});
export type AppPollState = z.infer<typeof AppPollStateSchema>;

/**
 * A human admin opens the team's poll from the phone (ADR 807 §5), opened from a body sealed with
 * purpose `poll_open`. There is no key field: opening mints the poll's credential, so only the Face
 * ID signing key — an enrolled A2 device key — signs it, over {@link appPollOpenSigningBytes}.
 */
export const AppPollOpenSchema = z
  .object({
    v: z.literal(1),
    spec: PollSpecSchema,
    nonce: z.string().min(16).max(64),
    /** The phone's clock when Start was pressed, ms. */
    ts: z.number().int().nonnegative(),
    signature: b64url.max(256),
  })
  .strict();
export type AppPollOpen = z.infer<typeof AppPollOpenSchema>;

/** End (the votes so far) or cancel (no winner) the open poll from the phone. Ending mints nothing,
 *  so either phone key may sign, over {@link appPollCloseSigningBytes}. */
export const AppPollCloseSchema = z
  .object({
    v: z.literal(1),
    poll_id: z.string().min(10).max(64),
    how: z.enum(['end', 'cancel']),
    nonce: z.string().min(16).max(64),
    ts: z.number().int().nonnegative(),
    key: z.enum(['question', 'signing']),
    signature: b64url.max(256),
  })
  .strict();
export type AppPollClose = z.infer<typeof AppPollCloseSchema>;

/** The exact bytes a phone poll open signs: its own domain tag, and the spec in a fixed key order
 *  (question, options, minutes), so the phone and the daemon cannot disagree on the JSON. */
export function appPollOpenSigningBytes(input: {
  team: string;
  binding: string;
  spec: PollSpec;
  nonce: string;
  ts: number;
}): string {
  const spec = JSON.stringify({
    question: input.spec.question,
    options: input.spec.options,
    minutes: input.spec.minutes,
  });
  return [
    'musterd-app-poll-open/v1',
    input.team,
    input.binding,
    spec,
    input.nonce,
    String(input.ts),
  ].join('\n');
}

/** The exact bytes a phone poll end or cancel signs. */
export function appPollCloseSigningBytes(input: {
  team: string;
  binding: string;
  poll_id: string;
  how: 'end' | 'cancel';
  nonce: string;
  ts: number;
}): string {
  return [
    'musterd-app-poll-close/v1',
    input.team,
    input.binding,
    input.poll_id,
    input.how,
    input.nonce,
    String(input.ts),
  ].join('\n');
}
