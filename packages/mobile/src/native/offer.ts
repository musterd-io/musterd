/**
 * The descriptor screen's one rule (ADR 676 decision 6, ADR 694): the phone signs what it shows.
 *
 * A listed-act ask carries two offers, one per decision, each a server-built descriptor and the
 * payload its digest commits to. The phone never trusts `payload_digest`: it hashes
 * `canonicalJson(payload)` itself and shows nothing when the two differ. The header comes from
 * `approvalWording` — the app's fixed words over the act, the target and the payload's fixed enums
 * — so an agent cannot word it. What is signed is `descriptorSigningBytes` of the descriptor
 * rebuilt around the digest computed here, never one handed over.
 *
 * Pure: no native call, no clock of its own. The screen and the answer both call it on the same
 * delivery, so the bytes signed are the bytes the screen rendered from.
 */

import type { AppApprovalOffer } from '@musterd/protocol/app-channel';
import {
  ApprovalDescriptorSchema,
  approvalWording,
  canonicalJson,
  descriptorSigningBytes,
  type ApprovalDescriptor,
  type ApprovalWording,
} from '@musterd/protocol/approval';
import { utf8Encode } from './bytes';
import { sha256, toHex } from './sha256';

export interface ShownOffer {
  wording: ApprovalWording;
  descriptor: ApprovalDescriptor;
  /** What the phone key signs for this offer. */
  signingBytes: string;
}

/**
 * The offer as the phone will show and sign it, or null when it must not be shown: a digest
 * that does not match the payload, a descriptor for another team, or one already expired.
 */
export function showOffer(
  offer: AppApprovalOffer,
  expect: { team: string; now: number },
): ShownOffer | null {
  const digest = toHex(sha256(utf8Encode(canonicalJson(offer.payload))));
  if (digest !== offer.descriptor.payload_digest) return null;
  if (offer.descriptor.audience !== expect.team) return null;
  if (offer.descriptor.expiry <= expect.now) return null;
  const rebuilt = ApprovalDescriptorSchema.safeParse({
    v: 1,
    actor: offer.descriptor.actor,
    act: offer.descriptor.act,
    target: offer.descriptor.target,
    payload_digest: digest,
    audience: offer.descriptor.audience,
    expiry: offer.descriptor.expiry,
    nonce: offer.descriptor.nonce,
  });
  if (!rebuilt.success) return null;
  return {
    wording: approvalWording(rebuilt.data, offer.payload),
    descriptor: rebuilt.data,
    signingBytes: descriptorSigningBytes(rebuilt.data),
  };
}
