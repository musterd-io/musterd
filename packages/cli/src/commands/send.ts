import { withTraceContext } from '@musterd/mcp';
import {
  type Act,
  askContract,
  askContractText,
  askProseChoiceNotice,
  AskTierSchema,
  chooseAutoTarget,
  CLI_REPLY_TO_STYLE,
  type BlockedBy,
  type Envelope,
  acceptedHandoffAck,
  deafRecipientNotice,
  disputeAnswerAck,
  laneAckAck,
  laneEscalationAck,
  laneSupersededAck,
  laneUnboundAck,
  laneVerdictAck,
  makeEnvelope,
  threadHintFor,
  threadHintText,
  MAX_ELIGIBLE,
  type Recipient,
} from '@musterd/protocol';
import { humanAskAnswerApproval } from '@musterd/protocol/approval';
import { ulid } from 'ulid';
import { flagStr, GLOBAL_FLAGS, parseMeta, rejectUnknownFlags, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { readBindingAt } from '../config.js';
import { CliError } from '../errors.js';
import { dischargedIds, openActionNeeded, renderMessageRow } from '../render/rows.js';
import { theme } from '../render/theme.js';
import { bindThread } from '../session/continuity.js';
import { findWorkspaceDir, kindLookup, resolve, sendOrEcho, viewerFlags } from './helpers.js';

/**
 * The value-flags `musterd send` reads. A flag outside this set (and the global ones) is a typo,
 * and a typo that eats the next argument is worse than a typo: it sends the wrong thing, or
 * nothing. Refused, with the shape (lane 01M5D5J8HQG688C0QWEN0633H2).
 */
/**
 * The flags `musterd send` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd send` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const SEND_FLAGS = [
  'act',
  'all',
  'anchor',
  'anchor-ref',
  'blocked-by',
  'closed',
  'eligible',
  'harness',
  'http',
  'huddle-',
  'huddles',
  'kind',
  'message',
  'open',
  'print',
  'ref',
  'reply-to',
  'room',
  'seat',
  'sig',
  'thread',
  'tier',
  'to',
  'topic',
  'turns',
  'until',
  'urgent-reason',
] as const;

/**
 * The acts whose MEANING is words. `accept`/`decline`/`wait`/`resolve` are decisions, not
 * statements, and may carry no body; a `message` or a `status_update` with no body is a silence
 * nobody asked for — and on every surface that renders one, it is indistinguishable from a
 * deliberate one.
 */
const WORD_ACT_NAMES = new Set(['message', 'status_update', 'request_help', 'steer', 'challenge']);

/**
 * Refuse an act whose meaning is words but which carries none. A blank act lands as a blank act:
 * it is stored, it counts in the acts log, and it renders as an empty message on every surface that
 * shows one — indistinguishable from a deliberate silence. (Lane `01M5D5J8HQG688C0QWEN0633H2`:
 * three messages and two status_updates reached their recipients with zero bytes, each reported as
 * sent, because an unknown flag had eaten the body.)
 */
export function requireWords(act: string, body: string): void {
  if (body.trim() !== '') return;
  if (!WORD_ACT_NAMES.has(act)) return;
  throw new CliError(
    `a ${act} needs words — the body is positional: musterd send --to <name|a,b|@team> --act ${act} <body...>`,
    2,
  );
}

/**
 * The act `accept`/`decline` answers, when the caller didn't name one (ADR 067). Auto-targets the
 * **latest still-open request_help/handoff** waiting for this member — so answering is one command,
 * not `inbox --json | parse the id | --reply-to <id>`. Returns the envelope to reply to, or undefined
 * if nothing is open (then the caller errors with guidance). Best-effort: a read failure → undefined.
 */
async function openRequests(http: HttpClient, team: string, me: string): Promise<Envelope[]> {
  try {
    const [res, viewer] = await Promise.all([
      http.inbox(team, { unread: false, peek: true }),
      viewerFlags(http, team, me),
    ]);
    const open = openActionNeeded(
      res.messages,
      me,
      res.answered ?? [],
      dischargedIds(res),
      viewer,
    ).filter(
      (m) =>
        m.act === 'request_help' || m.act === 'handoff' || m.act === 'challenge' || m.act === 'ask',
    );
    return open.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

function parseRecipient(to: string): Recipient {
  if (to === '@team') return { kind: 'team' };
  if (to === '@broadcast') return { kind: 'broadcast' };
  if (to.startsWith('@'))
    throw new CliError(`unknown recipient "${to}" (use @team or @broadcast)`, 2);
  return { kind: 'member', name: to };
}

/**
 * ADR 254: `--to a,b` names an eligible set — 2–MAX_ELIGIBLE seats, any one of whom can answer.
 *
 * Mirrors the MCP surface's arity rules on purpose (empty → `@team`, one name → a directed act,
 * 2–4 → a team act carrying `meta.eligible`, 5+ → refused), each package keeping its own error
 * convention. A single value keeps its EXACT existing behaviour, including the `@alias` rejection,
 * so nothing a seat types today changes meaning.
 */
export function parseRecipients(to: string): { to: Recipient; eligible: string[] | null } {
  const names = to
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  // A trailing comma or a stray space is a typo, not an intent to address nobody — so a list that
  // collapses to one name is a directed act, and one that collapses to none is `@team`.
  if (names.length <= 1) return { to: parseRecipient(names[0] ?? '@team'), eligible: null };
  if (names.length > MAX_ELIGIBLE) {
    throw new CliError(
      `too many recipients (${names.length}) — name at most ${MAX_ELIGIBLE} seats, or use @team`,
      2,
    );
  }
  // `@team`/`@broadcast` are whole-audience aliases, not seats. Dropping one silently would send to
  // a narrower audience than was asked for, so it is refused.
  const alias = names.find((n) => n.startsWith('@'));
  if (alias) {
    throw new CliError(`"${alias}" cannot appear in a list of seats — send to it on its own`, 2);
  }
  return { to: { kind: 'team' }, eligible: names };
}

/**
 * Incident convergence increment 2 — the CLI half of the report contract.
 *
 * Increment 1 shipped `meta.blocked_by` and measured zero reports. One reason is mechanical: a CLI
 * seat could not express the report at all. `--meta` coerces every value to a string, number, or
 * boolean (`args.ts` `coerce`), so `--meta blocked_by.gate=…` lands as a FLAT key and never becomes
 * the nested object the daemon clusters on. This flag is that missing path, and it deliberately
 * spells the whole report — a seat should be able to file one from the line the failing gate printed,
 * without knowing what envelope meta is.
 *
 * The report rides `status_update` (spec §1 — no new act), so a bare `--blocked-by` supplies the act
 * and any other act is refused rather than silently filed somewhere the clustering never looks.
 */
export function blockedByFlags(
  flags: Record<string, string | boolean>,
  act: Act | undefined,
): { act: Act; report: BlockedBy } | null {
  if (flags['blocked-by'] === undefined) return null;
  const gate = flagStr(flags, 'blocked-by')?.trim();
  if (!gate) {
    throw new CliError(
      '--blocked-by wants the gate — the exact check name, e.g. --blocked-by "ci:gates/A11y contrast"',
      2,
    );
  }
  if (act !== undefined && act !== 'status_update') {
    throw new CliError(
      `--blocked-by files a shared-blocker report, which rides status_update — not --act ${act}. Drop --act (it is implied) or send the report separately.`,
      2,
    );
  }
  // Empty --ref/--sig are dropped rather than passed through: the protocol requires min(1) on both,
  // so a shell variable that expanded to nothing would turn a good report into a rejected envelope.
  const ref = flagStr(flags, 'ref')?.trim();
  const sig = flagStr(flags, 'sig')?.trim();
  return {
    act: 'status_update',
    report: { gate, ...(ref ? { ref } : {}), ...(sig ? { sig } : {}) },
  };
}

export async function sendCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it —
  // `musterd send --to x --act message --body "text"` sends an act with an empty body and reports
  // success. Refuse the flag instead, before anything is composed (lane 01M5D5J8HQG688C0QWEN0633H2).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...SEND_FLAGS],
    'the body is positional: musterd send --to <name|a,b|@team> --act <act> <body...>',
  );
  const { team, identity, http } = resolve(parsed.flags);
  const to = flagStr(parsed.flags, 'to') ?? '@team';
  // A shared-blocker report supplies its own act (status_update, spec §1), so `--blocked-by` alone is
  // a complete command — which is the whole point: the failing gate prints one line a seat can paste.
  const blocked = blockedByFlags(parsed.flags, flagStr(parsed.flags, 'act') as Act | undefined);
  const act = blocked?.act ?? (flagStr(parsed.flags, 'act') as Act | undefined);
  if (!act)
    throw new CliError('usage: musterd send --to <name|a,b|@team> --act <act> <body...>', 2);
  // A pasted `--blocked-by` one-liner may carry no prose at all. The envelope allows an empty body,
  // but a blank status_update reads as noise on every surface that renders one, so the report speaks
  // for itself when the seat did not.
  const body =
    parsed.positionals.join(' ') ||
    (blocked ? `blocked by ${blocked.report.gate} — parked, not debugging it` : '');
  // An act whose MEANING is words, sent with no words, is never what was meant — and an empty act
  // is indistinguishable, on every surface that renders one, from a deliberate silence. The acts
  // that are a decision rather than a statement (accept/decline/wait/resolve) may carry no body:
  // their meaning is the act itself. Lane 01M5D5J8HQG688C0QWEN0633H2.
  requireWords(act, body);
  const replyTo = flagStr(parsed.flags, 'reply-to');

  const meta = parseMeta(parsed.metaPairs) ?? {};
  if (blocked) meta['blocked_by'] = blocked.report;
  if (replyTo) meta['in_reply_to'] = replyTo;

  // accept/decline auto-targeting (ADR 067): when answering without an explicit reply target, point at
  // the latest open request_help/handoff for this member and inherit its thread, so closing the loop is
  // one command. An explicit --reply-to / --meta in_reply_to / --thread always wins.
  let thread = flagStr(parsed.flags, 'thread');
  if ((act === 'accept' || act === 'decline') && !replyTo && !meta['in_reply_to']) {
    const open = await openRequests(http, team, identity.name);
    // One rule, in `@musterd/protocol`, shared with the MCP adapter — see `chooseAutoTarget` for
    // why having written it twice is what let it be wrong in both places for so long.
    const decision = chooseAutoTarget(open, act, CLI_REPLY_TO_STYLE);
    if (decision.kind !== 'target') throw new CliError(decision.message, 2);
    const target = decision.target as Envelope;
    meta['in_reply_to'] = target.id;
    thread ??= target.thread ?? target.id;
  }
  // Urgency breakthrough (ADR 044): `--urgent` flags the envelope so it pierces an away/dnd
  // recipient's hold; `--urgent-reason` is required (the protocol rejects urgent without it). UNGATED
  // on localhost — the `can_flag_urgent` capability that scopes who may flag is the v0.3 seam.
  if (parsed.flags['urgent'] === true) {
    meta['urgent'] = true;
    const reason = flagStr(parsed.flags, 'urgent-reason');
    if (reason) meta['urgent_reason'] = reason;
  }

  // ADR 254: resolve `--to` before composing. This can REFUSE (too many names, an alias inside a
  // list), and it must do so outside the try below — that catch relabels everything as
  // "invalid message", which would bury a precise, actionable recipient error.
  const { to: recipientTo, eligible } = parseRecipients(to);
  if (eligible) meta['eligible'] = eligible;

  let envelope;
  try {
    envelope = makeEnvelope({
      id: ulid(),
      team,
      from: identity.name,
      to: recipientTo,
      act,
      body,
      thread: thread ?? null,
      // Attach the active trace context as meta.otel (ADR 011 sender SHOULD) — live whenever the
      // CLI telemetry SDK wrapped this command in a span (ADR 089), inert otherwise.
      meta: withTraceContext(Object.keys(meta).length ? meta : null),
    });
  } catch (err) {
    throw new CliError(`invalid message: ${(err as Error).message}`, 3);
  }

  const ackBody = await sendOrEcho(async () => {
    let response: Awaited<ReturnType<HttpClient['send']>>;
    try {
      response = await http.send(team, envelope);
    } catch (err) {
      const askId = envelope.meta?.['in_reply_to'];
      if (
        !identity.key.startsWith('mscr_') ||
        (act !== 'accept' && act !== 'decline') ||
        typeof askId !== 'string' ||
        !(err instanceof CliError && /authority refused \(no_signature\)/.test(err.message))
      )
        throw err;
      const authority = humanAskAnswerApproval(askId, act);
      process.stdout.write('This answer needs your passkey.\n');
      const { collectApproval } = await import('./authority.js');
      const approval = await collectApproval(
        http,
        team,
        authority.act,
        authority.target,
        authority.payload,
      );
      return http.send(team, {
        ...envelope,
        meta: { ...envelope.meta, approval },
      });
    }

    const refused = response.lane_authority_refused;
    if (!refused) return response;
    if (
      !identity.key.startsWith('mscr_') ||
      (act !== 'accept' && act !== 'decline') ||
      refused.reason !== 'no_signature'
    ) {
      throw new CliError(
        `authority refused (${refused.reason}): this lane verdict did not count; no success was reported`,
        1,
      );
    }

    process.stdout.write('This answer needs your passkey.\n');
    const { collectApproval, laneReviewApproval } = await import('./authority.js');
    const authority = laneReviewApproval(refused.lane, act);
    const approval = await collectApproval(
      http,
      team,
      authority.act,
      authority.target,
      authority.payload,
    );
    // The unsigned attempt already landed as an uncounted message. Use a new id for the signed
    // retry so idempotency cannot turn the refusal into a false success.
    const signed = makeEnvelope({
      id: ulid(),
      team: envelope.team,
      from: envelope.from,
      to: envelope.to,
      act: envelope.act,
      body: envelope.body,
      thread: envelope.thread ?? null,
      meta: { ...(envelope.meta ?? {}), approval },
    });
    const retried = await http.send(team, signed);
    if (retried.lane_authority_refused) {
      throw new CliError(
        `authority refused (${retried.lane_authority_refused.reason}): this lane verdict did not count; no success was reported`,
        1,
      );
    }
    return retried;
  }, envelope);

  // ADR 210: a successful threaded send means this session IS the dialogue on that thread, which is
  // exactly the causal fact a later wake needs and the daemon can never learn. Bind it locally.
  // Deliberately after the send and deliberately swallowing failure: the registry is an
  // optimization, and a send that succeeded must never report failure because a local cache write
  // did. The worst case is a fresh wake, which is always correct.
  if (envelope.thread) {
    try {
      const dir = findWorkspaceDir();
      const binding = dir ? readBindingAt(dir) : null;
      if (dir && binding?.session) {
        bindThread(dir, {
          team,
          seat: identity.name,
          thread_id: envelope.thread,
          capture: binding.session,
          now: Date.now(),
        });
      }
    } catch {
      // never fatal — see above
    }
  }

  // The ask's tier contract (ADR 147 §2), at parity with the MCP `team_send` response: when an agent
  // raises an `ask` from the CLI it gets the same marching orders — how long to wait, and what to do on
  // silence — via the shared `askContractText`, so the CLI is no longer the one ask surface that stays
  // silent about the wait/hold contract (finding 006 item 3). A valid `ask` always carries a tier
  // (enforced by makeEnvelope above), so the narrowing here only guards a malformed meta.
  const tier = envelope.meta?.['tier'];
  const askTier =
    act === 'ask' && AskTierSchema.safeParse(tier).success ? AskTierSchema.parse(tier) : null;

  // Lane 01M3TB3C0D: a root `message` to a member who has an open directed act waiting on the
  // sender leaves that act open and unjoinable. One inbox read, best-effort, after the send — the
  // hint names the thread to join next time; nothing is blocked.
  const threadHint =
    act === 'message' && recipientTo.kind === 'member' && !envelope.thread
      ? threadHintFor(await openRequests(http, team, identity.name), recipientTo.name)
      : null;

  if (parsed.flags['json']) {
    // Additive, id-preserving: programmatic callers still read `.id`, and now get the derived contract
    // (mirrors the MCP structured `ask_contract`) without a second round-trip to the tier table.
    // Prefer the daemon-derived contract (carries `unblocker_reachable`, ADR 153); the pure local
    // contract stands when an older daemon omits it.
    const payload = {
      ...(askTier
        ? { ...envelope, ask_contract: ackBody?.ask_contract ?? askContract(askTier) }
        : envelope),
      ...(ackBody?.lane_verdict ? { lane_verdict: ackBody.lane_verdict } : {}),
      ...(ackBody?.lane_ack ? { lane_ack: ackBody.lane_ack } : {}),
      ...(ackBody?.lane_superseded ? { lane_superseded: ackBody.lane_superseded } : {}),
      ...(ackBody?.lane_unbound ? { lane_unbound: ackBody.lane_unbound } : {}),
      ...(ackBody?.deaf_recipient ? { deaf_recipient: ackBody.deaf_recipient } : {}),
      ...(ackBody?.evidence_notice ? { evidence_notice: ackBody.evidence_notice } : {}),
      ...(threadHint ? { thread_hint: threadHint } : {}),
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
    return 0;
  }
  // Echo the sent row; resolve kinds best-effort for coloring.
  let kindOf = (_: string) => 'agent' as const;
  try {
    const roster = await http.roster(team);
    kindOf = kindLookup(roster.members) as typeof kindOf;
  } catch {
    // roster is best-effort for color only
  }
  process.stdout.write(renderMessageRow(envelope, kindOf) + '\n');
  process.stdout.write(`${theme.ok('✓')} sent\n`);
  if (ackBody?.deaf_recipient)
    process.stdout.write(
      theme.dim(
        deafRecipientNotice(ackBody.deaf_recipient.recipient, ackBody.deaf_recipient.reason),
      ) + '\n',
    );
  if (askTier)
    process.stdout.write(
      theme.dim(askContractText(envelope.id, askTier, ackBody?.ask_contract?.unblocker_reachable)) +
        '\n',
    );
  // ADR 684, at parity with the MCP reply: an ask whose options are prose reaches the human as
  // Approve / Deny.
  const proseChoice = act === 'ask' ? askProseChoiceNotice(envelope.body ?? '') : null;
  if (proseChoice) process.stdout.write(theme.warn(`⚠ ${proseChoice}`) + '\n');
  // ADR 202's consequence, at parity with the MCP reply (lane 01M2GQFJXG): an accept that answered
  // a lane_review ask closed the lane — the sender is told here, not left to find it on the board.
  // Lane 01M2KYF888: the text is protocol's, not this file's. It used to be written shorter here
  // and dropped the recovery clause, so a terminal reader learned that a teammate's lane had
  // closed and not that `decline` would fail to reopen it.
  const verdict = ackBody?.lane_verdict;
  if (verdict) process.stdout.write(theme.dim(laneVerdictAck(verdict).guidance) + '\n');
  // Lane 01M2P2E2H6: and the acknowledge, at the same parity. A `wait` on an acceptance ask is
  // recorded and moves nothing — worth one line, because the whole point of offering the move is
  // that the sender can tell it apart from the one that decides.
  const laneAck = ackBody?.lane_ack;
  if (laneAck) process.stdout.write(theme.dim(laneAckAck(laneAck).guidance) + '\n');
  // ADR 539: the peer stage on a risky lane, at the same parity — closed nothing, and who holds it.
  if (ackBody?.lane_escalation)
    process.stdout.write(theme.dim(laneEscalationAck(ackBody.lane_escalation).guidance) + '\n');
  // ADR 545: a reply on an ask a re-route had closed, at the same parity — moved nothing, and which
  // ask binds now.
  if (ackBody?.lane_superseded)
    process.stdout.write(theme.dim(laneSupersededAck(ackBody.lane_superseded).guidance) + '\n');
  // ADR 680: a verdict on a lane that had left the acceptance stage, at the same parity — it bound
  // to nothing, and the lane's state is named.
  if (ackBody?.lane_unbound)
    process.stdout.write(theme.dim(laneUnboundAck(ackBody.lane_unbound).guidance) + '\n');
  // ADR 505: the owner's answer to a review dispute, at the same parity — the text is protocol's.
  if (ackBody?.dispute)
    process.stdout.write(theme.dim(disputeAnswerAck(ackBody.dispute).guidance) + '\n');
  // ADR 505 §6: an accept that took a handoff — the sender's note back, with the check line.
  if (ackBody?.accepted_handoff)
    process.stdout.write(theme.dim(acceptedHandoffAck(ackBody.accepted_handoff)) + '\n');
  // ADR 484: the challenge-evidence rail, at parity with the MCP reply — sender-only, one line.
  if (ackBody?.evidence_notice)
    process.stdout.write(theme.warn(`⚠ ${ackBody.evidence_notice}`) + '\n');
  if (threadHint && recipientTo.kind === 'member')
    process.stdout.write(
      theme.warn(`⚠ ${threadHintText(threadHint, recipientTo.name, CLI_REPLY_TO_STYLE)}`) + '\n',
    );
  return 0;
}
