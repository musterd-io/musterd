import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import {
  PolicyOverrideSchema,
  vouchCheckCode,
  type ApprovalDescriptor,
  type PolicyOverride,
} from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { machineStatePath } from '../machinePaths.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve, resolveRead } from './helpers.js';

const USAGE =
  'usage: musterd authority enroll [--confirmed-by <admin>]\n' +
  '       musterd authority keys\n' +
  '       musterd authority revoke <key-id>\n' +
  '       musterd authority recover <member>   (on the hub machine, ADR 808)\n' +
  '       musterd authority approve --act <act> --target <target> --payload <json> [--code <6 digits>]';

/**
 * ADR 662 decisions 5/6 — the device-key lifecycle from the terminal, passkey-first.
 * The key lives in the human's authenticator, never in a file an agent process on
 * this machine could read (HA3 re-review: the old file-stored software key was
 * readable by every process running as the human, so it qualified as nothing).
 * `enroll` runs the browser ceremony on the daemon's own origin; when a key already
 * stands, a further passkey first needs that key's approval, collected the same way.
 * Past genesis, with no key of yours that signs here, the passkey is held for an admin's vouch
 * (ADR 769): `enroll` prints the check code and the exact `approve` line the admin runs on the hub,
 * and the admin's `approve` asks for the code the member reads them before it signs.
 * `approve` fetches the descriptor from the server itself (decision 5) — the words
 * a human approves are the server's, never the caller's.
 */

type Http = ReturnType<typeof resolve>['http'];
type Proof = Awaited<ReturnType<Http['getParkedApproval']>>['proof'];

/** ADR 662 / ADR 694: a human's verdict on an acceptance ask signs the lane verdict, not the ask id. */
export function laneReviewApproval(lane: string, verdict: 'accept' | 'decline') {
  return {
    act: 'human_accept' as const,
    target: lane,
    payload: { lane, verdict },
  };
}

function printJson(value: unknown): number {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  return 0;
}

/** Human ceremony prompts go to stderr: stdout may carry `--json` output a script is
 * parsing (create.sh's `bootstrap mint --json | jq`), and prompt text there kills the
 * parser, then the writer dies EPIPE on the closed pipe (lane 01M5ZE7F4G). */
function humanPrompt(text: string): void {
  process.stderr.write(text);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One live held enrollment, as `GET /authority/passkeys/held` lists it (ADR 769). */
interface HeldEnrollment {
  enrollment_digest: string;
  expires_at: number;
  check_code: string;
  countersigners: string[];
}

/**
 * ADR 769: the hold this terminal's ceremony made — the one whose code expires when this
 * challenge does (both are the same enrollment code). A joiner cannot hold (the vouch is the
 * hub's), so its refusal is said in words.
 */
async function heldForChallenge(
  http: Http,
  team: string,
  expiresAt: number,
): Promise<HeldEnrollment | undefined> {
  try {
    const { held } = await http.listHeldEnrollments(team);
    return held.find((h) => h.expires_at === expiresAt);
  } catch (e) {
    if (
      e instanceof Error &&
      /hub_local_required|must be performed on a Surface attached to the hub/.test(e.message)
    ) {
      throw new CliError(
        "an admin's vouch runs on the hub: enroll from the hub's /live (Settings → You) or a terminal on the hub",
        1,
      );
    }
    return undefined;
  }
}

/** What the member reads aloud, and the line the admin runs. Pure, so it is testable. */
export function vouchInstructions(
  member: string,
  held: Pick<HeldEnrollment, 'enrollment_digest' | 'check_code' | 'countersigners'>,
  confirmedBy: string | undefined,
): string {
  const payload = JSON.stringify({
    action: 'enroll',
    kind: 'passkey',
    member,
    key: held.enrollment_digest,
  });
  const line =
    `  musterd authority approve --act device_key_admin --target ${shellQuote(member)} ` +
    `--payload ${shellQuote(payload)}`;
  const who =
    held.countersigners.length === 0
      ? 'Nobody on the team can vouch for you here: ask whoever runs the hub machine for a ' +
        `recovery code (\`musterd authority recover ${member}\`).\n`
      : confirmedBy && !held.countersigners.includes(confirmedBy)
        ? `${confirmedBy} cannot vouch here (no admin key of theirs signs on this hub). ` +
          `Admins who can: ${held.countersigners.join(', ')}.\n`
        : `Admins who can vouch: ${held.countersigners.join(', ')}.\n`;
  return (
    `\nAn admin must vouch for this passkey. Read them this code on a call or in person:\n\n` +
    `    ${held.check_code}\n\n` +
    who +
    `They run, on the hub (it asks them for your code before it signs):\n${line}\n\n` +
    'waiting for their vouch…\n'
  );
}

/** ADR 769: the vouch payload shape, `{action:'enroll', kind:'passkey', member, key}`, member = target. */
function vouchPayloadKey(payload: unknown, target: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p['action'] !== 'enroll' || p['kind'] !== 'passkey' || p['member'] !== target) return null;
  const key = p['key'];
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : null;
}

