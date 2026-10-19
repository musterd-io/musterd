import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as p from '@clack/prompts';
import {
  type Binding,
  bindingSeat,
  type Capabilities,
  effectiveCapabilities,
  type EnforcementClass,
  type EnforcementPosture,
  LaneStakesSchema,
  type Lifecycle,
  type MemberKind,
  type PolicyOverride,
  parseSeatFile,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  SPEND_CAP_USD_MAX,
  UNPRICED_WAKE_CAP_MAX,
  type StakesDefault,
  TOKEN_PREFIXES,
  GuardianClassSchema,
  GuardianTierSchema,
  type TeamFile,
} from '@musterd/protocol';
import {
  HUE_MIN_SEPARATION,
  assignHue,
  defaultHue,
  hueConflict,
  legacyHue,
  nearestClearHue,
  type HueKind,
} from '@musterd/protocol/hue';
import { flagHue, flagStr, fmtDurationMs, parseDurationMs, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  excludeCredentialFromGit,
  findBinding,
  loadConfig,
  readBindingAt,
  recordRosterHome,
  rememberIdentity,
  saveBinding,
  saveConfig,
} from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { hint, success, sym } from '../render/ui.js';
import {
  publishSeatFile,
  readSeatFiles,
  readSeatHues,
  seatFilePath,
  seatFileUnpublished,
  seatPublishLines,
  type SeatPublishOutcome,
  seatReachLines,
  setSeatHue,
  unpublishedSeatLines,
  writeSeatFile,
} from '../roster.js';
import { cliBuild } from '../version.js';
import { findWorkspaceDir, inherited, rejectAs, resolve, resolveRead } from './helpers.js';
import { teamPolicyStyle } from './policy.js';

export async function teamCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'create') return teamCreate(parsed);
  if (sub === 'add') return teamAdd(parsed);
  if (sub === 'observe') return teamObserve(parsed);
  if (sub === 'credential') return teamCredential(parsed);
  if (sub === 'agent-key') return teamAgentKey(parsed);
  if (sub === 'bootstrap') return teamBootstrap(parsed);
  if (sub === 'grant') return teamGrant(parsed);
  if (sub === 'invite') return teamInvite(parsed);
  if (sub === 'remove') return teamRemove(parsed);
  if (sub === 'ceiling') return teamCeiling(parsed);
  if (sub === 'archive') return teamArchive(parsed);
  if (sub === 'export') return teamExport(parsed);
  // ADR 514: `team policy style …` is the one positional area; every other knob is a flag.
  if (sub === 'policy' && parsed.positionals[1] === 'style')
    return teamPolicyStyle({ ...parsed, positionals: parsed.positionals.slice(1) });
  if (sub === 'policy') return teamPolicy(parsed);
  if (sub === 'hue') return teamHue(parsed);
  throw new CliError(
    'usage: musterd team <create|add|observe|credential|agent-key|bootstrap|grant|invite|remove|ceiling|archive|export|policy|hue> ...',
    2,
  );
}

/**
 * `musterd team ceiling <name> guest|none` — ADR 621 §6. An admin narrows a member to talk-only
 * (`guest`) or lifts the ceiling (`none`). The daemon applies it on the member's next request.
 */
async function teamCeiling(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const value = parsed.positionals[2];
  if (!name || (value !== 'guest' && value !== 'none'))
    throw new CliError('usage: musterd team ceiling <name> guest|none [--team <slug>]', 2);
  const { team, http } = resolve(parsed.flags);
  const out = await http.setMemberCeiling(team, name, value === 'guest' ? 'guest' : null);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(out) + '\n');
    return 0;
  }
  process.stdout.write(
    success(
      out.ceiling === 'guest'
        ? `${out.member} is a guest on ${team} ${theme.meta('— can talk, cannot coordinate')}`
        : `${out.member} has no ceiling on ${team} ${theme.meta('— a full member again')}`,
    ) + '\n',
  );
  return 0;
}

/**
 * `musterd team invite create|list|revoke` — ADR 450. An invite lets a stranger's OAuth sign-in
 * admit a NEW human member. The link value and room code are printed once; `list` is redacted.
 */
async function teamInvite(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;
  const whenFlag = (flag: string): number | undefined => {
    const raw = flagStr(parsed.flags, flag);
    if (!raw) return undefined;
    const iso = Date.parse(raw);
    if (!Number.isNaN(iso)) return iso;
    return Date.now() + parseDurationMs(raw, `--${flag}`);
  };
  const intFlag = (flag: string): number | undefined => {
    const raw = flagStr(parsed.flags, flag);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new CliError(`--${flag} must be a positive integer`, 2);
    return n;
  };

  if (action === 'create') {
    const minted = await http.mintInvite(team, {
      ...(intFlag('uses') !== undefined ? { max_uses: intFlag('uses')! } : {}),
      ...(intFlag('fail-budget') !== undefined ? { fail_budget: intFlag('fail-budget')! } : {}),
      ...(whenFlag('expires') !== undefined ? { expires_at: whenFlag('expires')! } : {}),
      ...(whenFlag('member-until') !== undefined
        ? { member_until: whenFlag('member-until')! }
        : {}),
      // ADR 621 §5: an invite admits talk-only guests unless --member says otherwise.
      ceiling: parsed.flags['member'] === true ? 'member' : 'guest',
    });
    if (json) {
      process.stdout.write(JSON.stringify(minted) + '\n');
      return 0;
    }
    process.stdout.write(success(`minted invite ${minted.invite.selector} for ${team}`) + '\n');
    process.stdout.write(theme.meta('shown once — put these on the slide / join page now:') + '\n');
    process.stdout.write(`  room code:  ${minted.room_code}\n`);
    process.stdout.write(`  link value: ${minted.link_secret}\n`);
    process.stdout.write(
      theme.meta(
        `invite id: ${minted.invite.id} · ${minted.invite.max_uses} uses · burns after ${minted.invite.fail_budget} wrong codes · expires ${new Date(minted.invite.expires_at).toISOString()}` +
          (minted.invite.member_until
            ? ` · members until ${new Date(minted.invite.member_until).toISOString()}`
            : '') +
          (minted.invite.ceiling === 'guest'
            ? ' · admits guests (talk only; --member admits members)'
            : minted.invite.ceiling === null
              ? ' · admits members'
              : ''),
      ) + '\n',
    );
    return 0;
  }

  if (action === 'list') {
    const { invites } = await http.listInvites(team);
    if (json) {
      process.stdout.write(JSON.stringify({ invites }) + '\n');
      return 0;
    }
    if (invites.length === 0) {
      process.stdout.write(theme.meta(`no invites on ${team}`) + '\n');
      return 0;
    }
    for (const inv of invites) {
      process.stdout.write(
        `${inv.id}  ${inv.selector}  ${inv.state}  uses ${inv.uses}/${inv.max_uses}  failures ${inv.failures}/${inv.fail_budget}  expires ${new Date(inv.expires_at).toISOString()}\n`,
      );
    }
    return 0;
  }

  if (action === 'revoke') {
    const id = parsed.positionals[2];
    if (!id) throw new CliError('usage: musterd team invite revoke <invite-id>', 2);
    const result = await http.revokeInvite(team, id);
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(success(`revoked invite ${id}`) + '\n');
    return 0;
  }

  throw new CliError(
    'usage: musterd team invite <create|list|revoke> [--uses <n>] [--fail-budget <n>] [--expires <iso|duration>] [--member-until <iso|duration>]',
    2,
  );
}

/** Same daemon, ignoring a trailing slash. */
const sameServer = (a: string, b: string): boolean =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Whether `dir`'s binding is this seat on this team AT this daemon. The server check matters: the
 * harness presents `agent_key` to its binding's `server`, so a key minted here but written into a
 * folder that points at another daemon (same slug, different host) would be handed to that daemon.
 */
function installMismatch(dir: string, team: string, seat: string, server: string): string | null {
  const binding = readBindingAt(dir);
  if (!binding) return `${dir} has no .musterd/binding.json to install into`;
  if (binding.team !== team || bindingSeat(binding) !== seat) {
    return `${dir} is bound to ${bindingSeat(binding) ?? 'no fixed seat'} on ${binding.team}, not ${seat} on ${team}`;
  }
  if (!sameServer(binding.server, server)) {
    return `${dir} points at ${binding.server}, but this credential would be minted on ${server} — run the mint against that folder's daemon`;
  }
  return null;
}

/**
 * The one Workspace on this machine that `bootstrap mint --install` writes into: `--into`, checked
 * against its binding, or else the single folder the bindings registry (ADR 020) records for this
 * seat on this team and daemon. Zero or several is a refusal naming `--into` — never a guess at
 * where a live credential goes (lane 01M4E4MGCZ: without this the key was hand-edited in and pasted
 * into chat).
 */
function installTarget(
  team: string,
  seat: string,
  server: string,
  into: string | undefined,
): string {
  if (into !== undefined) {
    const dir = resolvePath(into);
    const mismatch = installMismatch(dir, team, seat, server);
    if (mismatch) throw new CliError(mismatch, 6);
    return dir;
  }
  const dirs = Object.entries(loadConfig().bindings)
    .filter(([, ref]) => ref.team === team && ref.seat === seat)
    .map(([dir]) => dir)
    .filter((dir) => installMismatch(dir, team, seat, server) === null);
  if (dirs.length === 0) {
    throw new CliError(
      `no Workspace bound to ${seat} on ${team} at ${server} is recorded on this machine — pass --into <folder>`,
      6,
    );
  }
  if (dirs.length > 1) {
    throw new CliError(
      `${dirs.length} Workspaces are bound to ${seat} on ${team} — pick one with --into <folder>:\n` +
        dirs.map((dir) => `  ${dir}`).join('\n'),
      6,
    );
  }
  return dirs[0]!;
}

