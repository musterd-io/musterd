import { createHash, randomBytes } from 'node:crypto';
import type { AskActionClass } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/**
 * The ask token and the atomic decision record (ADR 623 §5-§7, ADR 618 §6). A token is a bound
 * REFERENCE, not a credential for "a human said yes": the row binds the ask and its revision, the
 * action class, the binding and its generation, the required assurance and an expiry. Only the
 * sha256 of the token is stored (hard rule 5). One decision per ask across every channel is the
 * primary key of `ask_decisions`; redemption inserts it in the same transaction as the answer write.
 */

export type Assurance = 'A1' | 'A2';
export type Decision = 'approve' | 'reject';

/** The closed set of reasons a redemption is turned away (ADR 623 §7). */
export type RefusalReason =
  | 'unknown_token'
  | 'expired'
  | 'consumed'
  | 'assurance'
  | 'stale_revision'
  | 'class_changed'
  | 'binding_stale'
  | 'no_binding_store'
  | 'conflict'
  | 'answer_disabled';

export interface IssueInput {
  teamId: string;
  askId: string;
  /** A digest of the ask's body and action at issue time; redemption refuses a changed revision. */
  askDigest: string;
  actionClass: AskActionClass;
  channel: string;
  bindingId: string;
  bindingGeneration: number;
  requiredAssurance: Assurance;
  /** `raised_at + askContract(tier).timeout_ms`, stamped by the daemon (ADR 623 §5). */
  expiresAt: number;
  now?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The ask digest (ADR 623 §5): over the ask's stored body and meta, computed identically at
 * delivery time and again at redemption from the daemon's own rows — so an ask changed after
 * its buttons went out redeems as `stale_revision`, never as what was shown.
 */
export function askDigest(body: string, metaJson: string | null): string {
  return sha256(`${body}\n${metaJson ?? ''}`);
}

/**
 * Mint a token for one ask on one channel. The plaintext is returned once, to the caller that hands it
 * to the relay; it is never stored. A privileged ask gets no token: it gets no buttons (ADR 618 §4).
 */
export async function issueAskChannelToken(
  db: Driver,
  input: IssueInput,
): Promise<{ token: string; expiresAt: number }> {
  if (input.actionClass === 'privileged') {
    throw new Error('a privileged ask gets no channel token (ADR 618 §4)');
  }
  const token = randomBytes(32).toString('base64url');
  await db.run(
    `INSERT INTO ask_channel_tokens
       (token_hash, team_id, ask_id, ask_digest, action_class, channel, binding_id,
        binding_generation, required_assurance, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sha256(token),
      input.teamId,
      input.askId,
      input.askDigest,
      input.actionClass,
      input.channel,
      input.bindingId,
      input.bindingGeneration,
      input.requiredAssurance,
      input.expiresAt,
      input.now ?? Date.now(),
    ],
  );
  return { token, expiresAt: input.expiresAt };
}

/** The ask as it stands NOW (ADR 623 §6), read by the caller from the live message log. */
export interface AskStanding {
  /** Still unanswered. False once a decision exists or another surface answered. */
  open: boolean;
  /** The digest of the ask's body and action as it stands now. */
  digest: string;
  /** The class recomputed from current state, not read back from the stamp. */
  actionClass: AskActionClass;
}

export type BindingStanding = 'current' | 'stale' | 'unavailable';

/** What redemption must re-read at the moment of the answer, injected so it is testable. */
export interface RedemptionChecks {
  askStanding(t: Driver, teamId: string, askId: string): Promise<AskStanding | null>;
  bindingStanding(
    t: Driver,
    teamId: string,
    bindingId: string,
    generation: number,
  ): Promise<BindingStanding>;
  /**
   * May the bound human answer from this channel right now (channel settings, away channels 6)?
   * Optional: when absent, answer authority is not gated (existing callers and unit stubs).
   */
  answerEnabled?(t: Driver, teamId: string, bindingId: string, channel: string): Promise<boolean>;
}

/**
 * The binding store arrives with the pairing lane. Until then redemption FAILS CLOSED with
 * `no_binding_store` rather than assuming a binding is current (ADR 623 §6).
 */
export const NO_BINDING_STORE: RedemptionChecks['bindingStanding'] = async () => 'unavailable';

export interface RedeemInput {
  teamId: string;
  token: string;
  /** The assurance the answering channel can prove. A2 is never accepted in v1 (ADR 623 §2). */
  assurance: Assurance;
  decision: Decision;
  /** The id the answer message will carry; the decision row records it. */
  answerMessageId: string;
  /** The bound human (the authorizer) and the delivery path (the actor), kept separate (ADR 618 §1). */
  authorizer: string;
  deliveryActor: string;
  now: number;
  /** Writes the answer message inside the redemption transaction. A throw rolls everything back. */
  writeAnswer(t: Driver): Promise<void>;
}

export type RedeemResult =
  | { ok: true; decision: Decision; messageId: string }
  | { ok: false; reason: RefusalReason };

interface TokenRow {
  token_hash: string;
  ask_id: string;
  ask_digest: string;
  action_class: string;
  channel: string;
  binding_id: string;
  binding_generation: number;
  required_assurance: string;
  expires_at: number;
  consumed_at: number | null;
}

/** Thrown inside the transaction to roll it back with a reason. */
class Refuse extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly row?: TokenRow,
  ) {
    super(reason);
  }
}

function auditDetail(row: TokenRow, input: RedeemInput, extra: Record<string, unknown>) {
  return {
    ask: row.ask_id,
    ask_digest: row.ask_digest,
    channel: row.channel,
    assurance: input.assurance,
    authorizer: input.authorizer,
    delivery_actor: input.deliveryActor,
    binding_id: row.binding_id,
    binding_generation: row.binding_generation,
    ...extra,
  };
}

/**
 * Redeem a token (ADR 623 §6). In ONE transaction: the token exists for this team, is unconsumed and
 * unexpired; the presented assurance is one the token allows; the ask is still open with the same
 * digest and the same class as recomputed now; the binding's generation is current. Then the decision
 * row is inserted (the per-ask primary key is the compare-and-set), the answer is written, and the
 * token is consumed. Any refusal or throw leaves nothing behind except the refusal's audit row.
 */
export async function redeemAskChannelToken(
  db: Driver,
  input: RedeemInput,
  checks: RedemptionChecks,
): Promise<RedeemResult> {
  const hash = sha256(input.token);
  try {
    const result = await db.tx(async (t): Promise<RedeemResult> => {
      const row = await t.get<TokenRow>(
        `SELECT token_hash, ask_id, ask_digest, action_class, channel, binding_id,
                binding_generation, required_assurance, expires_at, consumed_at
           FROM ask_channel_tokens WHERE token_hash = ? AND team_id = ?`,
        [hash, input.teamId],
      );
      if (!row) throw new Refuse('unknown_token');
      if (row.consumed_at !== null) throw new Refuse('consumed', row);
      if (input.now >= row.expires_at) throw new Refuse('expired', row);
      // A2 is never accepted until it exists; and a token that requires more than was presented fails.
      if (input.assurance === 'A2' || row.required_assurance !== input.assurance) {
        throw new Refuse('assurance', row);
      }
      const ask = await checks.askStanding(t, input.teamId, row.ask_id);
      if (!ask || !ask.open) throw new Refuse('conflict', row);
      if (ask.digest !== row.ask_digest) throw new Refuse('stale_revision', row);
      if (ask.actionClass !== 'advisory' || ask.actionClass !== row.action_class) {
        throw new Refuse('class_changed', row);
      }
      const standing = await checks.bindingStanding(
        t,
        input.teamId,
        row.binding_id,
        row.binding_generation,
      );
      if (standing === 'unavailable') throw new Refuse('no_binding_store', row);
      if (standing !== 'current') throw new Refuse('binding_stale', row);
      // Channel settings: turning answer off (or delivery off) removes answer authority
      // without touching the binding — refused here, before any decision is claimed.
      if (
        checks.answerEnabled &&
        !(await checks.answerEnabled(t, input.teamId, row.binding_id, row.channel))
      ) {
        throw new Refuse('answer_disabled', row);
      }

      // The compare-and-set: one decision per ask, whichever channel gets here first.
      const claimed = await t.run(
        `INSERT INTO ask_decisions (team_id, ask_id, token_hash, decision, message_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id, ask_id) DO NOTHING`,
        [input.teamId, row.ask_id, hash, input.decision, input.answerMessageId, input.now],
      );
      if (claimed.changes !== 1) throw new Refuse('conflict', row);

      await input.writeAnswer(t);

      const consumed = await t.run(
        'UPDATE ask_channel_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
        [input.now, hash],
      );
      if (consumed.changes !== 1) throw new Refuse('consumed', row);

      await appendAudit(t, input.teamId, {
        actor: null,
        action: 'channel.answer.advisory',
        target: row.ask_id,
        result: 'allow',
        detail: auditDetail(row, input, { decision: input.decision }),
      });
      return { ok: true, decision: input.decision, messageId: input.answerMessageId };
    });
    return result;
  } catch (err) {
    if (!(err instanceof Refuse)) throw err;
    // The transaction rolled back; the refusal itself is the one thing worth keeping.
    await appendAudit(db, input.teamId, {
      actor: null,
      action: 'channel.answer.refused',
      target: err.row?.ask_id ?? null,
      result: 'deny',
      detail: err.row
        ? auditDetail(err.row, input, { reason: err.reason })
        : { reason: err.reason, delivery_actor: input.deliveryActor },
    });
    return { ok: false, reason: err.reason };
  }
}