/** Ask for the vouch code on a terminal; undefined when there is no terminal to ask on. */
async function askCode(member: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `Call ${member} or ask in person. Enter the 6-digit code they read you: `,
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

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

/**
 * The origin a ceremony URL must be opened at. Since the hub moved off the laptop the
 * configured server is its plain-http tailnet IP, where `navigator.credentials` does not
 * exist and the approve page dies before WebAuthn (measured 2026-11-05, lane
 * 01M6Q0MJ2Z). The daemon's `/health` names `browser_origin` — its first https passkey
 * origin, on the same node that built the descriptor (#3900) — so prefer it whenever it
 * is https. The probe fails open to the server-origin rule: a ceremony must never die
 * because a health read did.
 */
export async function resolveCeremonyOrigin(
  http: Pick<Http, 'server'> & Partial<Pick<Http, 'health'>>,
): Promise<string> {
  try {
    const health = typeof http.health === 'function' ? await http.health() : undefined;
    const origin = health?.browser_origin;
    if (typeof origin === 'string' && origin.startsWith('https://'))
      return origin.replace(/\/+$/, '');
  } catch {
    // fall through to the configured server origin
  }
  return browserOrigin(http.server);
}

/** How a terminal launches the ceremony page. A pipe returns null so a capturing script never
 * opens a browser. Chrome is named outright: the Mac login passkey sheet has to come up in the
 * browser the human actually uses, not whichever app owns http. */
export function ceremonyLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
  tty: boolean = Boolean(process.stdout.isTTY),
): { command: string; args: string[] } | null {
  if (!tty) return null;
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'Google Chrome', url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', 'chrome', url] };
  return { command: 'google-chrome', args: [url] };
}

type CeremonyChild = {
  unref: () => void;
  on: (event: 'error' | 'exit', listener: (code?: number | null) => void) => void;
};

/** Open the ceremony URL in Chrome. False when this is not a terminal, or Chrome does not start.
 * The printed URL remains either way. */
export function openCeremony(
  url: string,
  opts: {
    platform?: NodeJS.Platform;
    tty?: boolean;
    spawn?: (
      command: string,
      args: readonly string[],
      options: { stdio: 'ignore'; detached: true },
    ) => CeremonyChild;
  } = {},
): Promise<boolean> {
  const launch = ceremonyLaunch(
    url,
    opts.platform ?? process.platform,
    opts.tty ?? Boolean(process.stdout.isTTY),
  );
  if (!launch) return Promise.resolve(false);
  const start = opts.spawn ?? spawn;
  const child = start(launch.command, launch.args, { stdio: 'ignore', detached: true });
  child.unref();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(false), 1500);
    function done(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    }
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}