/** Admin lifecycle for ADR 344's independently scoped bootstrap credentials. */
async function teamBootstrap(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  const { team, http } = resolve(parsed.flags);
  const server = http.server;
  const json = parsed.flags['json'] === true;

  if (action === 'mint') {
    const scopes = [
      ['claim_seat', flagStr(parsed.flags, 'seat')],
      ['claim_role', flagStr(parsed.flags, 'role')],
      ['host', flagStr(parsed.flags, 'host')],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (scopes.length !== 1) {
      throw new CliError(
        'bootstrap mint needs exactly one of --seat <name>, --role <name>, or --host <label>',
        2,
      );
    }
    const expiresIn = flagStr(parsed.flags, 'expires-in');
    const expiresAt = expiresIn
      ? Date.now() + parseDurationMs(expiresIn, '--expires-in')
      : undefined;
    const [use, target] = scopes[0]!;
    const install = parsed.flags['install'] === true;
    if (install && use !== 'claim_seat') {
      throw new CliError(
        '--install needs --seat <name>: only a seat has a Workspace to install into',
        2,
      );
    }
    // Resolve the destination BEFORE minting, so a refusal leaves no live credential behind.
    const installDir = install
      ? installTarget(team, target, server, flagStr(parsed.flags, 'into'))
      : undefined;
    const minted = await http.mintBootstrapCredential(team, {
      use: use as 'claim_seat' | 'claim_role' | 'host',
      target,
      ...(flagStr(parsed.flags, 'label') ? { label: flagStr(parsed.flags, 'label')! } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    });

    if (installDir !== undefined) {
      let written: string;
      try {
        // Re-check after the mint: the folder must still be this seat at this daemon.
        const mismatch = installMismatch(installDir, team, target, server);
        if (mismatch) throw new Error(mismatch);
        written = saveBinding(installDir, {
          ...readBindingAt(installDir)!,
          agent_key: minted.agent_key,
        });
      } catch (err) {
        // Written nowhere, so it must not stay live.
        await http.revokeBootstrapCredential(team, minted.credential.id).catch(() => undefined);
        throw new CliError(
          `could not write ${installDir}: ${(err as Error).message} — the new credential was revoked; the binding is unchanged`,
          1,
        );
      }
      if (json) {
        process.stdout.write(
          JSON.stringify({ credential: minted.credential, installed: written }) + '\n',
        );
        return 0;
      }
      process.stdout.write(
        success(`minted a seat bootstrap credential for ${target} and installed it`) + '\n',
      );
      process.stdout.write(`  ${written}\n`);
      // ADR 591: a credential installed for a seat the hub cannot resolve is a seat whose every
      // event will hold the hub — the install is where that is cheapest to say.
      const reach = seatReachLines(target, loadConfig().rosterHome[team], 'agent');
      if (reach) {
        process.stdout.write(
          theme.warn(`  ! ${reach[0]}`) + '\n' + theme.meta(`    ${reach[1]}`) + '\n',
        );
      }
      process.stdout.write(
        theme.meta('written straight to the binding and not printed — nothing to copy.') + '\n',
      );
      process.stdout.write(theme.meta(`credential id: ${minted.credential.id}`) + '\n');
      process.stdout.write(
        hint(`next, from that folder: musterd claim ${target}  (or start its harness)`) + '\n',
      );
      return 0;
    }

    if (json) {
      process.stdout.write(JSON.stringify(minted) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`minted ${minted.credential.use} bootstrap credential for ${target}`) + '\n',
    );
    process.stdout.write(theme.meta('shown once — never paste it into a chat:') + '\n');
    process.stdout.write(`  ${minted.agent_key}\n`);
    process.stdout.write(theme.meta(`credential id: ${minted.credential.id}`) + '\n');
    if (use === 'claim_seat') {
      process.stdout.write(
        hint(
          `the seat's Workspace is on this machine? use musterd team bootstrap mint --seat ${target} --install — it writes the key there unprinted (then revoke ${minted.credential.id})`,
        ) + '\n',
      );
    }
    return 0;
  }

  if (action === 'list') {
    const inventory = await http.listBootstrapCredentials(team);
    if (json) {
      process.stdout.write(JSON.stringify(inventory) + '\n');
      return 0;
    }
    if (inventory.credentials.length === 0) {
      process.stdout.write(theme.meta(`no bootstrap credentials on ${team}`) + '\n');
      return 0;
    }
    for (const credential of inventory.credentials) {
      const target = credential.target ? ` ${credential.target}` : '';
      const label = credential.label ? ` · ${credential.label}` : '';
      process.stdout.write(
        `${credential.id}  ${credential.state}  ${credential.use}${target}${label}\n`,
      );
    }
    return 0;
  }

  if (action === 'revoke') {
    const id = parsed.positionals[2];
    if (!id) throw new CliError('usage: musterd team bootstrap revoke <credential-id>', 2);
    const result = await http.revokeBootstrapCredential(team, id);
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(success(`revoked bootstrap credential ${id}`) + '\n');
    return 0;
  }

  if (action === 'cutover') {
    const readiness = await http.bootstrapCutoverReadiness(team);
    const force = parsed.flags['force'] === true;
    const yes = parsed.flags['yes'] === true;
    const hasUnmet = readiness.unmet_seats.length > 0 || readiness.unmet_hosts.length > 0;

    if (readiness.already_cut_over) {
      const result = { ok: true, already_cut_over: true, forced: false, readiness };
      if (json) process.stdout.write(JSON.stringify(result) + '\n');
      else process.stdout.write(success(`legacy bootstrap already cut over on ${team}`) + '\n');
      return 0;
    }

    if (hasUnmet && !force) {
      if (json) {
        process.stdout.write(JSON.stringify({ ok: false, readiness }) + '\n');
      } else {
        process.stdout.write('legacy bootstrap cutover is not ready\n');
        process.stdout.write(
          `  seats: ${readiness.unmet_seats.map((seat) => seat.name).join(', ') || 'none'}\n`,
        );
        process.stdout.write(`  hosts: ${readiness.unmet_hosts.join(', ') || 'none'}\n`);
        process.stdout.write(
          'repair: migrate each Workspace and verify each host credential in use\n',
        );
      }
      return 1;
    }

    if (!yes) {
      if (!process.stdin.isTTY) {
        throw new CliError(
          force
            ? 'non-interactive forced cutover requires both --force and --yes'
            : 'non-interactive cutover requires --yes',
          2,
        );
      }
      const targets = hasUnmet
        ? ` Unmet targets: ${[
            ...readiness.unmet_seats.map((seat) => seat.name),
            ...readiness.unmet_hosts,
          ].join(', ')}.`
        : '';
      const answer = await p.confirm({
        message: `Permanently disable "${team}"'s legacy Team-wide bootstrap key?${targets}`,
        initialValue: false,
      });
      if (p.isCancel(answer) || answer !== true) {
        process.stdout.write(theme.meta('cutover cancelled; nothing changed') + '\n');
        return 0;
      }
    }

    const result = await http.cutoverLegacyBootstrap(team, force);
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else {
      process.stdout.write(success(`retired "${team}"'s legacy Team bootstrap key`) + '\n');
      if (force && hasUnmet) {
        process.stdout.write(
          theme.warn(
            `${sym.warn} forced with unmet targets: ${[
              ...readiness.unmet_seats.map((seat) => seat.name),
              ...readiness.unmet_hosts,
            ].join(', ')}`,
          ) + '\n',
        );
      }
    }
    return 0;
  }

  throw new CliError(
    'usage: musterd team bootstrap <mint|list|revoke|cutover> [--seat|--role|--host ...]',
    2,
  );
}

/** Human-admin inventory and revocation for seat grants (ADR 580). */
async function teamGrant(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (action === 'list') {
    const grants = await http.grants(team);
    if (json) {
      process.stdout.write(JSON.stringify({ team, grants }) + '\n');
      return 0;
    }
    if (grants.length === 0) {
      process.stdout.write(theme.meta(`no grants on ${team}`) + '\n');
      return 0;
    }
    for (const grant of grants) {
      const state = grant.revoked
        ? 'revoked'
        : grant.expires_at !== null && grant.expires_at <= Date.now()
          ? 'expired'
          : 'active';
      const expires =
        grant.expires_at === null ? '' : ` · expires ${new Date(grant.expires_at).toISOString()}`;
      process.stdout.write(
        `${grant.id}  ${state}  ${grant.scope}:${grant.target}  ${grant.lifetime}${expires}\n`,
      );
    }
    return 0;
  }

  if (action === 'revoke') {
    const id = parsed.positionals[2];
    if (!id) throw new CliError('usage: musterd team grant revoke <id>', 2);
    const result = await http.revokeGrant(team, id);
    if (json) process.stdout.write(JSON.stringify({ team, id, ...result }) + '\n');
    else process.stdout.write(success(`revoked grant ${id} on ${team}`) + '\n');
    return 0;
  }

  throw new CliError('usage: musterd team grant <list|revoke <id>>', 2);
}

/**
 * `musterd team policy [--reseat-known-agents on|off] [--ask-fallback-to-nonadmin on|off]
 * [--review-loop on|off] [--dispatch-loop on|off] [--sweep-loop on|off]
 * [--ask-slack-webhook <url|off>] [--stakes-default <surface>=<low|normal|high>|off]
 * [--guardian-tier <class>=<observe|alert|auto>|off] [--trace-content on|off]
 * [--agent-connect sponsor|any_member] [--invite-requires-expiry on|off]
 * [--sponsored-agent-cap <1–100>] [--spend-cap <usd|off>] [--spend-approval <usd|off>]
 * [--unpriced-wake-cap <n|off>] [--acceptance-review-window <1–1440 minutes>]
 * [--hosted-budget <usd|off>]` — show or set the
 * team governance policy (admin-only, audited `policy.change`). ADR 146: `--reseat-known-agents on`
 * opts the team into dogfood-mode re-seat — an already-held agent seat re-occupies without an admin
 * decision. ADR 147: `--ask-fallback-to-nonadmin on` lets an admin-unanswered ask fall back to
 * non-admin humans past its tier timeout. ADR 191: `--review-loop on` arms the review work-order
 * loop; ADR 199: `--dispatch-loop on` arms the dispatch work-order loop; ADR 229: `--sweep-loop on`
 * arms the acceptance backstop, which closes a lane nobody accepted after the grace. ADR 149:
 * `--ask-slack-webhook <url>` points the ask stream's loud reach at a Slack incoming webhook (`off`
 * clears it); the URL is a secret, so the display masks it to its host. ADR 248:
 * `--seeds-relay <url> --seeds-token <token>` points the seeds ingest loop at the capture relay
 * (`--seeds-relay off` clears both); the token is a secret and never displayed. ADR 244:
 * `--stakes-default <surface>=<low|normal|high>` upserts a default-stakes rule (same surface
 * replaces in place; a new surface appends); `--stakes-default off` clears the list. ADR 445 §3:
 * `--trace-content on` keeps what each seat's hooks saw (credential-scrubbed) in trace.db's content
 * column; structural rows are recorded either way. ADR 456 §2: `--agent-connect any_member` lets
 * any teammate issue a member-created agent's connect link (team agents); `sponsor` (the default)
 * keeps it to the sponsor or an admin; the daemon accepts `any_member` only with
 * `--invite-requires-expiry on` (ADR 463 §4.3), so both may ride one call. ADR 459 (on ADR 449 §3): `--sponsored-agent-cap <n>`
 * tunes live member-created agents per sponsor (default 3). ADR 602 / ADR 611: `--spend-cap <usd>` sets the team's
 * 7-day measured-wake-cost cap (`off` clears it; unset is unbounded). At the cap, new agent wakes are held
 * and a human still passes. ADR 635: `--spend-approval <usd>` sets the per-wake gateway threshold
 * (`off` clears it). This change shows the number. It holds nothing.
 * ADR 639: `--unpriced-wake-cap <n>` sets the 7-day unpriced-wake count (`off` clears it; unset
 * keeps today's behavior; 0 blocks unpriced harnesses). The report shows the count. A set key
 * holds new agent wakes when the count reaches it. A human still passes (ADR 641).
 * ADR 463 §2: `--hosted-budget <usd>` sets `agent_host.policy.budget_usd`, the per-wake report bound every
 * sponsor-hosted seat enrolls with; without it a host's claim fails `no_budget` at once (`off` clears it).
 * ADR 506: `--acceptance-review-window <min>`
 * sets how long a lane-review ask waits before its owner may self-close on silence (default 20). Reads → merges the named
 * knob(s) → POSTs the policy (the residency-policy read-merge-write pattern), so setting one knob
 * never clobbers the wake-policy defaults.
 */
/**
 * Every flag `musterd team policy` reads, plus the globals any command accepts. The parser (ADR 002:
 * no arg-parsing dependency) keeps whatever it is given, and this command only ever looked up the
 * knobs it knew — so a flag it did not know left `changed` false and fell through to the READ
 * branch: the policy printed, exit 0, nothing written. That is how nick's first `--enforce-route`
 * on a CLI built before #2084 did nothing on 2026-10-05 (lane 01M46ZG8NY). A write must never
 * quietly become a read, and the usual cause — a flag newer than this build — is worth naming.
 */
const POLICY_FLAGS = new Set([
  'reseat-known-agents',
  'ask-fallback-to-nonadmin',
  'review-loop',
  'dispatch-loop',
  'sweep-loop',
  'incident',
  'incident-threshold',
  'incident-claim-window',
  'incident-fallback-role',
  'incident-wake-on-route',
  'incident-wake-on-resolve',
  'trace-content',
  'agent-connect',
  'invite-requires-expiry',
  'sponsored-agent-cap',
  'spend-cap',
  'spend-approval',
  'hosted-budget',
  'unpriced-wake-cap',
  'acceptance-review-window',
  'ask-slack-webhook',
  'seeds-relay',
  'seeds-token',
  'away-relay',
  'away-token',
  'slack-bot-token',
  'guardian-tier',
  'stakes-default',
  'review-by',
  'enforce-clear',
  'enforce-posture',
  'enforce-surface',
  'enforce-action',
  'enforce-route',
  // globals: identity/transport (`gather`), output (`bin.ts`), and `--as` so `rejectAs` can say its line
  'server',
  'team',
  'json',
  'quiet',
  'no-color',
  'no-bell',
  'as',
]);

/** ADR 533: `--review-by 2027-01-15` or `--review-by +90d` → epoch ms. The daemon caps it at 365d. */
function parseReviewBy(raw: string): number {
  if (raw.startsWith('+')) return Date.now() + parseDurationMs(raw.slice(1), '--review-by');
  const t = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(t))
    throw new CliError(
      'usage: musterd team policy --review-by <YYYY-MM-DD | +<duration, e.g. 90d>>',
      2,
    );
  return t;
}

function rejectUnknownPolicyFlags(flags: Record<string, string | boolean>): void {
  const unknown = Object.keys(flags).filter((f) => !POLICY_FLAGS.has(f));
  if (unknown.length === 0) return;
  const build = cliBuild();
  throw new CliError(
    `unknown flag ${unknown.map((f) => `--${f}`).join(', ')} for \`musterd team policy\` — nothing was ` +
      `changed. If the flag is newer than this build${build ? ` (${build.slice(0, 7)})` : ''}, rebuild: ` +
      "`pnpm build` in the CLI workspace, or `musterd service refresh` for the daemon's; " +
      '`musterd team policy --help` lists what this build knows.',
    2,
  );
}

async function teamPolicy(parsed: Parsed): Promise<number> {
  rejectUnknownPolicyFlags(parsed.flags);
  rejectAs(parsed.flags);
  const { team, http } = resolve(parsed.flags);
  const { policy: current, stored } = await http.getPolicy(team);

  // Read-merge-write each named knob (never clobber the wake-policy defaults). Both flags may be set
  // in one call; onOff throws on a value that is neither on nor off.
  //
  // ADR 185: merge into the SPARSE `stored` doc, not the defaults-applied `current`. Merging into
  // `current` is what re-materialized every default into the row on each write, killing the schema
  // default for the team. `delete merged.ask_slack_webhook` now genuinely unsets the key.
  const merged: PolicyOverride = { ...stored };
  let changed = false;
  const reseat = onOff(parsed.flags['reseat-known-agents'], '--reseat-known-agents');
  if (reseat !== undefined) {
    merged.standing_reseat_known_agents = reseat;
    changed = true;
  }
  // ADR 147: the ask stream's configurable (never automatic) fallback — an admin-unanswered ask may fall
  // back to non-admin humans on the same timeout/risk machinery.
  const askFallback = onOff(parsed.flags['ask-fallback-to-nonadmin'], '--ask-fallback-to-nonadmin');
  if (askFallback !== undefined) {
    merged.ask_fallback_to_nonadmin = askFallback;
    changed = true;
  }
  // ADR 191 / 199: work-order loops remain dark until a Team admin explicitly arms each one.
  // Preserve the sibling loop switch (and every unrelated sparse policy setting) while changing only
  // the named one — never clobber review when flipping dispatch, or vice versa.
  const reviewLoop = onOff(parsed.flags['review-loop'], '--review-loop');
  if (reviewLoop !== undefined) {
    merged.loops = { ...merged.loops, review: reviewLoop };
    changed = true;
  }
  const dispatchLoop = onOff(parsed.flags['dispatch-loop'], '--dispatch-loop');
  if (dispatchLoop !== undefined) {
    merged.loops = { ...merged.loops, dispatch: dispatchLoop };
    changed = true;
  }
  const sweepLoop = onOff(parsed.flags['sweep-loop'], '--sweep-loop');
  if (sweepLoop !== undefined) {
    merged.loops = { ...merged.loops, sweep: sweepLoop };
    changed = true;
  }
  // ADR 268 (incident spec §5): shared-blocker convergence. `--incident off` is an OPT-OUT — unlike
  // the loops above, clustering ships on, so this flag exists to turn shipped behaviour off. The two
  // wake knobs are the opt-INs: they spend, and wake accounting cannot yet see what an unreported
  // lease cost, so no team gets a new wake edge without an admin asking for it by name.
  const incidentOn = onOff(parsed.flags['incident'], '--incident');
  if (incidentOn !== undefined) {
    merged.incident = { ...merged.incident, enabled: incidentOn };
    changed = true;
  }
  const incidentThreshold = flagStr(parsed.flags, 'incident-threshold');
  if (incidentThreshold !== undefined) {
    const n = Number(incidentThreshold);
    if (!Number.isInteger(n) || n < 2) {
      throw new CliError(
        'usage: musterd team policy --incident-threshold <n ≥ 2>  (one seat is not a cluster)',
        2,
      );
    }
    merged.incident = { ...merged.incident, cluster_threshold: n };
    changed = true;
  }
  const claimWindow = flagStr(parsed.flags, 'incident-claim-window');
  if (claimWindow !== undefined) {
    merged.incident = {
      ...merged.incident,
      claim_window_ms: parseDurationMs(claimWindow, '--incident-claim-window'),
    };
    changed = true;
  }
  const fallbackRole = flagStr(parsed.flags, 'incident-fallback-role');
  if (fallbackRole !== undefined) {
    if (!fallbackRole.trim()) {
      throw new CliError('usage: musterd team policy --incident-fallback-role <role>', 2);
    }
    merged.incident = { ...merged.incident, fallback_role: fallbackRole.trim() };
    changed = true;
  }
  const wakeOnRoute = onOff(parsed.flags['incident-wake-on-route'], '--incident-wake-on-route');
  if (wakeOnRoute !== undefined) {
    merged.incident = { ...merged.incident, wake_on_route: wakeOnRoute };
    changed = true;
  }
  const wakeOnResolve = onOff(
    parsed.flags['incident-wake-on-resolve'],
    '--incident-wake-on-resolve',
  );
  if (wakeOnResolve !== undefined) {
    merged.incident = { ...merged.incident, wake_on_resolve: wakeOnResolve };
    changed = true;
  }
  // ADR 445 §3: whether the trace store's content column is written. Structural rows are recorded
  // either way; this decides only whether what a hook SAW (scrubbed) is kept too.
  const traceContent = onOff(parsed.flags['trace-content'], '--trace-content');
  if (traceContent !== undefined) {
    merged.trace = { ...merged.trace, content: traceContent ? 'on' : 'off' };
    changed = true;
  }
  // ADR 456 §2: who may issue a member-created agent's connect link. `any_member` makes them team
  // agents — and makes a connect a possible takeover by any teammate, which the admin chooses here.
  const agentConnect = flagStr(parsed.flags, 'agent-connect');
  if (agentConnect !== undefined) {
    if (agentConnect !== 'sponsor' && agentConnect !== 'any_member')
      throw new CliError('usage: musterd team policy --agent-connect <sponsor|any_member>', 2);
    merged.agent_connect = agentConnect;
    changed = true;
  }
  // ADR 463 §4.3: every invite must carry member_until. `any_member` is accepted only with this on,
  // in the same write — so the two flags compose in one call.
  const inviteExpiry = onOff(parsed.flags['invite-requires-expiry'], '--invite-requires-expiry');
  if (inviteExpiry !== undefined) {
    merged.invite_requires_expiry = inviteExpiry;
    changed = true;
  }
  // ADR 459 (on ADR 449 §3): live member-created agents per sponsor. Default 3 (the shipped
  // constant); the daemon's schema caps it at 100, validated here too so a typo fails fast.
  const agentCap = flagStr(parsed.flags, 'sponsored-agent-cap');
  if (agentCap !== undefined) {
    const n = Number(agentCap);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new CliError('usage: musterd team policy --sponsored-agent-cap <1–100>', 2);
    }
    merged.sponsored_agent_cap = n;
    changed = true;
  }
  // ADR 602: the team's 7-day measured-wake-cost cap. `off` deletes the key so absence stays
  // unbounded. No numeric default — 0 would read as "deny every wake" to a reader that treats it
  // as a bound.
  const spendCap = flagStr(parsed.flags, 'spend-cap');
  if (spendCap !== undefined) {
    if (spendCap === 'off') {
      delete merged.spend_cap_usd;
    } else {
      const n = Number(spendCap);
      if (!Number.isFinite(n) || n <= 0 || n > SPEND_CAP_USD_MAX) {
        throw new CliError(
          `usage: musterd team policy --spend-cap <usd | off>  (positive, at most ${SPEND_CAP_USD_MAX})`,
          2,
        );
      }
      merged.spend_cap_usd = n;
    }
    changed = true;
  }
  // ADR 635: per-wake gateway approval threshold. `off` deletes the key. 0 is rejected.
  // Nothing is held on this number yet.
  const spendApproval = flagStr(parsed.flags, 'spend-approval');
  if (spendApproval !== undefined) {
    if (spendApproval === 'off') {
      delete merged.spend_approval_usd;
    } else {
      const n = Number(spendApproval);
      if (!Number.isFinite(n) || n <= 0 || n > SPEND_CAP_USD_MAX) {
        throw new CliError(
          `usage: musterd team policy --spend-approval <usd | off>  (positive, at most ${SPEND_CAP_USD_MAX})`,
          2,
        );
      }
      merged.spend_approval_usd = n;
    }
    changed = true;
  }
  // ADR 463 §2: the hosted-seat budget. A provision claimed without it fails `no_budget` at once, so
  // this is the knob a sponsor is told to set. `off` deletes the key; 0 is rejected like the caps.
  const hostedBudget = flagStr(parsed.flags, 'hosted-budget');
  if (hostedBudget !== undefined) {
    const agentHost = { ...(merged.agent_host ?? {}) };
    const override = { ...(agentHost.policy ?? {}) };
    if (hostedBudget === 'off') {
      delete override.budget_usd;
    } else {
      const n = Number(hostedBudget);
      if (!Number.isFinite(n) || n <= 0 || n > SPEND_CAP_USD_MAX) {
        throw new CliError(
          `usage: musterd team policy --hosted-budget <usd | off>  (positive, at most ${SPEND_CAP_USD_MAX})`,
          2,
        );
      }
      override.budget_usd = n;
    }
    merged.agent_host = { ...agentHost, policy: override };
    changed = true;
  }
  // ADR 639: the 7-day unpriced-wake count. `off` deletes the key. 0 is a real cap.
  const unpricedCap = flagStr(parsed.flags, 'unpriced-wake-cap');
  if (unpricedCap !== undefined) {
    if (unpricedCap === 'off') {
      delete merged.unpriced_wake_cap;
    } else {
      const n = Number(unpricedCap);
      if (!Number.isInteger(n) || n < 0 || n > UNPRICED_WAKE_CAP_MAX) {
        throw new CliError(
          `usage: musterd team policy --unpriced-wake-cap <n | off>  (integer, 0 through ${UNPRICED_WAKE_CAP_MAX})`,
          2,
        );
      }
      merged.unpriced_wake_cap = n;
    }
    changed = true;
  }
  // ADR 506: how long a lane-review ask waits before the owner may self-close on silence. Taken in
  // minutes (how people say it), stored in ms (how every other clock in the protocol is kept).
  const reviewWindow = flagStr(parsed.flags, 'acceptance-review-window');
  if (reviewWindow !== undefined) {
    const n = Number(reviewWindow);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      throw new CliError(
        'usage: musterd team policy --acceptance-review-window <1–1440 minutes>',
        2,
      );
    }
    merged.acceptance_review_window_ms = n * 60_000;
    changed = true;
  }
  // ADR 149: the ask stream's Slack delivery — a webhook URL, or `off` to clear it (delete the key so
  // the daemon's "unset = no outbound call ever" default is restored, not stored as an empty string).
  const webhook = flagStr(parsed.flags, 'ask-slack-webhook');
  if (webhook !== undefined) {
    if (webhook === 'off') {
      delete merged.ask_slack_webhook;
    } else {
      if (!/^https:\/\//.test(webhook)) {
        throw new CliError('usage: musterd team policy --ask-slack-webhook <https url | off>', 2);
      }
      merged.ask_slack_webhook = webhook;
    }
    changed = true;
  }
  // ADR 248: seeds ingest — the relay the daemon pulls raw captured ideas from. Two keys set
  // together (`--seeds-relay <url> --seeds-token <token>`), `--seeds-relay off` clears both (delete,
  // not empty string, restoring the daemon's "unset = no outbound call ever" default). The token is
  // a secret with the webhook's handling: masked on display, never exported.
  const seedsRelay = flagStr(parsed.flags, 'seeds-relay');
  const seedsToken = flagStr(parsed.flags, 'seeds-token');
  if (seedsRelay !== undefined) {
    if (seedsRelay === 'off') {
      delete merged.seeds_relay_url;
      delete merged.seeds_relay_token;
    } else {
      if (!/^https:\/\//.test(seedsRelay) || seedsToken === undefined) {
        throw new CliError(
          'usage: musterd team policy --seeds-relay <https url | off> --seeds-token <token>',
          2,
        );
      }
      merged.seeds_relay_url = seedsRelay;
      merged.seeds_relay_token = seedsToken;
    }
    changed = true;
  }
  // ADR 659: the away relay — the daemon dials out to it for channel deliveries. Two keys set
  // together (`--away-relay <url> --away-token <token>`), `--away-relay off` clears both. The
  // token is a per-team credential (only its sha256 sits at the relay) and never displayed.
  const awayRelay = flagStr(parsed.flags, 'away-relay');
  const awayToken = flagStr(parsed.flags, 'away-token');
  if (awayRelay !== undefined) {
    if (awayRelay === 'off') {
      delete merged.away_relay_url;
      delete merged.away_relay_token;
    } else {
      if (!/^https:\/\/|^wss:\/\//.test(awayRelay) || awayToken === undefined) {
        throw new CliError(
          'usage: musterd team policy --away-relay <https url | off> --away-token <token>',
          2,
        );
      }
      merged.away_relay_url = awayRelay;
      merged.away_relay_token = awayToken;
    }
    changed = true;
  }
  // ADR 668: the Slack bot token — set alone (`--slack-bot-token <token>`), `off` clears it.
  // It is a secret: stored in team policy, never displayed after it is set.
  const slackBotToken = flagStr(parsed.flags, 'slack-bot-token');
  if (slackBotToken !== undefined) {
    if (slackBotToken === 'off') {
      delete merged.slack_bot_token;
    } else {
      merged.slack_bot_token = slackBotToken;
    }
    changed = true;
  }
  // ADR 150: the enforcement class table — the opt-in PreToolUse gate declaration. `--enforce-surface`
  // (contended surfaces, Gate A) and `--enforce-action` (costly actions, Gate B) upsert classes by name
  // (re-declaring a name replaces it); `--enforce-clear` empties the table. Posture defaults to `block`
  // (the flag is an explicit opt-in to enforce; pass `--enforce-posture warn` for the advisory tier).
  const enforceChanged = applyEnforcementFlags(merged, parsed);
  if (enforceChanged) changed = true;
  const stakesDefaultChanged = applyStakesDefaultFlag(merged, parsed);
  if (applyGuardianTierFlag(merged, parsed)) changed = true;
  if (stakesDefaultChanged) changed = true;

  // ADR 533: the doc's review date. `--review-by <YYYY-MM-DD | +<duration>>` names one; any other
  // write DROPS the stored date so the daemon re-stamps the default window from now — an admin who
  // just read the whole readout and changed a knob has reviewed the doc, and carrying the old date
  // through the read-merge-write would let a reviewed doc fall due anyway.
  const reviewBy = flagStr(parsed.flags, 'review-by');
  if (reviewBy !== undefined) {
    merged.review_by = parseReviewBy(reviewBy);
    changed = true;
  } else if (changed) {
    delete merged.review_by;
  }

  if (changed) {
    const { policy: updated } = await http.setPolicy(team, merged);
    process.stdout.write(
      success(
        `team policy updated — ${team}: re-seat known agents ${updated.standing_reseat_known_agents ? theme.accent('on') : 'off'}, ask fallback to non-admins ${updated.ask_fallback_to_nonadmin ? theme.accent('on') : 'off'}, review loop ${updated.loops.review ? theme.accent('on') : 'off'}, dispatch loop ${updated.loops.dispatch ? theme.accent('on') : 'off'}, sweep loop ${updated.loops.sweep ? theme.accent('on') : 'off'}`,
      ) + '\n',
    );
    if (updated.standing_reseat_known_agents)
      process.stdout.write(
        hint('a held agent seat now re-occupies without an admin decision (new seats stay gated)') +
          '\n',
      );
    if (updated.ask_fallback_to_nonadmin)
      process.stdout.write(
        hint(
          'an admin-unanswered ask may now fall back to non-admin humans past its tier timeout',
        ) + '\n',
      );
    if (updated.loops.sweep)
      process.stdout.write(
        hint(
          'a lane nobody accepts is now closed by the daemon after the grace, recorded review_swept and never verified',
        ) + '\n',
      );
    if (traceContent !== undefined)
      process.stdout.write(
        hint(
          updated.trace.content === 'on'
            ? "trace content on — each seat's hooks keep what they saw, credential-scrubbed, in this machine's trace.db (from the next hook on)"
            : 'trace content off — trace.db records structure only; content already stored is kept',
        ) + '\n',
      );
    if (agentConnect !== undefined)
      process.stdout.write(
        hint(
          updated.agent_connect === 'any_member'
            ? 'agent connect: any member — any teammate can start any member-created agent, taking it over from the device that held it; the sponsor is told (ADR 456)'
            : "agent connect: sponsor — only an agent's sponsor or an admin can start it (ADR 456)",
        ) + '\n',
      );
    if (inviteExpiry !== undefined)
      process.stdout.write(
        hint(
          updated.invite_requires_expiry
            ? 'invite requires expiry: on — every invite must set member_until (ADR 463 §4.3)'
            : 'invite requires expiry: off — invites may be open-ended',
        ) + '\n',
      );
    if (agentCap !== undefined)
      process.stdout.write(
        hint(
          `sponsored agent cap: ${updated.sponsored_agent_cap} live agents per sponsor (ADR 459)`,
        ) + '\n',
      );
    if (spendCap !== undefined)
      process.stdout.write(
        hint(
          updated.spend_cap_usd === undefined
            ? 'spend cap off — measured wake cost is unbounded (ADR 602)'
            : `spend cap: $${updated.spend_cap_usd.toFixed(2)} of measured wake cost, 7d — agent wakes are held when the 7-day total reaches the cap; a human still passes`,
        ) + '\n',
      );
    if (spendApproval !== undefined)
      process.stdout.write(
        hint(
          updated.spend_approval_usd === undefined
            ? 'spend approval off — no per-wake gateway threshold (ADR 635)'
            : `spend approval: $${updated.spend_approval_usd.toFixed(2)} per wake at the gateway — shown on the report, display only`,
        ) + '\n',
      );
    if (hostedBudget !== undefined)
      process.stdout.write(
        hint(
          updated.agent_host.policy.budget_usd === undefined
            ? 'hosted budget off — a host claiming a sponsored seat fails no_budget (ADR 463 §2)'
            : `hosted budget: $${updated.agent_host.policy.budget_usd.toFixed(2)} per wake for sponsor-hosted seats`,
        ) + '\n',
      );
    if (unpricedCap !== undefined)
      process.stdout.write(
        hint(
          updated.unpriced_wake_cap === undefined
            ? 'unpriced wake cap off — unpriced wakes stay outside the dollar cap (ADR 639)'
            : `unpriced wake cap: ${updated.unpriced_wake_cap} wakes / 7d — agent wakes are held when the 7-day count reaches the cap; a human still passes`,
        ) + '\n',
      );
    if (reviewWindow !== undefined)
      process.stdout.write(
        hint(
          `acceptance review window: ${Math.round(updated.acceptance_review_window_ms / 60_000)}m ` +
            'before an owner may self-close an unanswered review (ADR 506)',
        ) + '\n',
      );
    if (webhook !== undefined)
      process.stdout.write(
        hint(
          updated.ask_slack_webhook
            ? `asks now also post to Slack (${maskWebhook(updated.ask_slack_webhook)})`
            : 'Slack delivery for asks is off',
        ) + '\n',
      );
    if (seedsRelay !== undefined)
      process.stdout.write(
        hint(
          updated.seeds_relay_url
            ? `seeds ingest on — the daemon polls ${maskWebhook(updated.seeds_relay_url)} and files each captured idea as a Seed (a lane comes only if exploration promotes it)`
            : 'seeds ingest is off',
        ) + '\n',
      );
    if (enforceChanged) {
      const n = updated.enforcement.classes.length;
      const blocking = updated.enforcement.classes.filter((c) => c.posture === 'block').length;
      process.stdout.write(
        hint(
          n === 0
            ? 'enforcement disabled — no classes declared (warn-never-block default restored)'
            : `enforcement: ${n} class(es) declared, ${blocking} at block — each seat's PreToolUse gate reads this`,
        ) + '\n',
      );
    }
    if (stakesDefaultChanged) {
      const rules = updated.stakes_defaults;
      process.stdout.write(
        hint(
          rules.length === 0
            ? "stakes defaults off — every lane opens at the worker's declaration (or normal)"
            : `stakes defaults: ${rules.map((r) => `${r.surface} → ${r.stakes}`).join(', ')} — first match wins; mixed-surface lanes stay normal`,
        ) + '\n',
      );
    }
    return 0;
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ...current, stored }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('team policy')} — ${team}\n`);
  process.stdout.write(
    `  re-seat known agents: ${current.standing_reseat_known_agents ? theme.accent('on') : 'off'}${inherited(stored, 'standing_reseat_known_agents')}\n`,
  );
  process.stdout.write(
    `  ask fallback to non-admins: ${current.ask_fallback_to_nonadmin ? theme.accent('on') : 'off'}${inherited(stored, 'ask_fallback_to_nonadmin')}\n`,
  );
  process.stdout.write(
    `  review loop: ${current.loops.review ? theme.accent('on') : 'off'}${inherited(stored.loops, 'review')}\n`,
  );
  process.stdout.write(
    `  dispatch loop: ${current.loops.dispatch ? theme.accent('on') : 'off'}${inherited(stored.loops, 'dispatch')}\n`,
  );
  process.stdout.write(
    `  sweep loop: ${current.loops.sweep ? theme.accent('on') : 'off'}${inherited(stored.loops, 'sweep')}\n`,
  );
  // ADR 268: the incident block reads as one line when it is at its defaults, and expands only where
  // an admin actually chose something — the knobs below `enabled` are noise on a team running stock.
  process.stdout.write(
    `  incident convergence: ${current.incident.enabled ? theme.accent('on') : 'off'}${inherited(stored.incident, 'enabled')}\n`,
  );
  if (current.incident.enabled) {
    process.stdout.write(
      `    cluster at: ${current.incident.cluster_threshold} distinct reporters${inherited(stored.incident, 'cluster_threshold')}\n`,
    );
    process.stdout.write(
      `    claim window: ${fmtDurationMs(current.incident.claim_window_ms)}, then role ${theme.accent(current.incident.fallback_role)}${inherited(stored.incident, 'claim_window_ms')}\n`,
    );
    process.stdout.write(
      `    wakes: on route ${current.incident.wake_on_route ? theme.accent('on') : 'off'}, on resolve ${current.incident.wake_on_resolve ? theme.accent('on') : 'off'}${inherited(stored.incident, 'wake_on_route')}\n`,
    );
  }
  process.stdout.write(
    `  allow pre-issued grants: ${current.allow_pre_issued_grants ? 'on' : 'off'}${inherited(stored, 'allow_pre_issued_grants')}\n`,
  );
  process.stdout.write(
    `  trace content: ${current.trace.content === 'on' ? theme.accent('on') : 'off'}${inherited(stored.trace, 'content')}\n`,
  );
  process.stdout.write(
    `  agent connect: ${current.agent_connect === 'any_member' ? theme.accent('any member') : 'sponsor'}${inherited(stored, 'agent_connect')}\n`,
  );
  process.stdout.write(
    `  invite requires expiry: ${current.invite_requires_expiry ? theme.accent('on') : 'off'}${inherited(stored, 'invite_requires_expiry')}\n`,
  );
  process.stdout.write(
    `  sponsored agent cap: ${current.sponsored_agent_cap} per sponsor${inherited(stored, 'sponsored_agent_cap')}\n`,
  );
  // ADR 602. Absence is unbounded, not a shipped number, so this line does not use inherited().
  process.stdout.write(
    current.spend_cap_usd === undefined
      ? `  spend cap: ${theme.meta('unset (unbounded)')}\n`
      : `  spend cap: $${current.spend_cap_usd.toFixed(2)} of measured wake cost, 7d\n`,
  );
  // ADR 635. Absence is no threshold, so this line does not use inherited().
  process.stdout.write(
    current.spend_approval_usd === undefined
      ? `  spend approval: ${theme.meta('unset')}\n`
      : `  spend approval: $${current.spend_approval_usd.toFixed(2)} per wake at the gateway\n`,
  );
  // ADR 463 §2. Required for hosted seats; absence is a refused claim, not a default.
  process.stdout.write(
    current.agent_host.policy.budget_usd === undefined
      ? `  hosted budget: ${theme.meta('unset (a host claim fails no_budget)')}\n`
      : `  hosted budget: $${current.agent_host.policy.budget_usd.toFixed(2)} per wake for sponsor-hosted seats\n`,
  );
  // ADR 639. Absence keeps today's behavior, so this line does not use inherited().
  process.stdout.write(
    current.unpriced_wake_cap === undefined
      ? `  unpriced wake cap: ${theme.meta('unset')}\n`
      : `  unpriced wake cap: ${current.unpriced_wake_cap} wakes / 7d\n`,
  );
  process.stdout.write(
    `  acceptance review window: ${Math.round(current.acceptance_review_window_ms / 60_000)}m${inherited(stored, 'acceptance_review_window_ms')}\n`,
  );
  // ADR 149: the webhook URL is a secret — show only that it's set, and where it points (host).
  process.stdout.write(
    `  ask slack webhook: ${current.ask_slack_webhook ? theme.accent(maskWebhook(current.ask_slack_webhook)) : 'off'}${inherited(stored, 'ask_slack_webhook')}\n`,
  );
  // ADR 248: the relay URL shows its host; the token shows only that it is set.
  process.stdout.write(
    `  seeds relay: ${current.seeds_relay_url ? theme.accent(maskWebhook(current.seeds_relay_url)) : 'off'}${inherited(stored, 'seeds_relay_url')}\n`,
  );
  // ADR 659: the away relay URL shows its host; the credential shows only that it is set.
  process.stdout.write(
    `  away relay: ${current.away_relay_url ? theme.accent(maskWebhook(current.away_relay_url)) : 'off'}${inherited(stored, 'away_relay_url')}\n`,
  );
  // ADR 668: the Slack bot token shows only that it is set, never its value.
  process.stdout.write(
    `  slack bot token: ${current.slack_bot_token ? theme.accent('set') : 'off'}${inherited(stored, 'slack_bot_token')}\n`,
  );
  // ADR 244: admin-set default stakes by surface. Empty is the shipped default (inert).
  const stakeRules = current.stakes_defaults;
  if (stakeRules.length === 0) {
    process.stdout.write(
      `  stakes defaults: ${theme.meta('off (no rules)')}${inherited(stored, 'stakes_defaults')}\n`,
    );
  } else {
    process.stdout.write(
      `  stakes defaults: ${theme.accent(`${stakeRules.length} rule(s)`)}${inherited(stored, 'stakes_defaults')}\n`,
    );
    for (const r of stakeRules) {
      process.stdout.write(`    · ${r.surface} → ${r.stakes}\n`);
    }
  }
  // ADR 150: the enforcement class table — the opt-in PreToolUse gate declaration.
  const classes = current.enforcement.classes;
  if (classes.length === 0) {
    process.stdout.write(`  enforcement: ${theme.meta('off (no classes declared)')}\n`);
  } else {
    process.stdout.write(`  enforcement: ${theme.accent(`${classes.length} class(es)`)}\n`);
    for (const c of classes) {
      const kind =
        c.kind === 'contended-surface' ? 'surface' : c.kind === 'role-route' ? 'route' : 'action';
      const posture = c.posture === 'block' ? theme.accent('block') : 'warn';
      const holders = c.role !== undefined ? ` ${c.role} only` : '';
      process.stdout.write(
        `    · ${kind} ${c.class} [${c.match.join(', ')}]${holders} → ${posture}\n`,
      );
    }
  }
  if (Object.keys(stored).length === 0)
    process.stdout.write(
      theme.meta('  every value is inherited — this team tracks the shipped defaults') + '\n',
    );
  // ADR 533: when the admins are next asked to look at this doc; overdue once the sweep has asked.
  if (stored.review_by !== undefined) {
    const left = stored.review_by - Date.now();
    process.stdout.write(
      `  review by: ${new Date(stored.review_by).toISOString().slice(0, 10)}${
        left > 0
          ? theme.meta(`  ·  in ${Math.ceil(left / 86_400_000)}d`)
          : theme.accent('  ·  overdue — answer the policy ask, or set --review-by')
      }\n`,
    );
  }
  process.stdout.write(theme.meta('  set: musterd team policy --reseat-known-agents on') + '\n');
  process.stdout.write(theme.meta('       musterd team policy --review-loop on') + '\n');
  process.stdout.write(theme.meta('       musterd team policy --dispatch-loop on') + '\n');
  process.stdout.write(
    theme.meta(
      "       musterd team policy --enforce-surface 'src/tariff.ts' --enforce-posture block",
    ) + '\n',
  );
  process.stdout.write(
    theme.meta("       musterd team policy --stakes-default 'packages/web/**=low'") + '\n',
  );
  return 0;
}

const STAKES_DEFAULT_USAGE =
  "usage: musterd team policy --stakes-default '<surface>=<low|normal|high> | off'";

/**
 * ADR 244 — upsert or clear `stakes_defaults` on the sparse stored policy. `--stakes-default off`
 * deletes the key (the empty list is the schema default). A `surface=stakes` value upserts by
 * surface: same path replaces in place (order preserved, first-match still wins); a new path
 * appends. Never replaces the whole list, so setting web-low cannot wipe a more specific rule.
 */
const GUARDIAN_TIER_USAGE =
  "usage: musterd team policy --guardian-tier '<class>=<observe|alert|auto> | off'";

/**
 * Guardian spec §4 — the autonomy dial. Upserts one class in the sparse `guardian_tiers` map
 * (absent classes read as the guardian's shipped defaults); `off` deletes the key so the schema
 * default (empty map) is restored, never stored as `{}` noise.
 */
function applyGuardianTierFlag(merged: PolicyOverride, parsed: Parsed): boolean {
  const raw = flagStr(parsed.flags, 'guardian-tier');
  if (raw === undefined) return false;
  if (raw === 'off') {
    delete merged.guardian_tiers;
    return true;
  }
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) throw new CliError(GUARDIAN_TIER_USAGE, 2);
  const cls = GuardianClassSchema.safeParse(raw.slice(0, eq).trim());
  const tier = GuardianTierSchema.safeParse(raw.slice(eq + 1).trim());
  if (!cls.success || !tier.success) throw new CliError(GUARDIAN_TIER_USAGE, 2);
  merged.guardian_tiers = { ...merged.guardian_tiers, [cls.data]: tier.data };
  process.stdout.write(`${theme.ok('✓')} guardian tier: ${cls.data} → ${tier.data}\n`);
  return true;
}

function applyStakesDefaultFlag(merged: PolicyOverride, parsed: Parsed): boolean {
  const raw = flagStr(parsed.flags, 'stakes-default');
  if (raw === undefined) return false;
  if (raw === 'off') {
    delete merged.stakes_defaults;
    return true;
  }
  const eq = raw.lastIndexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new CliError(STAKES_DEFAULT_USAGE, 2);
  }
  const surface = raw.slice(0, eq).trim();
  const stakesParsed = LaneStakesSchema.safeParse(raw.slice(eq + 1).trim());
  if (surface.length === 0 || !stakesParsed.success) {
    throw new CliError(STAKES_DEFAULT_USAGE, 2);
  }
  const rule: StakesDefault = { surface, stakes: stakesParsed.data };
  const rules = [...(merged.stakes_defaults ?? [])];
  const i = rules.findIndex((r) => r.surface === surface);
  if (i >= 0) rules[i] = rule;
  else rules.push(rule);
  merged.stakes_defaults = rules;
  return true;
}

/**
 * Apply the ADR 150 enforcement flags to `merged.enforcement` in place (read-merge-write). Returns true
 * if anything changed. `--enforce-clear` empties the table; `--enforce-surface <glob[,glob…]>` declares
 * contended-surface classes (Gate A); `--enforce-action <class=glob[;class=glob…]>` declares costly-action
 * classes (Gate B). Classes upsert by name (re-declaring a name replaces it), so a table is built across
 * calls. `--enforce-posture warn|block` (default block) applies to every class set in THIS invocation.
 */
function applyEnforcementFlags(
  merged: { enforcement?: { classes?: EnforcementClass[] | undefined } | undefined },
  parsed: Parsed,
): boolean {
  let changed = false;
  if (parsed.flags['enforce-clear'] === true) {
    // ADR 185: drop the key rather than storing `{classes: []}`. The empty table IS the default, so
    // an inherited enforcement and a stored-empty one behave identically — but only the first keeps
    // the row honest about what was chosen.
    delete merged.enforcement;
    changed = true;
  }
  const postureRaw = flagStr(parsed.flags, 'enforce-posture') ?? 'block';
  if (postureRaw !== 'warn' && postureRaw !== 'block') {
    throw new CliError('usage: --enforce-posture <warn | block> (default block)', 2);
  }
  const posture = postureRaw as EnforcementPosture;

  const upsert = (cls: EnforcementClass): void => {
    const classes = (merged.enforcement?.classes ?? []).filter((c) => c.class !== cls.class);
    classes.push(cls);
    merged.enforcement = { classes };
    changed = true;
  };

  const surfaces = flagStr(parsed.flags, 'enforce-surface');
  if (surfaces !== undefined) {
    for (const glob of surfaces
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      upsert({ class: glob, kind: 'contended-surface', match: [glob], posture });
    }
  }

  const actions = flagStr(parsed.flags, 'enforce-action');
  if (actions !== undefined) {
    for (const entry of actions
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = entry.indexOf('=');
      if (eq <= 0) {
        throw new CliError(
          `usage: --enforce-action '<class>=<command-glob>' (got "${entry}") — e.g. 'force-push=git push --force*'`,
          2,
        );
      }
      const name = entry.slice(0, eq).trim();
      const glob = entry.slice(eq + 1).trim();
      if (!name || !glob) {
        throw new CliError(
          `--enforce-action needs both a class name and a glob (got "${entry}")`,
          2,
        );
      }
      upsert({ class: name, kind: 'costly-action', match: [glob], posture });
    }
  }

  // ADR 513: `--enforce-route '<role>:<class>=<command-glob>[;…]'` — a route only the role's holders
  // may run. The daemon reads the role back from this stored class, never from a gate request.
  const routes = flagStr(parsed.flags, 'enforce-route');
  if (routes !== undefined) {
    for (const entry of routes
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const colon = entry.indexOf(':');
      const eq = entry.indexOf('=');
      const role = colon > 0 ? entry.slice(0, colon).trim() : '';
      const name = colon > 0 && eq > colon ? entry.slice(colon + 1, eq).trim() : '';
      const glob = eq > 0 ? entry.slice(eq + 1).trim() : '';
      if (!role || !name || !glob) {
        throw new CliError(
          `usage: --enforce-route '<role>:<class>=<command-glob>' — role:class=glob (got "${entry}"), ` +
            `e.g. 'courier:taildrop=tailscale file cp *'`,
          2,
        );
      }
      upsert({ class: name, kind: 'role-route', role, match: [glob], posture });
    }
  }
  return changed;
}

/** Mask a webhook URL to its host — enough to recognize the destination, never the secret path. */
function maskWebhook(url: string): string {
  try {
    return `set → ${new URL(url).host}`;
  } catch {
    return 'set';
  }
}

/** Parse an on/off flag value to a boolean, or undefined if the flag was absent; throws on a bad value. */
function onOff(raw: unknown, flag: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'on' || raw === 'true' || raw === 'yes') return true;
  if (raw === 'off' || raw === 'false' || raw === 'no') return false;
  throw new CliError(`usage: musterd team policy ${flag} <on|off>`, 2);
}

async function teamCreate(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug)
    throw new CliError(
      'usage: musterd team create <slug> [--member <you>] [--role <role>] [--switch]',
      2,
    );
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  // `--member` names the founding member (was `--as`, removed by ADR 442 — it is a name to CREATE,
  // not an identity to resolve, so it keeps a flag of its own).
  rejectAs(parsed.flags);
  const name = flagStr(parsed.flags, 'member') ?? defaultUser();
  const role = flagStr(parsed.flags, 'role');
  const display = flagStr(parsed.flags, 'display');
  const http = new HttpClient({ server });
  const res = await http.createTeam(slug, { name, ...(role ? { role } : {}) }, display);

  // v0.3 (ADR 075): the creator is the team's first admin and authenticates with their **human
  // credential** (mscr_) from the composite mint (SPEC A.7); the team **agent key** (mskey_) is what
  // agents claim with, handed out separately. `res.agent_key`/`res.human_credential` are shown once.
  const credential = res.human_credential as string;
  // WHETHER TO CLAIM THE MACHINE-WIDE DEFAULT. Writing `server`/`current` unconditionally made a
  // LOCAL action a FLEET-WIDE one: creating an isolated team on another port (which ADR 252's live
  // wake check required) silently repointed every unbound folder — and every reader that consults
  // the global config directly, `service status` and `stream doctor` among them — at a daemon that
  // vanished when the probe ended. Measured 2026-08-12: four checks failing correctly about the
  // wrong port, ~1h lost to healthy infrastructure, and first cause of a second incident.
  //
  // The creating folder never needed it. `saveBinding` below writes this folder's own server + team,
  // and a binding outranks the global default everywhere identity resolves — so on a machine that
  // already has a default, the global write was pure side effect.
  //
  // Not a contradiction of `musterd human`, which asserts `current` unconditionally and says so
  // (see human.ts): that command is a PERSON declaring which team they act on, and the declaration
  // is the point. Creating a team is not that declaration — the probe case is exactly where the two
  // come apart — so here it is opt-in via `--switch`, and never silent either way.
  const takeDefault = parsed.flags['switch'] === true || !config.current;
  const previousTeam = config.current;
  if (takeDefault) {
    config.server = server;
    config.current = slug;
  }
  config.agentKeys[slug] = res.agent_key as string; // ADR 075: keep the team key for `musterd agent`
  config.identities[slug] = { name, key: credential, surface: 'cli' };
  rememberIdentity(config, { team: slug, name, key: credential, surface: 'cli' }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the creating folder so it's immediately *active* — you can act here without `--as`,
  // while every other unbound folder stays read-only (ADR 036). The binding carries the folder's
  // claim secret (here the creator's credential) so resolveIdentity yields the admin here.
  const binding: Binding = {
    version: 2,
    server,
    team: slug,
    agent_key: credential,
    claim: { mode: 'seat', name },
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: res.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(success(`team "${slug}" created`, { next: 'musterd status' }) + '\n');
  process.stdout.write(
    `  on the team as ${theme.memberName(name, 'human')} ${theme.meta(`(human${role ? `, ${role}` : ''})`)}\n`,
  );
  process.stdout.write(theme.meta('bound this folder as your seat — act here with no --as') + '\n');
  // Say what happened to the machine-wide default, in BOTH branches. The 2026-08-12 incident was
  // expensive because the switch left no trace at the call site and none afterwards — the only
  // evidence was the symptom, three tools away, presenting as something else entirely.
  process.stdout.write(
    takeDefault
      ? theme.meta(`machine default now points at ${slug} ${theme.accent(server)}`) + '\n'
      : theme.meta(
          `machine default left on ${theme.accent(previousTeam as string)} — this folder is bound to ${slug}; ` +
            `pass ${theme.accent('--switch')} to change it for every unbound folder`,
        ) + '\n',
  );
  process.stdout.write(hint('add members: musterd team add <name> --kind agent') + '\n');
  return 0;
}

async function teamAdd(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const kind = flagStr(parsed.flags, 'kind') as MemberKind | undefined;
  if (!name || (kind !== 'agent' && kind !== 'human')) {
    throw new CliError('usage: musterd team add <name> --kind <agent|human> [--role <role>]', 2);
  }
  // Adding a member is an admin act, so it needs an *active* identity (binding/env/--as), not just
  // an ambient global-config default (ADR 036). `resolve()` enforces that.
  const { team, http } = resolve(parsed.flags);

  const role = flagStr(parsed.flags, 'role');
  const lifecycle = flagStr(parsed.flags, 'lifecycle') as Lifecycle | undefined;
  const until = flagStr(parsed.flags, 'until');
  // ADR 374: the seat's colour, if chosen. Absent, the seat file assigns one at write (file-backed)
  // or the daemon does (db-only). Validated before anything is written.
  const hue = flagHue(parsed.flags);
  // ADR 058 §5: for a file-backed team the file is the single writer — write `seats/<name>.toml`
  // first, then `addMember` becomes project-and-return (the daemon reconciles the file, mints, hands
  // back the token). A db-only team has no roster home, so this is skipped and the daemon originates.
  const home = loadConfig().rosterHome[team];
  if (home) {
    // An explicit colour is checked against the sibling seat files BEFORE the file is written
    // (lane 01M2P43WQ7): the daemon stores the file's word without arguing, so this is the one
    // place a chosen collision can be turned back — and it is turned back with a clear hue named,
    // not a bare refusal. Past a full wheel there is nothing clear to name, and the seat is
    // written anyway; the daemon says whom it shares with.
    if (hue !== undefined) {
      const taken = readSeatHues(home, name);
      const near = hueConflict(hue, Object.values(taken));
      const alternative = nearestClearHue(hue, Object.values(taken));
      if (near !== null && alternative !== null) {
        const who = Object.entries(taken).find(([, h]) => h === near)?.[0] ?? '?';
        throw new CliError(
          `hue ${hue} is within ${HUE_MIN_SEPARATION}° of "${who}" (${near}) — ${alternative} is clear`,
          4,
        );
      }
    }
    writeSeatFile(home, name, { kind, role, lifecycle, until, hue });
  }
  // ADR 547: a seat replicates over sync but its roster entry travels by git. Say so now, while the
  // person who can push the file is the one reading this.
  const unpublished = home ? seatFileUnpublished(home, name) : null;
  const res = await http.addMember(team, {
    name,
    kind,
    role,
    ...(lifecycle ? { lifecycle } : {}),
    ...(until ? { lifecycle_until: Date.parse(until) } : {}),
    ...(hue !== undefined ? { hue } : {}),
  });
  const bootstrap =
    kind === 'agent'
      ? await http.mintBootstrapCredential(team, {
          use: 'claim_seat',
          target: name,
          label: `team-add:${name}`,
        })
      : undefined;
  // ADR 592: the file is published here, after the daemon accepted the member, so a refused add never
  // pushes a stray seat. `--no-publish` leaves it to the person (the ADR 547 lines then say how).
  const published: SeatPublishOutcome | null =
    home && unpublished && parsed.flags['no-publish'] !== true ? publishSeatFile(home, name) : null;
  const stillUnpublished = home ? seatFileUnpublished(home, name) : null;

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: res.member,
        ...(home && stillUnpublished
          ? { seat_file_unpublished: { path: seatFilePath(home, name), state: stillUnpublished } }
          : {}),
        ...(published ? { seat_file_published: published } : {}),
        ...(res.human_credential ? { human_credential: res.human_credential } : {}),
        ...(bootstrap
          ? {
              agent_key: bootstrap.agent_key,
              bootstrap_credential: bootstrap.credential,
            }
          : {}),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(
      `added ${theme.memberName(name, kind)} ${theme.meta(`(${kind}${role ? `, ${role}` : ''})`)} to ${team}`,
    ) + '\n',
  );
  if (home && published) {
    const lines = seatPublishLines(name, home, published, stillUnpublished);
    if (lines?.ok) process.stdout.write(`  ${theme.ok(lines.ok)}\n`);
    if (lines?.warn)
      process.stdout.write(`  ${theme.warn(lines.warn[0])}\n${theme.meta(`  ${lines.warn[1]}`)}\n`);
  } else if (home && stillUnpublished) {
    const [warning, how] = unpublishedSeatLines(name, home, stillUnpublished);
    process.stdout.write(`  ${theme.warn(warning)}\n${theme.meta(`  ${how}`)}\n`);
  }
  // ADR 374 Decision 4: past a full wheel the colour is shared, and it is said out loud.
  if (res.hue_shared_with)
    process.stdout.write(
      `  ${theme.warn(`colour shared with ${res.hue_shared_with} — the wheel is full`)}\n`,
    );
  if (kind === 'agent') {
    // ADR 344: the handoff carries a one-seat bootstrap credential, never the Team-wide legacy key.
    process.stdout.write(theme.meta('connect this agent via MCP with its scoped key:') + '\n');
    process.stdout.write(
      theme.meta(
        `  MUSTERD_TEAM=${team} MUSTERD_AGENT_KEY=${bootstrap!.agent_key} MUSTERD_CLAIM=seat:${name} MUSTERD_LAUNCH_SURFACE=claude-code`,
      ) + '\n',
    );
    process.stdout.write(
      theme.meta('— or skip the wiring: ') +
        theme.accent(`musterd agent ${name} --team ${team}`) +
        theme.meta(` builds an isolated worktree + MCP for it (safe to run now).`) +
        '\n',
    );
  } else {
    // Humans authenticate with their own credential (mscr_), shown once here.
    process.stdout.write(
      theme.meta(`they authenticate with their credential (shown once — store it now):`) + '\n',
    );
    process.stdout.write(
      theme.meta(`  musterd claim ${name} --team ${team} --key ${res.human_credential}`) + '\n',
    );
  }
  return 0;
}

/**
 * Provision a read-only observer seat (ADR 063): a seat that watches the whole-team firehose from the
 * dashboard but is hidden from the roster/counts/presence and cannot send. Resolved like `team export`
 * (server + slug from flags/config, no active identity needed) since the dashboard provisions it
 * out-of-band; observers are db-only even on a file-backed team, so no seat file is written.
 */
async function teamObserve(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team observe <name> [--team <slug>]', 2);
  const team = flagStr(parsed.flags, 'team') ?? loadConfig().current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  // Observers can read team traffic, so provisioning one requires a human admin even on loopback.
  const { http } = resolve({ ...parsed.flags, team });
  const res = await http.addMember(team, { name, kind: 'human', observer: true });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ member: res.member, token: res.token }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(
      `observer "${name}" ready for ${team} ${theme.meta('— read-only, hidden from the roster')}`,
    ) + '\n',
  );
  process.stdout.write(
    hint(`open /live and connect:  team ${team}   as ${name}   token ${res.token}`) + '\n',
  );
  return 0;
}

/**
 * `musterd team credential <name>` — re-issue a human's `mscr_` credential, shown once.
 *
 * The recovery verb for the state that has no other exit: `credential_hash` is one column and
 * minting overwrites it, so a human who lost their credential could not authenticate, could not
 * `musterd board`, and could not even be re-added (`POST /members` conflicts on a live member).
 *
 * Reissuing a human credential requires an authenticated human admin, including on loopback (ADR
 * 580). The caller acts from its Workspace identity; the daemon remains the authority on privilege.
 *
 * When the local machine already knows this (team, name), the rotate repairs what it knows in the
 * same breath — the vault entry, the team's active identity, and the cwd binding's key — so ADR
 * 170's `musterd board` works immediately afterwards with nothing pasted anywhere. Rotating
 * *someone else's* credential touches none of that: it is a secret for another person, not a
 * sign-in for this machine.
 */
/**
 * `musterd team hue <name> [<deg>] | --assign-missing` — a member's colour (ADR 374).
 *
 * Two homes for the same fact, the split `team add` already makes: on a file-backed team the seat
 * file owns the hue and this command edits the file (the daemon reconciles it; two machines that
 * share the repo agree); on a db-only team the daemon owns it and this command asks the daemon.
 *
 * `--assign-missing` is the one-time pass for a roster that predates hues: every seat without one
 * is seeded from the hue the web painted it with before (`legacyHue` — the name hash, banded by
 * kind) and walked clear only if it collides, so the colours people already know survive and only
 * the near-duplicates move. Seats that already have a hue are not touched. On a file-backed team
 * the result is a diff to read before it is pushed.
 *
 * `--spread` seeds the same pass from `defaultHue` — the name hashed over the WHOLE wheel — instead.
 * The two seeds answer different questions and the default is right for the one it was written for:
 * continuity. But continuity is only worth having if the colours being continued are any good, and
 * `legacyHue`'s bands are 150°–280° for agents and 320°–70° for humans, so a team that is mostly
 * agents comes out mostly green-blue-purple no matter how far apart this walks them. That is a range
 * problem, not a collision problem, and no amount of separation fixes it — the seats are already
 * separated, inside a third of the wheel (nick, 2026-09-03, looking at the rail on /live: "there are
 * a lot of purples and blues; the roster needs to start out with more range of colors").
 *
 * It is deliberately a flag and not the new default. Seeding over the whole wheel recolours every
 * seat it touches at once, which on a team people watch is a visible event and someone's call to
 * make — not a side effect of running the repair.
 */
async function teamHue(parsed: Parsed): Promise<number> {
  // The file-backed path never talks to the daemon, so it must not demand an identity — a person
  // editing the roster checkout may hold none here. Resolve the team auth-free first; the db-only
  // branch resolves an authenticated client only when it is about to use one.
  const { team } = resolveRead(parsed.flags);
  const home = loadConfig().rosterHome[team];
  const http = () => resolve(parsed.flags).http;
  const assignMissing = Boolean(parsed.flags['assign-missing']);
  // The seed the pass starts each seat from: the banded legacy hash (continuity, the default) or
  // the whole wheel (range). `assignHue` walks either one clear of the seats already placed.
  const spread = Boolean(parsed.flags.spread);
  const seedHue = (n: string, k: HueKind): number => (spread ? defaultHue(n) : legacyHue(n, k));
  const name = parsed.positionals[1];
  const degRaw = parsed.positionals[2];

  if (assignMissing) {
    const assigned: Array<{
      name: string;
      kind: MemberKind;
      hue: number;
      sharedWith: string | null;
    }> = [];
    if (home) {
      const seats = readSeatFiles(home);
      const taken = readSeatHues(home);
      for (const [seatName, seat] of Object.entries(seats)) {
        if (seat.hue !== undefined) continue;
        const kind = seat.kind === 'human' ? 'human' : 'agent';
        const hue = assignHue(seedHue(seatName, kind), Object.values(taken));
        setSeatHue(home, seatName, hue);
        assigned.push({
          name: seatName,
          kind: seat.kind,
          hue,
          sharedWith: sharedWithName(hue, taken),
        });
        taken[seatName] = hue;
      }
    } else {
      const { members } = await http().roster(team);
      const taken: Record<string, number> = {};
      for (const m of members) if (typeof m.hue === 'number') taken[m.name] = m.hue;
      for (const m of members) {
        if (typeof m.hue === 'number') continue;
        const kind = m.kind === 'human' ? 'human' : 'agent';
        const hue = assignHue(seedHue(m.name, kind), Object.values(taken));
        await http().setHue(team, m.name, hue);
        assigned.push({ name: m.name, kind: m.kind, hue, sharedWith: sharedWithName(hue, taken) });
        taken[m.name] = hue;
      }
    }
    if (assigned.length === 0) {
      process.stdout.write(theme.meta(`every seat in ${team} already has a hue`) + '\n');
      return 0;
    }
    for (const a of assigned) {
      process.stdout.write(
        success(`${theme.memberName(a.name, a.kind)} ${theme.meta('→')} hue ${a.hue}`) +
          (a.sharedWith
            ? `  ${theme.warn(`colour shared with ${a.sharedWith} — the wheel is full`)}`
            : '') +
          '\n',
      );
    }
    if (home)
      process.stdout.write(
        hint(`written to ${seatFilePath(home, '<name>')} — review the diff, then commit and push`) +
          '\n',
      );
    return 0;
  }

  if (!name) {
    throw new CliError(
      'usage: musterd team hue <name> [<0-359>] | musterd team hue --assign-missing [--spread]',
      2,
    );
  }

  // Set.
  if (degRaw !== undefined) {
    const hue = Number(degRaw);
    if (!Number.isInteger(hue) || hue < 0 || hue > 359)
      throw new CliError(
        `hue must be an integer from 0 to 359 (an HSL degree), got "${degRaw}"`,
        2,
      );
    if (home) {
      if (!existsSync(seatFilePath(home, name)))
        throw new CliError(`no seat "${name}" — no ${seatFilePath(home, name)}`, 4);
      const seatKind = readSeatFiles(home)[name]?.kind ?? 'agent';
      const taken = readSeatHues(home, name);
      const near = hueConflict(hue, Object.values(taken));
      const alternative = nearestClearHue(hue, Object.values(taken));
      const who =
        near === null ? null : (Object.entries(taken).find(([, h]) => h === near)?.[0] ?? '?');
      if (near !== null && alternative !== null) {
        throw new CliError(
          `hue ${hue} is within ${HUE_MIN_SEPARATION}° of "${who}" (${near}) — ${alternative} is clear`,
          4,
        );
      }
      const p = setSeatHue(home, name, hue);
      if (who !== null)
        process.stdout.write(`  ${theme.warn(`colour shared with ${who} — the wheel is full`)}\n`);
      process.stdout.write(
        success(`${theme.memberName(name, seatKind)} ${theme.meta('→')} hue ${hue}`) +
          `  ${theme.meta(`(${p} — the file owns it; commit and push)`)}\n`,
      );
      return 0;
    }
    const { member, hue_shared_with } = await http().setHue(team, name, hue);
    process.stdout.write(
      success(
        `${theme.memberName(name, member.kind)} ${theme.meta('→')} hue ${member.hue ?? hue}`,
      ) + '\n',
    );
    if (hue_shared_with)
      process.stdout.write(
        `  ${theme.warn(`colour shared with ${hue_shared_with} — the wheel is full`)}\n`,
      );
    return 0;
  }

  // Show.
  if (home) {
    const seat = readSeatFiles(home)[name];
    if (!seat) throw new CliError(`no seat "${name}" — no ${seatFilePath(home, name)}`, 4);
    process.stdout.write(
      seat.hue === undefined
        ? `${theme.memberName(name, seat.kind)}: ${theme.meta('no hue — painted from the name hash; `musterd team hue ' + name + ' <0-359>` or `--assign-missing` sets one')}\n`
        : `${theme.memberName(name, seat.kind)}: hue ${seat.hue}  ${theme.meta(`(seats/${name}.toml owns it)`)}\n`,
    );
    return 0;
  }
  const { members } = await http().roster(team);
  const m = members.find((x) => x.name === name);
  if (!m) throw new CliError(`no member "${name}" in "${team}"`, 4);
  process.stdout.write(
    typeof m.hue === 'number'
      ? `${theme.memberName(name, m.kind)}: hue ${m.hue}\n`
      : `${theme.memberName(name, m.kind)}: ${theme.meta('no hue — painted from the name hash; `musterd team hue ' + name + ' <0-359>` sets one')}\n`,
  );
  return 0;
}

/** Who a freshly assigned hue still sits too close to, when the wheel could not seat it clear. */
function sharedWithName(hue: number, taken: Record<string, number>): string | null {
  const near = hueConflict(hue, Object.values(taken));
  if (near === null) return null;
  return Object.entries(taken).find(([, h]) => h === near)?.[0] ?? null;
}

async function teamCredential(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name)
    throw new CliError('usage: musterd team credential <name> [--team <slug>] [--server <url>]', 2);
  const config = loadConfig();
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const { http } = resolve({ ...parsed.flags, team });
  const res = await http.rotateCredential(team, name);

  const repaired = repairLocalCredential(config, team, res.member, res.credential);

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ member: res.member, credential: res.credential, repaired }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(`re-issued ${theme.memberName(res.member, 'human')}'s credential for ${team}`) + '\n',
  );
  process.stdout.write(
    theme.meta('the previous one stops working at their next claim — shown once, store it now:') +
      '\n',
  );
  process.stdout.write(`  ${res.credential}\n`);
  if (repaired.identity || repaired.binding) {
    // Say exactly what was rewritten: this command hands out a secret, so silent local writes would
    // be the wrong kind of convenience.
    const where = [
      ...(repaired.identity ? ['this machine’s saved identity'] : []),
      ...(repaired.binding ? ['this folder’s binding'] : []),
    ].join(' + ');
    process.stdout.write(theme.meta(`updated ${where} — nothing to paste`) + '\n');
    process.stdout.write(hint('open the board signed in: musterd board') + '\n');
  } else {
    process.stdout.write(
      hint(`hand it over: musterd claim ${res.member} --team ${team} --key <the line above>`) +
        '\n',
    );
  }
  return 0;
}

