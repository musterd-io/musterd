import {
  PolicyOverrideSchema,
  type ApprovalDescriptor,
  type PolicyOverride,
} from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd authority enroll [--confirmed-by <admin>]\n' +
  '       musterd authority keys\n' +
  '       musterd authority revoke <key-id>\n' +
  '       musterd authority approve --act <act> --target <target> --payload <json>';

/**
 * ADR 662 decisions 5/6 — the device-key lifecycle from the terminal, passkey-first.
 * The key lives in the human's authenticator, never in a file an agent process on
 * this machine could read (HA3 re-review: the old file-stored software key was
 * readable by every process running as the human, so it qualified as nothing).
 * `enroll` runs the browser ceremony on the daemon's own origin; when a key already
 * stands, a further passkey first needs that key's approval, collected the same way.
 * `approve` fetches the descriptor from the server itself (decision 5) — the words
 * a human approves are the server's, never the caller's.
 */

type Http = ReturnType<typeof resolve>['http'];
type Proof = Awaited<ReturnType<Http['getParkedApproval']>>['proof'];

/**
 * WebAuthn refuses an IP-literal relying-party ID ("invalid domain"), so a
 * ceremony URL on 127.0.0.1/::1 can never complete. `localhost` is a valid
 * RP ID and the daemon pins it as an expected origin. Only the printed
 * browser URL is rewritten — API calls keep the configured server URL.
 */
export function browserOrigin(server: string): string {
  try {
    const u = new URL(server);
    if (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1') {
      u.hostname = 'localhost';
      return u.origin;
    }
    return server.replace(/\/$/, '');
  } catch {
    return server;
  }
}

function printJson(value: unknown): number {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return 0;
}

/** Build the server's descriptor, send the human to approve it with their passkey, and wait for the
 * parked proof (ADR 662). Exported for any command whose act the daemon refuses unsigned. */