/** Print the ceremony URL, open it in Chrome on a terminal, then say what the command is waiting for. */
async function presentCeremony(lead: string, url: string, waiting: string): Promise<void> {
  humanPrompt(`${lead} ${url}\n`);
  if (await openCeremony(url)) humanPrompt('Opened in Chrome.\n');
  humanPrompt(waiting);
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
  humanPrompt(
    `descriptor (built by the server):\n  actor:  ${d.actor}\n  act:    ${d.act}\n` +
      `  target: ${d.target}\n  expires: ${new Date(d.expiry).toISOString()}\n`,
  );
  const url =
    `${await resolveCeremonyOrigin(http)}/authority/approve?team=${encodeURIComponent(team)}` +
    `&nonce=${encodeURIComponent(d.nonce)}`;
  await presentCeremony('Approve at', url, 'waiting for the parked proof…\n');
  // Wait as long as the descriptor lives — no longer, no shorter. A fixed 4-minute wait
  // against the server's 5-minute descriptor left a minute where the browser approval
  // succeeded, parked a proof, and nobody consumed it (measured 2026-11-05).
  for (;;) {
    try {
      const { proof } = await http.getParkedApproval(team, d.nonce);
      return proof;
    } catch {
      if (Date.now() > d.expiry)
        throw new CliError(
          'no approval arrived before the descriptor expired — re-run the command to mint a fresh one',
          1,
        );
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
  humanPrompt('Team policy is a high-authority act — approve it with your passkey.\n');
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
  'code',
  'codex',
  'commit',
  'confirmed-by',
  'countersign-proof',
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
  'metric-harness',
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
    if (parsed.flags['confirmed-by'] === true)
      throw new CliError('--confirmed-by needs an admin name', 2);
    if (parsed.flags['countersign-proof'] !== undefined) {
      throw new CliError(
        '--countersign-proof is retired (ADR 769): run `musterd authority enroll --confirmed-by <admin>` ' +
          'and it prints the command your admin runs on the hub, after you read them a check code',
        2,
      );
    }
    const confirmedBy = flagStr(parsed.flags, 'confirmed-by');
    // ADR 769: with no key of yours, or when you say an admin vouches (your keys do not sign here),
    // the daemon holds the passkey for that admin. Otherwise your standing key approves it.
    const vouch = confirmedBy !== undefined || active.length === 0;
    if (!vouch) {
      humanPrompt('A device key already stands — the new passkey needs its approval.\n');
      approval = await collectApproval(http, team, 'device_key_admin', member, {
        action: 'enroll',
        kind: 'passkey',
      });
    }
    const { challenge, expires_at: challengeExpiresAt } = await http.issueEnrollmentChallenge(team);
    // The page is unauthenticated, so it cannot list this member's passkeys itself; this command
    // can. Without excludeCredentials an authenticator that already holds a passkey for this user
    // handle silently replaces it (nick's, 2026-11-05 — /live's fix was lane 01M6Q3ZJJB). The
    // fragment never reaches a server; credential ids are public identifiers anyway.
    const exclude = active
      .filter((k) => k.kind === 'passkey' && !!k.credential_id)
      .map((k) => k.credential_id as string);
    const fragment =
      (approval
        ? `#approval=${Buffer.from(JSON.stringify(approval)).toString('base64url')}`
        : '#hold=1') + (exclude.length > 0 ? `&exclude=${exclude.join(',')}` : '');
    const url =
      `${await resolveCeremonyOrigin(http)}/authority/passkey?team=${encodeURIComponent(team)}` +
      `&member=${encodeURIComponent(member)}&challenge=${encodeURIComponent(challenge)}` +
      fragment;
    await presentCeremony('Open', url, 'waiting for the passkey ceremony…\n');
    // The challenge outlives a fixed 4-minute wait (10 minutes server-side); wait for
    // its whole life so a late-completed ceremony is still the one this command reports.
    const deadline = challengeExpiresAt;
    let announced = false;
    for (;;) {
      const { keys } = await http.listDeviceKeys(team);
      const fresh = keys.find((k) => !beforeIds.has(k.id) && k.revoked_at === null);
      if (!fresh && vouch && !announced) {
        const held = await heldForChallenge(http, team, challengeExpiresAt);
        if (held) {
          humanPrompt(vouchInstructions(member, held, confirmedBy));
          announced = true;
        }
      }
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
          announced
            ? 'no admin vouched before the request expired; nothing was enrolled — run `musterd authority enroll` again'
            : 'no passkey was enrolled before the challenge expired',
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
    const vouchKey = act === 'device_key_admin' ? vouchPayloadKey(payload, target) : null;
    if (vouchKey) {
      // ADR 769: a vouch. The code the member reads you is the identity check, so it comes first
      // and nothing is signed without it; then the daemon re-checks everything and enrolls.
      const typed = flagStr(parsed.flags, 'code') ?? (await askCode(target));
      if (!typed) {
        throw new CliError(
          `a vouch needs the 6-digit code ${target} reads you: pass --code <digits> (ADR 769)`,
          2,
        );
      }
      if (typed.replace(/\s/g, '') !== vouchCheckCode(vouchKey)) {
        throw new CliError(
          `that is not the code on ${target}'s screen — check you are talking to them; nothing was signed`,
          1,
        );
      }
      const proof = await collectApproval(http, team, act, target, payload);
      const vouched = await http.vouchPasskey(team, {
        member: target,
        enrollment_digest: vouchKey,
        approval: proof,
      });
      if (json) return printJson(vouched);
      process.stdout.write(
        success(`vouched — ${target}'s passkey is enrolled (${vouched.key.id})`, {
          next: `${target}'s terminal or /live shows it now`,
        }) + '\n',
      );
      return 0;
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

  if (sub === 'recover') {
    // ADR 808 inc D: the hub's operator mints a one-time passkey recovery code for a member none
    // of whose keys sign anywhere this hub serves. The daemon takes it only from this machine's
    // loopback and only on the hub, refuses while any usable key stands, and tells the team.
    const who = parsed.positionals[1];
    if (!who) throw new CliError(USAGE, 2);
    const { team, http } = resolveRead(parsed.flags, { claimSeatPerRequest: true });
    // The daemon's recovery secret (0600 beside its store) is the proof this is the daemon's own
    // OS user, not merely a local process — on a hub that also runs agent seats, loopback is not
    // enough. The daemon writes the file on the first ask; a second ask then carries it.
    const secretPath = machineStatePath('MUSTERD_RECOVERY_SECRET', 'recovery.secret');
    let operatorSecret: string | undefined;
    try {
      operatorSecret = readFileSync(secretPath, 'utf8').trim();
    } catch {
      operatorSecret = undefined;
    }
    const mint = (secret: string | undefined) =>
      http.issueRecoveryCode(team, {
        ...(secret ? { operator_secret: secret } : {}),
        member: who,
        issued_by: userInfo().username,
      });
    let minted: Awaited<ReturnType<typeof mint>>;
    try {
      minted = await mint(operatorSecret);
    } catch (e) {
      // First use on this hub: the daemon has just written the secret file. Read it and ask once
      // more; if it is still unreadable, this is not the daemon's user, and the refusal stands.
      if (
        operatorSecret !== undefined ||
        !(e instanceof CliError) ||
        !/recovery secret/.test(e.message)
      )
        throw e;
      let second: string;
      try {
        second = readFileSync(secretPath, 'utf8').trim();
      } catch {
        throw e;
      }
      minted = await mint(second);
    }
    if (json) return printJson(minted);
    const where = minted.redeem_at
      ? `${minted.redeem_at}/live?team=${encodeURIComponent(team)}`
      : '/live';
    process.stdout.write(
      success(`recovery code for ${who} — it expires in 5 minutes and works once`, {
        next: `${who} opens ${where} → Settings → Your passkeys → "I have a recovery code", pastes it, and enrolls a passkey there`,
      }) +
        '\n' +
        `  ${minted.code}\n` +
        `  ${theme.meta('The team was told a recovery code was minted; the audit row records the daemon secret as the proof and your OS user as a claim.')}\n`,
    );
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