/**
 * Read the team agent key off the seat bindings this machine already holds.
 *
 * The key is a per-team secret recorded in `config.agentKeys` at `team create` (ADR 075) — and that
 * map is the *only* copy the config keeps, so anything that empties it (an interrupted prune,
 * `musterd reset`, a restored backup) takes `musterd agent` and `musterd human` down with it. But the
 * key itself is rarely gone: every agent workspace `musterd agent` ever provisioned wrote it into its
 * own gitignored `binding.json`. Measured on team `revive`, 2026-08-14: `agentKeys` empty, eleven
 * seat bindings all carrying the same `mskey_`. The secret was on the machine the whole time.
 *
 * That is why recovery, not rotation, is this command's default. Rotating in that state mints a key
 * none of those eleven bindings hold, so the repair for a bookkeeping gap would be a team-wide
 * outage.
 *
 * Two abstentions are deliberate. Only `mskey_`-prefixed keys count — a human seat's binding carries
 * that person's `mscr_` credential, and recording one as the team key would rebuild the dead binding
 * `findHeldCredential` and `doctor.ts` both exist to catch. And disagreement returns no key at all:
 * two keys in flight means a rotation landed partway, so this hands back every candidate and lets the
 * operator choose with `--key` rather than guessing and re-breaking the other half.
 *
 * Pure and injectable (`read`) so the decision is testable without a filesystem.
 */