export async function collectApproval(
  http: Http,
  team: string,
  act: string,
  target: string,
  payload: unknown,
  actor?: string,
): Promise<Proof> {
  const { descriptor } = await http.createAuthorityDescriptor(team, {
    act,
    target,
    payload,
    ...(actor ? { actor } : {}),
  });
  const d = descriptor as ApprovalDescriptor;
  process.stdout.write(
    `descriptor (built by the server):\n  actor:  ${d.actor}\n  act:    ${d.act}\n` +
      `  target: ${d.target}\n  expires: ${new Date(d.expiry).toISOString()}\n`,
  );
  const url =
    `${browserOrigin(http.server)}/authority/approve?team=${encodeURIComponent(team)}` +
    `&nonce=${encodeURIComponent(d.nonce)}`;
  process.stdout.write(`Approve at ${url}\nwaiting for the parked proof…\n`);
  const deadline = Date.now() + 4 * 60 * 1000;
  for (;;) {
    try {
      const { proof } = await http.getParkedApproval(team, d.nonce);
      return proof;
    } catch {
      if (Date.now() > deadline) throw new CliError('no approval arrived in 4 minutes', 1);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * Write the team policy as a human admin (ADR 662: `admin.team_policy` is a listed act). The write
 * goes first without a proof, which is all a human with no enrolled key needs; when the server
 * answers `no_signature`, the server-built descriptor over the exact stored doc is approved with
 * the passkey and the same write is sent again carrying the proof.
 */
export async function setPolicySigned(
  http: Http,
  team: string,
  policy: PolicyOverride,
): ReturnType<Http['setPolicy']> {
  try {
    return await http.setPolicy(team, policy);
  } catch (err) {
    if (!(err instanceof CliError && /authority refused \(no_signature\)/.test(err.message)))
      throw err;
  }
  process.stdout.write('Team policy is a high-authority act — approve it with your passkey.\n');
  const approval = await collectApproval(
    http,
    team,
    'admin.team_policy',
    team,
    PolicyOverrideSchema.parse(policy),
  );
  return http.setPolicy(team, policy, approval);
}

/**
 * The flags `musterd authority` takes (lane
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
 * The flags `musterd authority` takes (lane
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
export const AUTHORITY_FLAGS = [
  '--disable-dev-shm-usage',
  '--git-dir',
  '--help',
  '--json',
  '--no-sandbox',
  '--porcelain',
  '--show-toplevel',
  '--switch',
  '--version',
  '-c',
  '-f',
  '-movflags',
  '-preset',
  '-t',
  '1080p',
  '4500k',
  '720p',
  'abandon-reason',
  'abort',
  'aborted',
  'acceptance-review-window',
  'act',
  'add',
  'agent-connect',
  'allow',
  'allowed',
  'allowed-host',
  'app',
  'area',
  'ask-fallback-to-nonadmin',
  'ask-slack-webhook',
  'assign-missing',
  'attempt-cap',
  'audio',
  'auth',
  'authorized-by',
  'away-relay',
  'away-token',
  'base64url',
  'baseline',
  'bitrate',
  'block',
  'blocked',
  'blocking',
  'branch',
  'broadcast',
  'budget',
  'by',
  'capture',
  'capture-nodes',
  'channel',
  'check',
  'check-build',
  'claim',
  'claimed',
  'claims',
  'claude',
  'clear-merged',
  'client',
  'close',
  'cloud-provision',
  'codex',
  'commit',
  'confirmed-by',
  'connect',
  'connection',
  'content-type',
  'convene-huddles',
  'cooldown',
  'credential',
  'data',
  'day',
  'default',
  'defaults',
  'depends',
  'detail',
  'direction',
  'dispatch-loop',
  'display',
  'doorbell',
  'dream',
  'dream-budget',
  'dream-nightly',
  'duration',
  'encoder',
  'end',
  'enforce-action',
  'enforce-posture',
  'enforce-route',
  'enforce-surface',
  'enroll',
  'error',
  'evidence',
  'exec',
  'exit',
  'expires',
  'expires-in',
  'fail-budget',
  'fetch',
  'ffmpeg',
  'fix',
  'flags',
  'flow',
  'fly',
  'fly-auth',
  'follows-up',
  'format',
  'fps',
  'git',
  'goal',
  'grant',
  'guardian-tier',
  'harness',
  'hex',
  'host',
  'hosted-budget',
  'hourly-cap',
  'http',
  'hue',
  'idle-wake',
  'ignore',
  'image',
  'incident',
  'incident-claim-window',
  'incident-fallback-role',
  'incident-threshold',
  'incident-wake-on-resolve',
  'incident-wake-on-route',
  'inherit',
  'install',
  'installed',
  'interval',
  'into',
  'invite-requires-expiry',
  'key',
  'key-env',
  'kind',
  'label',
  'lane',
  'lanes',
  'leases',
  'libx264',
  'lifecycle',
  'local-session-live',
  'log',
  'ls-files',
  'main',
  'malformed',
  'max-turns',
  'measured',
  'member',
  'member-until',
  'metric',
  'metric-source',
  'migrate-bootstrap',
  'mine',
  'mint-seat',
  'musterd',
  'musterd-cli',
  'musterd-host',
  'musterd-stream-key',
  'n',
  'new',
  'no-gateway',
  'none',
  'note',
  'on',
  'open',
  'opencode',
  'origin',
  'out',
  'payload',
  'pipe',
  'pr',
  'project',
  'proof',
  'prose',
  'ps',
  'pull',
  'push',
  'pushback',
  'q',
  'read-note',
  'read-verdict',
  'reads-on',
  'reason',
  'refresh-permissions',
  'remote',
  'repair',
  'requested',
  'reseat-known-agents',
  'residency',
  'resolution',
  'response',
  'result',
  'rev-list',
  'rev-parse',
  'review',
  'review-by',
  'review-loop',
  'risk',
  'role',
  'rotate',
  'rtmp',
  'run',
  'screencast',
  'seat',
  'secrets',
  'security',
  'seed',
  'seeds-relay',
  'seeds-token',
  'self',
  'serve',
  'session',
  'set',
  'sha',
  'sha256',
  'show',
  'slack',
  'slack-bot-token',
  'source',
  'source-ref',
  'spend-approval',
  'spend-cap',
  'sponsor',
  'sponsored-agent-cap',
  'spread',
  'sqlite3',
  'stakes',
  'stakes-default',
  'state',
  'status',
  'stop',
  'stream',
  'surface',
  'sweep-loop',
  'switch',
  'tailnet',
  'target',
  'tiers',
  'timeout',
  'title',
  'to',
  'tool-policy',
  'trace-content',
  'transcript-max',
  'twitch',
  'unit',
  'unowned',
  'unpriced-wake-cap',
  'unreachable',
  'unset',
  'until',
  'upgrade',
  'url',
  'uses',
  'utf8',
  'value',
  'version',
  'veryfast',
  'videotoolbox',
  'webhook',
  'whoami',
  'work-timeout',
  'workspace',
  'x11',
  'yes',
] as const;

export async function authorityCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...AUTHORITY_FLAGS],
    'the flags `musterd authority` takes are listed by `musterd help authority`',
  );
  const sub = parsed.positionals[0] ?? 'keys';
  const { team, identity, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;
  const member = identity.name;

  if (sub === 'enroll') {
    const before = await http.listDeviceKeys(team);
    const beforeIds = new Set(before.keys.map((k) => k.id));
    const active = before.keys.filter((k) => k.revoked_at === null);
    let approval: Proof | undefined;
    let countersign: { confirmer: string; approval: Proof } | undefined;
    const confirmedBy = flagStr(parsed.flags, 'confirmed-by');
    if (active.length > 0) {
      process.stdout.write('A device key already stands — the new passkey needs its approval.\n');
      approval = await collectApproval(http, team, 'device_key_admin', member, {
        action: 'enroll',
        kind: 'passkey',
      });
    } else if (confirmedBy) {
      process.stdout.write(
        `No standing key of yours — ${confirmedBy} (a human admin) must countersign.\n` +
          `They open the approval link and approve with their passkey.\n`,
      );
      const proof = await collectApproval(
        http,
        team,
        'device_key_admin',
        member,
        { action: 'enroll', kind: 'passkey', member },
        confirmedBy,
      );
      countersign = { confirmer: confirmedBy, approval: proof };
    }
    const { challenge } = await http.issueEnrollmentChallenge(team);
    const fragment = approval
      ? `#approval=${Buffer.from(JSON.stringify(approval)).toString('base64url')}`
      : countersign
        ? `#countersign=${Buffer.from(JSON.stringify(countersign)).toString('base64url')}`
        : '';
    const url =
      `${browserOrigin(http.server)}/authority/passkey?team=${encodeURIComponent(team)}` +
      `&member=${encodeURIComponent(member)}&challenge=${encodeURIComponent(challenge)}` +
      fragment;
    process.stdout.write(`Open ${url}\nwaiting for the passkey ceremony…\n`);
    const deadline = Date.now() + 4 * 60 * 1000;
    for (;;) {
      const { keys } = await http.listDeviceKeys(team);
      const fresh = keys.find((k) => !beforeIds.has(k.id) && k.revoked_at === null);
      if (fresh) {
        if (json) return printJson(fresh);
        process.stdout.write(
          success(`passkey enrolled for ${member} (${fresh.id})`, {
            next: 'high-authority acts now ask this passkey (ADR 662)',
          }) + '\n',
        );
        return 0;
      }
      if (Date.now() > deadline) {
        throw new CliError(
          confirmedBy || active.length > 0
            ? 'no passkey was enrolled in 4 minutes'
            : 'no passkey was enrolled in 4 minutes — if this team already has device keys, ' +
                'a human admin must countersign: re-run with --confirmed-by <admin>',
          1,
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (sub === 'approve') {
    const act = flagStr(parsed.flags, 'act');
    const target = flagStr(parsed.flags, 'target');
    const payloadRaw = flagStr(parsed.flags, 'payload');
    if (!act || !target || !payloadRaw) throw new CliError(USAGE, 2);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      throw new CliError('--payload must be JSON', 2);
    }
    const proof = await collectApproval(http, team, act, target, payload);
    process.stdout.write(JSON.stringify(proof) + '\n');
    return 0;
  }

  if (sub === 'keys') {
    const { keys } = await http.listDeviceKeys(team);
    if (json) return printJson(keys);
    if (keys.length === 0) process.stdout.write('no device keys enrolled\n');
    for (const k of keys) {
      process.stdout.write(`${k.id}  ${k.kind}  ${k.revoked_at ? 'revoked' : 'active'}\n`);
    }
    return 0;
  }

  if (sub === 'revoke') {
    const keyId = parsed.positionals[1];
    if (!keyId) throw new CliError(USAGE, 2);
    const approval = await collectApproval(http, team, 'device_key_admin', member, {
      action: 'revoke',
      key_id: keyId,
    });
    await http.revokeDeviceKey(team, keyId, { approval });
    if (json) return printJson({ ok: true, key_id: keyId });
    process.stdout.write(success(`device key ${keyId} revoked`) + '\n');
    return 0;
  }

  throw new CliError(USAGE, 2);
}
