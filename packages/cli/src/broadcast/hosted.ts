/**
 * Hosted broadcast — the preconditions, and how to see them.
 *
 * Going live from a rented machine spans three systems that know nothing about each other: a
 * Tailscale overlay, this machine's daemon, and a Fly app. Every one of them fails *silently from
 * the operator's side* — the symptom is always the same "the broadcast page never reported ready",
 * which points nowhere near the cause. Four launches were burned that way on 2026-07-27.
 *
 * So the checks here are deliberately **empirical, not declarative**: each one performs the exact
 * operation the stream will perform and reports what came back. Notably the allow-list check does a
 * real WebSocket upgrade against the running daemon with the tailnet `Host` header rather than
 * reading `MUSTERD_ALLOWED_HOSTS` out of the LaunchAgent plist — the plist is what someone *wrote*,
 * the upgrade is what the daemon currently *does*, and on 2026-07-27 those disagreed for two minutes
 * because a `launchctl bootstrap` silently didn't take.
 *
 * Everything is injected (`Exec`, `probeUpgrade`) so the whole ladder is unit-testable without a
 * tailnet, a daemon, or a Fly account.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from '../errors.js';
import {
  type TailnetSelf,
  type UpgradeVerdict,
  parseTailscaleSelf,
  serveForwardsPort,
} from '../integrations/tailscale.js';
import type { Exec } from '../process.js';
import { TITLE_SECRET_NAMES } from './channelTitle.js';

/** The Fly app that hosts the stream. Overridable for a second environment. */
export const DEFAULT_APP = 'musterd-broadcast';
/**
 * The secrets the container needs before a stream can start. Values never pass through musterd —
 * only presence is checked. The Twitch title token is not in this list (ADR 711): missing it turns
 * the title off, and a missing optional secret must not fail doctor.
 */
export const REQUIRED_SECRETS = ['TS_AUTHKEY', 'MUSTERD_STREAM_KEY'] as const;
/** The proven configuration (see the hosting spec + the 2026-07-27 run that passed). */
export const VM_SIZE = 'performance-4x';
export const REGION = 'sjc';

/**
 * The capture hostname every hosted run registers under. One name, deliberately: the machine is
 * ephemeral, and so is the tailnet node it brings up with it.
 */
export const CAPTURE_HOSTNAME = 'musterd-broadcast';

/**
 * How many OFFLINE capture nodes can be on the tailnet before it means something is wrong.
 *
 * Two, and the number is a statement about mechanism, not a tolerance. The entrypoint runs
 * `tailscaled --state=/tmp/...` on purpose — `/tmp` does not survive a Fly machine, so every run
 * registers a genuinely new node, and Tailscale will not reissue a hostname that is still taken:
 * it appends `-1`, `-2`. That is CORRECT, and paired with an ephemeral auth key it self-cleans,
 * because the coordination server drops an ephemeral node a while after it goes offline. So a
 * couple of dead `musterd-broadcast-N` rows during a restart is what health looks like.
 *
 * The failure this catches is the one that looks identical from the outside: if the auth key is
 * NOT ephemeral, nothing is ever reaped, every run leaks a row forever, and the only symptom is
 * the same suffixed names. Nobody would notice, because the healthy state and the leaking state
 * are the same picture — which is exactly why it needs a number to cross rather than an eye to
 * catch it. Above two, ephemeral reap cannot be the explanation.
 */
export const STALE_CAPTURE_LIMIT = 2;

export interface CaptureNodes {
  /** Every `musterd-broadcast*` peer on the tailnet, newest suffix last. */
  names: string[];
  /** Those of them currently offline — the ones a reap should be removing. */
  offline: string[];
}

/**
 * The capture nodes registered on this tailnet, from the same `tailscale status --json` the
 * tailnet check already ran. Peers only: this laptop is never the capture machine.
 */