export function recoverAgentKey(
  dirs: readonly string[],
  team: string,
  read: (dir: string) => Binding | null,
): {
  /** The single agreed key, or null when there is nothing to recover or the candidates disagree. */
  key: string | null;
  /** The folders that vouched for `key` — named in the output, because this writes a secret. */
  sources: string[];
  /** Every candidate with its folders, populated only when they disagree. */
  conflicts: Array<{ key: string; dirs: string[] }>;
} {
  const byKey = new Map<string, string[]>();
  for (const dir of dirs) {
    const binding = read(dir);
    if (binding?.team !== team) continue;
    const key = binding.agent_key;
    if (!key || !key.startsWith(TOKEN_PREFIXES.agent_key)) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), dir]);
  }
  if (byKey.size === 0) return { key: null, sources: [], conflicts: [] };
  if (byKey.size > 1) {
    return {
      key: null,
      sources: [],
      conflicts: [...byKey].map(([key, dirs]) => ({ key, dirs })),
    };
  }
  const [key, sources] = [...byKey][0]!;
  return { key, sources, conflicts: [] };
}

/**
 * `musterd team agent-key [--key <mskey_…>] [--rotate [--yes]] [--show]` — hold, recover, or replace
 * the team agent key on this machine. See {@link recoverAgentKey} for why the default reads rather
 * than rotates.
 */
async function teamAgentKey(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const json = parsed.flags['json'] === true;
  const held = config.agentKeys[team];

  const record = (key: string, how: string, sources: string[]): number => {
    config.agentKeys[team] = key;
    saveConfig(config);
    if (json) {
      process.stdout.write(JSON.stringify({ team, agent_key: key, source: how, sources }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`team agent key recorded for ${team} ${theme.meta(`(${how})`)}`) + '\n',
    );
    if (sources.length) {
      process.stdout.write(
        theme.meta(
          `  read from ${sources.length} seat binding${sources.length === 1 ? '' : 's'}: `,
        ) +
          theme.meta(sources.join(', ')) +
          '\n',
      );
    }
    process.stdout.write(hint('musterd agent <name> now works here') + '\n');
    return 0;
  };

  // `--show` — print what this machine holds. No round-trip; the key is already echoed by
  // `team add`, so this exposes nothing new, but it stays behind an explicit flag.
  if (parsed.flags['show'] === true) {
    if (json) {
      process.stdout.write(JSON.stringify({ team, agent_key: held ?? null }) + '\n');
      return 0;
    }
    if (!held) {
      process.stdout.write(
        `${theme.warn(sym.warn)} no team agent key recorded for ${team} on this machine\n` +
          theme.meta(`  try \`musterd team agent-key --team ${team}\` to recover it\n`),
      );
      return 4;
    }
    process.stdout.write(`${held}\n`);
    return 0;
  }

  // `--key` — record a key the operator already holds (from another machine, or a conflict this
  // command refused to resolve on its own).
  const explicit = flagStr(parsed.flags, 'key');
  if (explicit) {
    if (!explicit.startsWith(TOKEN_PREFIXES.agent_key)) {
      throw new CliError(
        `"${explicit.slice(0, 6)}…" is not a team agent key — those start with ` +
          `\`${TOKEN_PREFIXES.agent_key}\`. A \`${TOKEN_PREFIXES.credential}\` is a person's ` +
          `credential (\`musterd claim\`), not the team key.`,
        2,
      );
    }
    return record(explicit, 'given with --key', []);
  }

  if (parsed.flags['rotate'] === true) return rotateTeamAgentKey(parsed, config, team, held, json);

  // The default: recover from the seat bindings this machine already holds.
  const found = recoverAgentKey(Object.keys(config.bindings), team, readBindingAt);
  if (found.key) {
    if (found.key === held) {
      if (json) {
        process.stdout.write(
          JSON.stringify({
            team,
            agent_key: held,
            source: 'already recorded',
            sources: found.sources,
          }) + '\n',
        );
        return 0;
      }
      process.stdout.write(
        success(`team agent key already recorded for ${team} — nothing to repair`) + '\n',
      );
      process.stdout.write(
        theme.meta(`  ${found.sources.length} seat binding(s) here agree with it\n`),
      );
      return 0;
    }
    return record(found.key, 'recovered from seat bindings', found.sources);
  }

  if (found.conflicts.length) {
    // Abstain loudly. Naming every candidate and its folders is the whole value here — the operator
    // knows which rotation was the real one; this command does not.
    const lines = found.conflicts
      .map((c) => `  ${c.key.slice(0, 12)}…  ${c.dirs.length} seat(s): ${c.dirs.join(', ')}`)
      .join('\n');
    throw new CliError(
      `the seat bindings on this machine disagree about "${team}"'s agent key, so nothing was ` +
        `recorded — a rotation landed partway. Candidates:\n${lines}\n` +
        `Pick one with \`musterd team agent-key --team ${team} --key <mskey_…>\`, or mint a fresh ` +
        `one for everybody with \`--rotate\`.`,
      4,
    );
  }

  throw new CliError(
    `no team agent key for "${team}" anywhere on this machine — not in the config, and no seat ` +
      `binding here carries one. If you have it, record it with \`--key <mskey_…>\`; otherwise mint ` +
      `a replacement with \`musterd team agent-key --team ${team} --rotate\` (which invalidates the ` +
      `old key for every seat on every machine).`,
    4,
  );
}

/**
 * `--rotate` — mint a new team agent key. The destructive branch, and gated accordingly: it counts
 * the local seat bindings still carrying the current key and refuses without `--yes`. On team
 * `revive` that count was eleven; rotating blind to fix an empty `agentKeys` map would have taken
 * every agent on the machine offline to repair a bookkeeping gap.
 *
 * The stale bindings are LISTED, not rewritten. A silent multi-folder rewrite of files holding
 * secrets is the wrong kind of convenience, and it could only ever reach this machine anyway — seats
 * on other machines need the new key regardless, so the honest output is the list plus the repair.
 */
async function rotateTeamAgentKey(
  parsed: Parsed,
  config: ReturnType<typeof loadConfig>,
  team: string,
  held: string | undefined,
  json: boolean,
): Promise<number> {
  const stale = Object.keys(config.bindings).filter((dir) => {
    const binding = readBindingAt(dir);
    return binding?.team === team && !!binding.agent_key?.startsWith(TOKEN_PREFIXES.agent_key);
  });

  if (parsed.flags['yes'] !== true) {
    throw new CliError(
      `rotating "${team}"'s agent key invalidates the key ${stale.length} seat binding(s) on this ` +
        `machine currently authenticate with${stale.length ? `:\n  ${stale.join('\n  ')}\n` : ', '}` +
        `plus every seat on every other machine. Nothing was changed. ` +
        `If you only lost the local record, \`musterd team agent-key --team ${team}\` recovers it ` +
        `without a rotation. To rotate anyway, re-run with \`--yes\`.`,
      2,
    );
  }

  // Admin act against a live daemon — `resolve` enforces an *active* identity (ADR 036), same bar as
  // `team add`, and the daemon audits the rotate as `key.rotate`.
  const { http } = resolve(parsed.flags);
  const mint = await http.rotateAgentKey(team);
  config.agentKeys[team] = mint.agent_key;
  saveConfig(config);

  if (json) {
    process.stdout.write(
      JSON.stringify({ team, agent_key: mint.agent_key, rotated: true, stale }) + '\n',
    );
    return 0;
  }
  process.stdout.write(success(`re-issued "${team}"'s team agent key`) + '\n');
  process.stdout.write(
    theme.meta('shown once — store it now, and hand it to any seat on another machine:') + '\n',
  );
  process.stdout.write(`  ${mint.agent_key}\n`);
  process.stdout.write(theme.meta('recorded in this machine’s config') + '\n');
  if (stale.length) {
    const wasHeld = held ? '' : ' (the old key was not in this config, so it is not shown)';
    process.stdout.write(
      `${theme.warn(sym.warn)} ${stale.length} seat binding(s) here still hold the OLD key${wasHeld} — ` +
        `they will 403 on their next claim:\n` +
        stale.map((d) => theme.meta(`    ${d}`)).join('\n') +
        '\n' +
        theme.meta(`  repair each with \`musterd wire\` in the folder — it re-reads this config.`) +
        '\n',
    );
  }
  return 0;
}

/**
 * Repair what this machine holds for `(team, name)` after a rotate — the vault entry (ADR 059), the
 * team's active identity slot, and the workspace binding when it names that same seat. Every write
 * is conditional on the seat already being known here: a rotate must never *create* a local identity
 * for someone, only refresh one that already existed and just went stale.
 *
 * Exported for tests; returns what it actually changed so the caller can say so.
 */
export function repairLocalCredential(
  config: ReturnType<typeof loadConfig>,
  team: string,
  name: string,
  credential: string,
): { identity: boolean; binding: boolean } {
  let identity = false;
  const known = config.knownIdentities.find((i) => i.team === team && i.name === name);
  if (known) {
    rememberIdentity(config, { ...known, key: credential });
    identity = true;
  }
  const active = config.identities[team];
  if (active && active.name === name) {
    config.identities[team] = { ...active, key: credential };
    identity = true;
  }
  if (identity) saveConfig(config);

  // The binding is per-folder and holds the seat's bearer secret in `agent_key` (for a human folder
  // that is their mscr_ — see helpers.gather). Rewrite it only when this folder is bound to the very
  // seat that rotated, and only for the same team.
  let binding = false;
  const dir = findWorkspaceDir();
  const current = dir ? findBinding(dir) : null;
  if (dir && current && current.team === team && bindingSeat(current) === name) {
    saveBinding(dir, { ...current, agent_key: credential });
    binding = true;
  }
  return { identity, binding };
}

/**
 * Soft-remove a member from a team's roster (ADR 019). The sanctioned way to clear a mistaken or
 * stale member instead of editing the daemon's DB: it sets `left_at`, so the member drops off every
 * roster/auth path while its message history + provenance survive. Idempotent — an already-removed
 * (or never-existing) member is a clean `not_found`, not an error stack.
 */
async function teamRemove(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team remove <name>', 2);
  const { team, http } = resolve(parsed.flags);
  const res = await http.removeMember(team, name);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`removed ${theme.memberName(res.member, res.kind)} from ${team}`) + '\n',
  );
  process.stdout.write(theme.meta('off the roster; message history is kept') + '\n');
  return 0;
}