export function parseCaptureNodes(json: string): CaptureNodes | null {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const peers = (doc as { Peer?: unknown }).Peer;
  if (typeof peers !== 'object' || peers === null) return null;
  const names: string[] = [];
  const offline: string[] = [];
  for (const value of Object.values(peers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const peer = value as { HostName?: unknown; Online?: unknown };
    const host = typeof peer.HostName === 'string' ? peer.HostName : '';
    // `musterd-broadcast` itself and its `-N` retries; never a `musterd-broadcaster` someone else
    // named a box, which is why this is an exact-or-suffix test and not a prefix test.
    if (host !== CAPTURE_HOSTNAME && !new RegExp(`^${CAPTURE_HOSTNAME}-\\d+$`).test(host)) continue;
    names.push(host);
    if (peer.Online !== true) offline.push(host);
  }
  names.sort();
  offline.sort();
  return { names, offline };
}

export interface SecretRow {
  name: string;
  /** A short hash of the value. Safe to print — it proves the secret is set without revealing it. */
  digest: string | null;
}

/**
 * `fly secrets list --json` → what is set. **Never values**: flyctl does not return them and musterd
 * would not print them if it did; the digest is the evidence.
 *
 * Both key casings are accepted because flyctl changed them (`Name`/`Digest` → `name`/`digest`), and
 * this parser reading only the old one is what made a green system report "none set" on first run.
 */
export function parseSecrets(json: string): SecretRow[] {
  try {
    const doc: unknown = JSON.parse(json);
    if (!Array.isArray(doc)) return [];
    return doc
      .map((s) => {
        const r = s as { name?: unknown; Name?: unknown; digest?: unknown; Digest?: unknown };
        const name =
          typeof r.name === 'string' ? r.name : typeof r.Name === 'string' ? r.Name : null;
        const digest =
          typeof r.digest === 'string' ? r.digest : typeof r.Digest === 'string' ? r.Digest : null;
        return name ? { name, digest } : null;
      })
      .filter((r): r is SecretRow => r !== null);
  } catch {
    return [];
  }
}

/**
 * `fly machine list --json` → ids of machines actually running (a stream is at most one).
 *
 * Both key casings, for the same reason as `parseSecrets`: flyctl's JSON casing is not a contract,
 * and here a false empty would let `start` boot a second machine beside a live stream — two
 * encoders on one Twitch key, and double billing.
 */
export function startedMachines(json: string): string[] {
  return machineIds(json, (state) => state === 'started');
}

/** The shared parse behind both machine queries — one place for flyctl's casing, one for its
 * shape. A parse failure is an empty list, and every caller treats that as "cannot tell", which is
 * why neither query is allowed to be the only thing standing between a start and a second machine. */
function machineIds(json: string, keep: (state: string) => boolean): string[] {
  try {
    const doc: unknown = JSON.parse(json);
    if (!Array.isArray(doc)) return [];
    return doc
      .map((m) => m as { id?: unknown; ID?: unknown; state?: unknown; State?: unknown })
      .filter((m) => {
        const state = m.state ?? m.State;
        return typeof state === 'string' && keep(state);
      })
      .map((m) => (typeof m.id === 'string' ? m.id : typeof m.ID === 'string' ? m.ID : null))
      .filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * Fly states that mean a machine is HOLDING this app's one slot — booting included.
 *
 * `started` answers "is it running", which is the right question for status and the wrong one for
 * "may I launch". A machine reports `created`, then `starting`, for the whole boot: 29.0s on the
 * 2026-09-03 run, 26.5s of it pulling the 593 MB image. Ask the running question during that window
 * and the answer is a false empty — which is exactly the failure `startedMachines` warns about one
 * doc comment above, arriving through the door it left open.
 */
const OCCUPYING = new Set(['created', 'starting', 'started', 'replacing']);

/**
 * `fly machine list --json` → ids of machines occupying the app, whether or not they are up yet.
 *
 * Use this for every "is something already there" decision — the supervisor's crash predicate and
 * `start`'s own double-launch guard both are one. Two machines on one Twitch key means one of them
 * dies on `Input/output error` and the survivor is chosen by a race, while both bill as
 * performance-4x. Deliberately NOT the states that mean gone (`stopped`, `stopping`, `destroying`,
 * `destroyed`, `suspended`): a stream that really has ended must still be restartable.
 */
export function occupiedMachines(json: string): string[] {
  return machineIds(json, (state) => OCCUPYING.has(state));
}

/** When a machine in `fly machine list --json` was created (epoch ms), or null when the list does
 * not name it or carries no parseable `created_at`. The stall check's boot grace is measured from
 * here (ADR 737): a booting machine has written no progress line yet, and is not a stall. */
export function machineCreatedAt(json: string, id: string): number | null {
  try {
    const doc = JSON.parse(json) as unknown;
    if (!Array.isArray(doc)) return null;
    const m = doc.find((x) => (x as { id?: unknown })?.id === id) as
      | { created_at?: unknown }
      | undefined;
    const t = typeof m?.created_at === 'string' ? Date.parse(m.created_at) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** The newest ffmpeg progress line (`frame=… time=…`) in `fly logs --no-tail` output, as epoch ms
 * from Fly's line timestamp; null when the buffer holds none. ffmpeg writes one roughly every
 * second while it encodes and nothing while it is starved — the 2026-10-12 stall left its last
 * progress line at 19:30Z with the machine still `started` for three more hours (ADR 737). */
export function lastEncoderProgressAt(logs: string): number | null {
  let newest: number | null = null;
  for (const raw of logs.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (!/\bframe=\s*\d+/.test(line)) continue;
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/);
    const t = m ? Date.parse(m[1]!) : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * Pull the pushed digest out of `fly deploy --build-only` output.
 *
 * This is load-bearing, not cosmetic: a rebuilt `:capture` tag resolved to the *previous* digest and
 * two machines silently streamed month-old code while the fix sat in the registry. `start` runs the
 * recorded digest, which cannot be stale by construction.
 */
export function parsePushedDigest(out: string): string | null {
  const m = out.match(/capture@(sha256:[a-f0-9]{64})/g);
  if (!m || m.length === 0) return null;
  return m[m.length - 1]!.split('@')[1] ?? null;
}

/** The machine id `fly machine run` prints. Absent when the attempt never got that far. */
export function parseLaunchedMachine(output: string): string | null {
  const m = /Machine ID:\s*([0-9a-f]+)/i.exec(output);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * What Fly still knows after the guest is gone: the newest event line that carries an exit.
 *
 * `fly machine status` has no `--json`. Its human table prints newest first, and a destroy line
 * has no `exit_code`, so the first match is the death rather than the destroy that followed it
 * or the start that preceded it. Measured 2026-10-16 on machine 830722b7704158:
 * `exit_code=-1,oom_killed=false,requested_stop=false`.
 */
export interface FlyExit {
  code: number;
  oom: boolean;
  requestedStop: boolean;
}

const FLY_EXIT = /exit_code=(-?\d+),oom_killed=(true|false),requested_stop=(true|false)/;

export function parseFlyExit(statusText: string): FlyExit | null {
  const m = FLY_EXIT.exec(statusText);
  if (!m) return null;
  return { code: Number(m[1]), oom: m[2] === 'true', requestedStop: m[3] === 'true' };
}

/** One clause. Names the three fields Fly printed and nothing Fly did not say. */
export function formatFlyExit(exit: FlyExit): string {
  const oom = exit.oom ? 'oom' : 'not oom';
  const stop = exit.requestedStop ? 'a requested stop' : 'not a requested stop';
  return `exit ${exit.code}, ${oom}, ${stop}`;
}

// ── The daemon's upgrade gate, probed for real ───────────────────────────────────────────────────

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────

export interface Check {
  /** Stable id — what `--json` consumers and the fix-ladder key off. */
  key: string;
  label: string;
  state: 'ok' | 'fail' | 'skip';
  /** What was actually observed. */
  detail?: string;
  /** The exact thing to run or do. Present on every `fail`; that is the whole point of doctor. */
  fix?: string;
}

export interface DoctorCtx {
  exec: Exec;
  probeUpgrade: (hostHeader: string) => Promise<UpgradeVerdict>;
  app: string;
  /** The daemon's loopback port — where the upgrade probe is aimed. */
  port: number;
  /** The musterd checkout the image builds from, or null when running outside one. */
  repoRoot: string | null;
  /** The image the supervisor would launch, if any — machine record or legacy checkout file. */
  image: CaptureImage | null;
}

/**
 * Doctor row for the optional title token. A variable, not a string passed to `skip`: the flag
 * checker treats a call's first string as a flag name, and this is not a flag `stream` takes.
 */
const TITLE_CHECK_KEY = 'twitch-title';

const skip = (key: string, label: string, why: string): Check => ({
  key,
  label,
  state: 'skip',
  detail: why,
});

/**
 * Run every precondition in dependency order. A failure upstream turns its dependants into `skip`
 * rather than a cascade of red — an operator who hasn't installed Tailscale does not need to be told
 * four more times.
 */
export async function runChecks(ctx: DoctorCtx): Promise<Check[]> {
  const checks: Check[] = [];
  const { exec } = ctx;

  // 1 — tailscale present
  const tsVersion = exec('tailscale', ['version']);
  const haveTs = tsVersion.code === 0;
  checks.push({
    key: 'tailscale',
    label: 'tailscale installed',
    state: haveTs ? 'ok' : 'fail',
    ...(haveTs ? { detail: tsVersion.stdout.split('\n')[0]?.trim() ?? '' } : {}),
    ...(haveTs
      ? {}
      : { fix: 'install Tailscale from https://tailscale.com/download, then sign in' }),
  });

  // 2 — the overlay is up, and it tells us our own address
  let self: TailnetSelf | null = null;
  let capture: CaptureNodes | null = null;
  if (!haveTs) {
    checks.push(skip('tailnet', 'tailnet up', 'needs tailscale'));
  } else {
    const st = exec('tailscale', ['status', '--json']);
    self = st.code === 0 ? parseTailscaleSelf(st.stdout) : null;
    // Same payload, second reading — the capture-node census below costs no extra process.
    capture = st.code === 0 ? parseCaptureNodes(st.stdout) : null;
    const up = Boolean(self?.running && self.dnsName);
    checks.push({
      key: 'tailnet',
      label: 'tailnet up',
      state: up ? 'ok' : 'fail',
      ...(self?.dnsName ? { detail: `${self.dnsName}${self.ip4 ? ` · ${self.ip4}` : ''}` } : {}),
      ...(up ? {} : { fix: 'tailscale up' }),
    });
    if (!up) self = null;
  }

  // 2b — the capture nodes are being reaped
  //
  // Not a launch precondition: a pile of dead `musterd-broadcast-N` rows stops nothing from going
  // live. It is here because it is otherwise INVISIBLE — the only place it shows is the Tailscale
  // admin app, which is where nick found three of them on 2026-09-03 and had to ask why. A fact
  // about this system that can only be learned by opening someone else's dashboard is a fact this
  // command should be stating. See `STALE_CAPTURE_LIMIT` for why the number is the whole check:
  // healthy churn and a permanent leak produce the identical picture, and only the count separates
  // them.
  if (!capture) {
    checks.push(skip('capture-nodes', 'capture nodes reaped', 'needs the tailnet'));
  } else {
    const leaking = capture.offline.length > STALE_CAPTURE_LIMIT;
    checks.push({
      key: 'capture-nodes',
      label: 'capture nodes reaped',
      state: leaking ? 'fail' : 'ok',
      detail:
        capture.names.length === 0
          ? 'none registered'
          : `${capture.names.length} on the tailnet, ${capture.offline.length} offline` +
            (capture.offline.length > 0 ? ` (${capture.offline.join(', ')})` : ''),
      // Stated as the one cause the count actually rules in. Ephemeral nodes are dropped a while
      // after they go offline, so more than a couple of them sitting there is not slow cleanup —
      // it is no cleanup, which means the key they registered with is not an ephemeral one.
      ...(leaking
        ? {
            fix:
              `${capture.offline.length} dead capture nodes — more than reap can explain, so TS_AUTHKEY is not ephemeral.\n` +
              `Mint an ephemeral + reusable key at https://login.tailscale.com/admin/settings/keys, then:\n` +
              `fly secrets set TS_AUTHKEY=<new key> -a ${ctx.app}\n` +
              `and delete the stale ${CAPTURE_HOSTNAME}-* devices in the admin console`,
          }
        : {}),
    });
  }

  // 3 — the daemon is forwarded onto the tailnet
  if (!haveTs) {
    checks.push(skip('serve', `tailscale serve forwards ${ctx.port}`, 'needs tailscale'));
  } else {
    const sv = exec('tailscale', ['serve', 'status', '--json']);
    const forwarding = sv.code === 0 && serveForwardsPort(sv.stdout, ctx.port);
    checks.push({
      key: 'serve',
      label: `tailscale serve forwards ${ctx.port}`,
      state: forwarding ? 'ok' : 'fail',
      ...(forwarding ? { detail: `tcp/${ctx.port} → 127.0.0.1:${ctx.port}` } : {}),
      ...(forwarding
        ? {}
        : {
            fix: `tailscale serve --bg --tcp ${ctx.port} tcp://127.0.0.1:${ctx.port}`,
          }),
    });
  }

  // 4 — the daemon would accept the capture page's WS upgrade over the tailnet Host
  //
  // Both the name and the IP are checked because either can land in `Host` depending on how the
  // container resolved the daemon, and on 2026-07-27 the container resolved by IP (Fly owns
  // /etc/resolv.conf, so MagicDNS never installs). An allow-list with only the name still fails.
  if (!self) {
    checks.push(
      skip('allowed-host', 'daemon allows the tailnet Host', 'needs the tailnet address'),
    );
  } else {
    const hosts = [self.dnsName, ...(self.ip4 ? [self.ip4] : [])];
    const verdicts = await Promise.all(hosts.map((h) => ctx.probeUpgrade(h)));
    const unreachable = verdicts.includes('unreachable');
    const rejected = hosts.filter((_, i) => verdicts[i] === 'rejected');
    const state = unreachable || rejected.length > 0 ? 'fail' : 'ok';
    checks.push({
      key: 'allowed-host',
      label: 'daemon allows the tailnet Host',
      state,
      detail: unreachable
        ? `no answer on 127.0.0.1:${ctx.port}`
        : rejected.length > 0
          ? `403 for ${rejected.join(', ')} (ws_upgrade_rejected: host not allowed)`
          : `${hosts.join(', ')} accepted`,
      // Phrased as an observation, not a diagnosis. All this check saw is that no answer came back,
      // and "the daemon is down" and "this CLI cannot see it" are different conditions that look
      // identical from here — the distinction stanley's ADR 040 service work turned on (#422: only
      // was-up-then-not is an outage, so his bounce takes a baseline probe first). The probe aims at
      // loopback today, where down is nearly always the right reading; the moment doctor is pointed
      // at a daemon across the overlay it would not be, and a check that states a cause it did not
      // observe is the exact failure this command exists to end. Whoever adds that capability wants
      // his baseline, not this sentence.
      ...(unreachable
        ? {
            fix: `no answer from the daemon — it may be down, or unreachable from here. Check with \`musterd service status\`, then \`musterd service start\``,
          }
        : rejected.length > 0
          ? {
              fix:
                `musterd service install --allowed-hosts ${hosts.join(',')}\n` +
                `      (restarts the daemon and verifies /health; the old way was hand-editing the LaunchAgent plist)`,
            }
          : {}),
    });
  }

  // 5 — flyctl present
  const flyVersion = exec('fly', ['version']);
  const haveFly = flyVersion.code === 0;
  checks.push({
    key: 'fly',
    label: 'flyctl installed',
    state: haveFly ? 'ok' : 'fail',
    // `fly version` prints version, platform, commit SHA and build date on one line; only the first
    // two are worth a check line.
    ...(haveFly ? { detail: flyVersion.stdout.split(/\s+Commit:/)[0]?.trim() ?? '' } : {}),
    ...(haveFly ? {} : { fix: 'brew install flyctl   (or https://fly.io/docs/flyctl/install/)' }),
  });

  // 6 — authenticated
  let authed = false;
  if (!haveFly) {
    checks.push(skip('fly-auth', 'flyctl authenticated', 'needs flyctl'));
  } else {
    const who = exec('fly', ['auth', 'whoami']);
    authed = who.code === 0;
    checks.push({
      key: 'fly-auth',
      label: 'flyctl authenticated',
      state: authed ? 'ok' : 'fail',
      ...(authed ? { detail: who.stdout.trim() } : {}),
      ...(authed ? {} : { fix: 'fly auth login' }),
    });
  }

  // 7 — the app exists
  let appExists = false;
  if (!authed) {
    checks.push(skip('app', `app ${ctx.app} exists`, 'needs an authenticated flyctl'));
  } else {
    const st = exec('fly', ['status', '-a', ctx.app, '--json']);
    appExists = st.code === 0;
    checks.push({
      key: 'app',
      label: `app ${ctx.app} exists`,
      state: appExists ? 'ok' : 'fail',
      ...(appExists ? {} : { fix: `fly apps create ${ctx.app} --org personal` }),
    });
  }

  // 8 — both secrets staged
  //
  // Presence only. musterd never reads, prints, or accepts these values: the operator sets them
  // directly so a stream key never passes through an agent, a script argument, or the repo.
  //
  // 8b — the optional title token (ADR 711). A skip, never a fail: the stream still starts, and
  // the repair has to live in `detail` because skip rows are not copied into the fail-fix block.
  // `fly secrets list` cannot show expiry; a rejected token is the apply line in the machine log.
  let secretRows: SecretRow[] = [];
  if (!appExists) {
    checks.push(skip('secrets', 'stream + tailnet secrets set', 'needs the app'));
    checks.push(skip(TITLE_CHECK_KEY, 'twitch title token set', 'needs the app'));
  } else {
    const sec = exec('fly', ['secrets', 'list', '-a', ctx.app, '--json']);
    secretRows = sec.code === 0 ? parseSecrets(sec.stdout) : [];
    const missing = REQUIRED_SECRETS.filter((s) => !secretRows.some((r) => r.name === s));
    checks.push({
      key: 'secrets',
      label: 'stream + tailnet secrets set',
      state: missing.length === 0 ? 'ok' : 'fail',
      detail:
        secretRows.length > 0
          ? secretRows.map((r) => `${r.name} ${r.digest?.slice(0, 8) ?? '?'}`).join(' · ')
          : 'none set',
      ...(missing.length === 0
        ? {}
        : {
            fix:
              `fly secrets set -a ${ctx.app} --stage ` +
              missing.map((s) => `${s}=<${secretHint(s)}>`).join(' '),
          }),
    });
    const titleMissing = TITLE_SECRET_NAMES.filter((s) => !secretRows.some((r) => r.name === s));
    checks.push(
      titleMissing.length === 0
        ? {
            key: TITLE_CHECK_KEY,
            label: 'twitch title token set',
            state: 'ok',
            detail: 'a rejected token is named in the machine log when the stream starts',
          }
        : {
            key: TITLE_CHECK_KEY,
            label: 'twitch title token set',
            state: 'skip',
            detail:
              `optional — the stream still starts and the title is left alone. ` +
              `fly secrets set -a ${ctx.app} --stage ` +
              'MUSTERD_TWITCH_CLIENT_ID=<app client id> ' +
              'MUSTERD_TWITCH_TOKEN=<user token, channel:manage:broadcast>',
          },
    );
  }

  // 9 — an image has been built and its digest recorded
  if (!ctx.repoRoot) {
    checks.push(skip('image', 'capture image built', 'not inside a musterd checkout'));
  } else {
    const built = Boolean(ctx.image);
    // An image is only as good as the capture code in it (2026-10-15: one built before ADR 594 read
    // green here and every start crash-looped), so a machine record is also compared with main.
    const stale =
      built && ctx.image!.source === 'machine'
        ? imageStaleness(exec, ctx.repoRoot, ctx.image!)
        : null;
    const fresh = built && (!stale || stale.kind === 'current');
    checks.push({
      key: 'image',
      label: 'capture image built',
      state: fresh ? 'ok' : 'fail',
      // Say WHERE it came from. A doctor that reports a digest without saying whether the machine
      // or merely this worktree holds it is the false green this record exists to remove.
      ...(built
        ? {
            detail:
              ctx.image!.source === 'machine'
                ? `${ctx.image!.digest.slice(0, 19)} · recorded for this machine · ${describeStaleness(stale!)}`
                : `${ctx.image!.digest.slice(0, 19)} · from this checkout only — run \`musterd stream build\` to record it for the machine`,
          }
        : {}),
      ...(fresh ? {} : { fix: 'musterd stream build' }),
    });
  }

  return checks;
}

function secretHint(name: string): string {
  return name === 'TS_AUTHKEY' ? 'ephemeral+reusable tailnet auth key' : 'twitch stream key';
}

// ── Checkout + digest bookkeeping ────────────────────────────────────────────────────────────────

/** Walk up from `from` for the checkout that carries the hosted build files. */
export function findRepoRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'scripts', 'broadcast', 'hosted.Dockerfile'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** What `stream build` uploads: a directory, the commit it holds, and how to tidy it away. */
export interface BuildSource {
  dir: string;
  commit: string | null;
  /** One line for the operator: which code this image is about to carry. */
  label: string;
  cleanup: () => void;
}

/**
 * Where `stream build` uploads from. By default a clean export of a freshly fetched `origin/main`,
 * never the caller's folder: on 2026-10-17 a human's folder sat at 71f1759 and its build came back
 * fully cached, three capture fixes short of main. The folder itself is not switched, because a
 * human's folder can hold uncommitted work or a branch. The export carries tracked files only, so a
 * stray local edit cannot reach a published image either. `here` builds the checkout as it stands.
 */
export function prepareBuildSource(a: {
  exec: Exec;
  root: string;
  here: boolean;
  mkTemp?: () => string;
  rm?: (dir: string) => void;
}): BuildSource {
  if (a.here) {
    const head = a.exec('git', ['-C', a.root, 'rev-parse', 'HEAD']);
    const dirty = a.exec('git', ['-C', a.root, 'status', '--porcelain']);
    const commit = head.code === 0 ? head.stdout.trim() : null;
    const edits = dirty.code === 0 && dirty.stdout.trim() !== '' ? ' plus uncommitted edits' : '';
    return {
      dir: a.root,
      commit,
      label: `this folder (--here): ${commit ? commit.slice(0, 7) : 'unknown commit'}${edits}`,
      cleanup: () => {},
    };
  }
  const fetch = a.exec('git', ['-C', a.root, 'fetch', 'origin', 'main']);
  if (fetch.code !== 0) {
    throw new CliError(
      `could not fetch origin/main: ${fetch.stderr.trim() || 'git fetch failed'} ` +
        '(build this folder as it stands with --here)',
      1,
    );
  }
  const tip = a.exec('git', ['-C', a.root, 'rev-parse', 'origin/main']);
  if (tip.code !== 0) throw new CliError('could not resolve origin/main after fetching it', 1);
  const commit = tip.stdout.trim();
  const tmp = (a.mkTemp ?? (() => mkdtempSync(join(tmpdir(), 'musterd-stream-build-'))))();
  const rm = a.rm ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const dir = join(tmp, 'src');
  const tar = join(tmp, 'src.tar');
  const steps: Array<[string, string[]]> = [
    ['git', ['-C', a.root, 'archive', '--format=tar', '-o', tar, commit]],
    ['mkdir', ['-p', dir]],
    ['tar', ['-xf', tar, '-C', dir]],
  ];
  for (const [cmd, args] of steps) {
    const r = a.exec(cmd, args);
    if (r.code !== 0) {
      rm(tmp);
      throw new CliError(`could not export origin/main to build: ${r.stderr.trim()}`, 1);
    }
  }
  return {
    dir,
    commit,
    label: `origin/main at ${commit.slice(0, 7)} (a clean export; this folder is untouched)`,
    cleanup: () => rm(tmp),
  };
}

export function digestPath(repoRoot: string): string {
  return join(repoRoot, 'scripts', 'broadcast', '.image-digest');
}

// ── The capture image record: one per MACHINE ────────────────────────────────────────────────────

/** Where the digest lives now: beside `state.json`, not inside a checkout.
 *
 * The per-checkout `.image-digest` is gitignored, so every worktree had its own and they drifted —
 * and streamwatch's LaunchAgent always resolves the MAIN checkout, so the supervisor read a file
 * the stream had never written (2026-09-17: main held a digest 14 days older than the live
 * machine's). A stream is a property of the MACHINE, and so is the image it runs. */
export interface CaptureImage {
  digest: string;
  /** When it was recorded. Only the legacy `checkout` source needs this — see `decideEnsure`. */
  at: number;
  /** `machine` is the authoritative record; `checkout` is the migration fallback. */
  source: 'machine' | 'checkout';
  /** Which checkout ran the build. Provenance for `doctor`, never used to decide anything. */
  repo?: string;
  /** The commit the build ran at — what `doctor` compares with main. Absent on older records. */
  commit?: string;
}

/** What the capture box actually runs from the image: the broadcast CLI, the code it shares, and
 * the image's own scripts. A commit elsewhere in the repo does not make an image stale. */
export const CAPTURE_PATHS = [
  'packages/cli/src/commands/broadcast.ts',
  'packages/cli/src/broadcast/',
  'packages/protocol/src/',
  'scripts/broadcast/',
] as const;

export type ImageStaleness =
  | { kind: 'current'; commit: string }
  | { kind: 'behind'; commit: string; commits: string[] }
  | { kind: 'no-commit' }
  | { kind: 'unknown'; commit: string };

/** Is the recorded image behind `origin/main` (as this checkout last fetched it) on the capture
 * paths? Answers `unknown` rather than `current` when git cannot say — a blind pass is the bug. */
export function imageStaleness(
  exec: Exec,
  repoRoot: string | null,
  image: CaptureImage,
): ImageStaleness {
  if (!image.commit) return { kind: 'no-commit' };
  if (!repoRoot) return { kind: 'unknown', commit: image.commit };
  const log = exec('git', [
    '-C',
    repoRoot,
    'log',
    '--format=%h %s',
    `${image.commit}..origin/main`,
    '--',
    ...CAPTURE_PATHS,
  ]);
  if (log.code !== 0) return { kind: 'unknown', commit: image.commit };
  const commits = log.stdout.split('\n').filter((l) => l.trim() !== '');
  return commits.length === 0
    ? { kind: 'current', commit: image.commit }
    : { kind: 'behind', commit: image.commit, commits };
}

export function describeStaleness(s: ImageStaleness): string {
  switch (s.kind) {
    case 'current':
      return `built at ${s.commit.slice(0, 7)}, current with origin/main`;
    case 'behind': {
      const n = s.commits.length;
      return `built at ${s.commit.slice(0, 7)}, ${n} capture commit${n === 1 ? '' : 's'} behind origin/main (newest: ${s.commits[0]})`;
    }
    case 'no-commit':
      return 'built before images recorded their commit, so its age is unknown';
    case 'unknown':
      return `built at ${s.commit.slice(0, 7)}, but git cannot compare it with origin/main here (git fetch origin main?)`;
  }
}

export function captureImagePath(statePath: string): string {
  return join(dirname(statePath), 'image.json');
}

/** Record what `stream build` just pushed, wherever it was run from. */
export function writeCaptureImage(a: {
  statePath: string;
  digest: string;
  repoRoot: string | null;
  now: number;
  commit?: string;
}): void {
  const path = captureImagePath(a.statePath);
  mkdirSync(dirname(path), { recursive: true });
  const body = {
    digest: a.digest,
    at: a.now,
    ...(a.repoRoot ? { repo: a.repoRoot } : {}),
    ...(a.commit ? { commit: a.commit } : {}),
  };
  // tmp + rename: the supervisor reads this on its own 60s clock, and a half-written record read
  // mid-build is a digest that resolves to nothing.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  renameSync(tmp, path);
}

/** The image the supervisor would launch. Machine record first; this checkout's legacy file only
 * when there is no machine record, so an existing laptop keeps working until its next build. */
export function readCaptureImage(a: {
  statePath: string;
  repoRoot: string | null;
}): CaptureImage | null {
  try {
    const raw = JSON.parse(readFileSync(captureImagePath(a.statePath), 'utf8')) as {
      digest?: unknown;
      at?: unknown;
      repo?: unknown;
      commit?: unknown;
    };
    // A tag can resolve to a stale image and a digest cannot — the same refusal `build` makes.
    if (typeof raw.digest === 'string' && raw.digest.startsWith('sha256:')) {
      return {
        digest: raw.digest,
        at: typeof raw.at === 'number' ? raw.at : 0,
        source: 'machine',
        ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {}),
        ...(typeof raw.commit === 'string' ? { commit: raw.commit } : {}),
      };
    }
    return null; // present and unusable is not a reason to fall back to a checkout's guess
  } catch {
    // Missing or unparseable — fall through to the legacy path.
  }
  const legacy = readDigestRecord(a.repoRoot);
  return legacy ? { digest: legacy.digest, at: legacy.at, source: 'checkout' } : null;
}

export function readDigest(repoRoot: string | null): string | null {
  return readDigestRecord(repoRoot)?.digest ?? null;
}

/** The digest AND when it was written. The supervisor needs the timestamp to tell a rebuild from
 * another checkout's file: `.image-digest` is gitignored and per-checkout, so "it differs" alone
 * stopped being evidence of a deploy once worktrees existed (see `decideEnsure`). */
export function readDigestRecord(repoRoot: string | null): { digest: string; at: number } | null {
  if (!repoRoot) return null;
  try {
    const path = digestPath(repoRoot);
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw.startsWith('sha256:')) return null;
    return { digest: raw, at: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}