/**
 * Soft-archive a team (the inverse of `team create`). Admin-only + audited `team.archive`: sets
 * `archived_at`, so the team drops off status/rosters and refuses auth while its history survives —
 * the sanctioned cleanup for a junk/finished team instead of SQL against the daemon's db. The slug is
 * always explicit (never the ambient bound team) so a fat-fingered bare `team archive` can't take
 * down the team you're working on; auth still needs an admin identity for THAT team (its creator
 * credential is in the vault from `team create` — name it with `--as` if you're bound elsewhere).
 */
async function teamArchive(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug)
    throw new CliError("usage: musterd team archive <slug>  (run from an admin's Workspace)", 2);
  const { http } = resolve({ ...parsed.flags, team: slug });
  const res = await http.archiveTeam(slug);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(success(`archived team "${slug}"`) + '\n');
  process.stdout.write(
    theme.meta('off every roster and status surface; history is kept (soft archive)') + '\n',
  );
  return 0;
}

/** The roster fields `team export` needs from a live member (a subset of MemberSummary). */
export interface RosterMember {
  name: string;
  kind: MemberKind;
  role: string;
  lifecycle: Lifecycle;
  lifecycle_until?: number | null;
  /** The seat's EFFECTIVE capabilities. Admin-visible only, and load-bearing — see below. */
  capabilities?: Capabilities | undefined;
  /** ADR 449 §3: the member who created this agent, if any. A seat file cannot carry it. */
  sponsored_by?: string | null | undefined;
}

/**
 * Project a live roster into canonical durable files (ADR 058 / migration-bootstrap.md), keyed by
 * path. Pure + token-free — no secret ever reaches a file. Runs the format-layer parity self-check
 * (serialize → parse reproduces each seat's identity) so a serializer bug aborts the export instead
 * of silently writing files that don't reproduce the roster.
 */
/**
 * Capability fields a round-trip through this seat file would LOSE, for a seat with no role.
 *
 * Only decidable without a role: the ceiling is then the generalist default, which both sides know,
 * so `effectiveCapabilities({}, override)` here is exactly what reconcile will compute there. A
 * seat carrying a role is not judged — its ceiling lives in the db and is not readable from the CLI.
 */
function capabilitiesLostOnReconcile(
  seat: SeatFile,
  parsedBack: SeatFile,
  live: Capabilities | undefined,
): string[] {
  if ((seat.role ?? '') !== '' || !live) return [];
  const rebuilt = effectiveCapabilities({}, parsedBack.capabilities ?? {});
  return (Object.keys(live) as Array<keyof Capabilities>).filter(
    (k) => JSON.stringify(rebuilt[k]) !== JSON.stringify(live[k]),
  );
}

/**
 * The capability fields that differ from the generalist default, or undefined when none do. Keeps a
 * seat file to the lines a reviewer needs — the point of putting the roster in git in the first place.
 */
function capabilityDiff(caps: Capabilities | undefined): Capabilities | undefined {
  if (!caps) return undefined;
  const g = effectiveCapabilities({}, {});
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(g) as Array<keyof Capabilities>) {
    if (JSON.stringify(caps[k]) !== JSON.stringify(g[k])) out[k] = caps[k];
  }
  return Object.keys(out).length > 0 ? (out as unknown as Capabilities) : undefined;
}

export function rosterToFiles(
  slug: string,
  members: RosterMember[],
): { teamToml: string; seatFiles: Record<string, string> } {
  // ADR 463 §4.2: a seat file cannot carry `sponsored_by`, and on a file-backed team reconcile is the
  // account-status writer — so after a cutover, disabling a sponsor would reach none of its agents
  // (and each agent's own file would re-enable it). The daemon refuses that projection; say so here,
  // before any file is written, with the way out.
  const sponsored = members.filter((m) => m.sponsored_by);
  if (sponsored.length > 0) {
    throw new CliError(
      `"${slug}" still holds sponsored agents (${sponsored.map((m) => m.name).join(', ')}) — seat ` +
        'files cannot carry sponsorship, so the roster must stay in the daemon. Remove them first ' +
        '(`musterd team remove <name>`), then export again. (ADR 463 §4.2)',
      1,
    );
  }
  const team: TeamFile = { slug, lifecycle: 'forever' };
  const seatFiles: Record<string, string> = {};
  for (const m of members) {
    const seat: SeatFile = { kind: m.kind, role: m.role ?? '' };
    if (m.lifecycle && m.lifecycle !== 'forever') {
      seat.lifecycle = m.lifecycle;
      if (m.lifecycle === 'until' && m.lifecycle_until) {
        seat.until = new Date(m.lifecycle_until).toISOString();
      }
    }
    // Capabilities are part of the roster, so a file set that omits them does not reproduce it.
    // Dropping them here is what silently de-admined revive on 2026-08-01: reconcile REBUILDS every
    // seat's capabilities from `effectiveCapabilities(roleDefaults[role], seat.capabilities)`, so a
    // seat file carrying only kind+role tells it to rebuild the creator as a plain generalist — and
    // the team ended up with no admin at all, with no audit row and no way back through the API.
    //
    // Writing the effective set is safe in both directions: an override can only NARROW, so this
    // can never grant a seat more than its role allows; and where the role already grants it, the
    // clamp returns the same value. What it cannot do is manufacture authority the role withholds —
    // which is exactly the case the parity check below refuses rather than writes.
    // Only the fields that differ from the generalist default, so a roster stays readable in a diff
    // — these files exist to be reviewed in git (ADR 058), and seven lines per seat restating the
    // defaults would bury the one line that matters. Omitted fields fall back to the role ceiling,
    // which is what reconcile does anyway, so a plain seat still writes exactly kind+role.
    const narrowed = capabilityDiff(m.capabilities);
    if (narrowed) seat.capabilities = narrowed;
    const text = serializeSeat(seat);
    const back = parseSeatFile(text, m.name);
    if (
      back.kind !== seat.kind ||
      (back.role ?? '') !== (seat.role ?? '') ||
      back.lifecycle !== seat.lifecycle ||
      back.until !== seat.until
    ) {
      throw new CliError(
        `parity check failed for seat "${m.name}" — the roster files would not reproduce the live roster`,
        1,
      );
    }
    // The capability half of the parity check, for the case this side can actually decide. With no
    // role the ceiling IS the generalist default, which is known here, so reconcile's result is
    // reproducible exactly — and any field that would come back lower is authority the export is
    // about to destroy. A seat WITH a role is left to the server: role defaults live only in the db
    // (there is no `/roles` read), and guessing a ceiling we cannot see is how this bug was written
    // the first time. Reconcile's own zero-admin check is the backstop there.
    const lost = capabilitiesLostOnReconcile(seat, back, m.capabilities);
    if (lost.length > 0) {
      throw new CliError(
        `export would DESTROY authority on seat "${m.name}": [${lost.join(', ')}] cannot survive a ` +
          `seat file, because a seat override only narrows and "${m.name}" holds no role granting ` +
          `them. Give the seat a role whose capabilities carry them, then export again. ` +
          `(Writing these files would leave the roster quietly weaker than the live team.)`,
        1,
      );
    }
    seatFiles[`${m.name}.toml`] = text;
  }
  return { teamToml: serializeTeam(team), seatFiles };
}

/**
 * One-time db→file inversion (migration-bootstrap.md): read the live roster, write the canonical
 * `.musterd/` files in this folder, and register it as the team's roster home (the cutover signal).
 * Refuses if `team.toml` already exists (idempotency without clobber). No token touches a file; the
 * very next reconcile is a no-op UPDATE that preserves every live token (D ≡ C by construction).
 */
async function teamExport(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug) throw new CliError('usage: musterd team export <slug> [--to <dir>]', 2);
  // Where the roster lands (ADR 176 §1, increment 3): an explicit `--to` wins, else the team's own
  // home, else this folder. The default matters because "which repo owns the roster when several
  // touch one team" was migration-bootstrap.md's open question, and install-topology §4 answered it
  // by saying **no repo does** — the roster's home is the *team's* home. Exporting into whatever
  // folder you happened to stand in is how that question arose in the first place.
  //
  // `teamHome` and `rosterHome` still compose rather than merge: this changes only the DEFAULT
  // DESTINATION. Recording `rosterHome` — ADR 058's file-authoritative cutover signal — is unchanged
  // below, and having a home never implies the flip. Nor does exporting invent a home: a team with
  // no `teamHome` exports here, exactly as before.
  const explicitTo = flagStr(parsed.flags, 'to');
  const home = loadConfig().teamHome[slug];
  const dir = resolvePath(explicitTo ?? home ?? process.cwd());
  const musterdDir = join(dir, '.musterd');
  const teamFile = join(musterdDir, 'team.toml');
  if (existsSync(teamFile)) {
    throw new CliError(
      `"${slug}" already looks file-backed — ${teamFile} exists (refusing to clobber hand-edits)`,
      1,
    );
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const http = new HttpClient({ server });
  const { members } = await http.roster(slug);
  const { teamToml, seatFiles } = rosterToFiles(
    slug,
    members.map((m) => ({
      name: m.name,
      kind: m.kind,
      role: m.role,
      lifecycle: m.lifecycle,
      lifecycle_until: m.lifecycle_until ?? null,
      // Admin-visible only; when the roster does not carry them the seat file simply omits them and
      // reconcile keeps rebuilding from the role, exactly as before this change.
      capabilities: m.capabilities,
      sponsored_by: m.sponsored_by ?? null,
    })),
  );

  mkdirSync(join(musterdDir, 'seats'), { recursive: true });
  writeFileSync(teamFile, teamToml);
  for (const [fname, body] of Object.entries(seatFiles)) {
    writeFileSync(join(musterdDir, 'seats', fname), body);
  }
  recordRosterHome(config, slug, dir);
  saveConfig(config);

  // This command's last words are "git add + commit them", and the roster it just wrote shares
  // `.musterd/` with a live credential — so earn that instruction before giving it. Unconditional,
  // including when `dir` fell back to cwd and holds no binding: "a repo does not commit a musterd
  // credential" is true of that repo too, and a condition here is only a way to get it wrong later.
  const safeToCommit = excludeCredentialFromGit(dir);

  const count = Object.keys(seatFiles).length;
  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        slug,
        rosterHome: dir,
        credentialExcluded: safeToCommit,
        // Say WHY it landed there, so a default that moved the files somewhere other than the folder
        // you typed in is legible rather than surprising.
        destination: explicitTo ? 'flag' : home ? 'teamHome' : 'cwd',
        seats: Object.keys(seatFiles),
      }) + '\n',
    );
    return 0;
  }
  const where = dir === process.cwd() ? '.musterd/' : join(dir, '.musterd');
  process.stdout.write(
    success(`exported "${slug}" roster → ${where} (${count} seat${count === 1 ? '' : 's'})`, {
      next: 'musterd reload',
    }) + '\n',
  );
  if (!explicitTo && home) {
    process.stdout.write(
      theme.meta(`the roster's home is the team's home, not a project repo — ${dir} (ADR 176).`) +
        '\n',
    );
  }
  if (safeToCommit) {
    process.stdout.write(
      theme.meta(
        'these files are now the source of truth — git add + commit them for a reviewable roster.',
      ) + '\n',
    );
  } else {
    // The roster is written and the export succeeded; what failed is the guard. Say so instead of
    // handing over an instruction that would commit a credential.
    process.stdout.write(
      theme.warn(
        `${sym.warn} could not write ${join(dir, '.gitignore')} — not telling you to commit yet: ` +
          `${join('.musterd', 'binding.json')} there holds a live credential. Exclude it, then commit the roster.`,
      ) + '\n',
    );
  }
  process.stdout.write(
    theme.meta(
      'provisioning (team add/claim) is file-backed immediately; `musterd reload` makes the daemon track edits.',
    ) + '\n',
  );
  return 0;
}

function defaultUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'me';
}
