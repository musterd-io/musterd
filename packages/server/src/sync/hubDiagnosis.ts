import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Why a joiner could not reach its hub (lane 01M5N3SMBM, ADR 598 note of 2026-10-23).
 *
 * The fetch error used to be kept only as `String(err)`, which drops the errno, so every failure
 * read as "did not answer in time" or "could not be reached". On 2026-10-23 a laptop with Tailscale
 * stopped failed every claim and submit that way: the hub's 100.x address is only routable over
 * the tailnet, and nothing said so. This keeps the code, sorts it into a kind, and — only after a
 * failure, never on the success path — asks this machine's Tailscale whether it is running when
 * the hub's address is a tailnet one.
 */

export type HubFailureKind = 'timeout' | 'refused' | 'unroutable' | 'dns' | 'other';

/** This machine's Tailscale, as far as the hub failure needs it. */
export type TailscaleState = 'running' | 'stopped' | 'absent' | 'unknown';

export interface HubDiagnosis {
  kind: HubFailureKind;
  /** The errno (`ECONNREFUSED`, `EHOSTUNREACH`, …) or `TimeoutError`; null when none was carried. */
  code: string | null;
  /** Only read when the hub's address is a tailnet one; null otherwise. */
  tailscale: TailscaleState | null;
}

/** The hub could not be asked. Distinct from a refusal by construction, never folded into one. */
export class HubUnreachableError extends Error {
  constructor(
    hubUrl: string,
    cause: string,
    readonly diagnosis?: HubDiagnosis,
  ) {
    // ADR 598: the sentence carries what ADR 355's refusal left the caller to guess — nothing was
    // recorded here, what still works offline, and (on a timeout only) that the hub may have heard.
    const kind = diagnosis?.kind ?? (/timeout/i.test(cause) ? 'timeout' : 'other');
    const tailnetDown = diagnosis?.tailscale === 'stopped' || diagnosis?.tailscale === 'absent';
    super(
      `the hub at ${hubUrl} ${kind === 'timeout' ? 'did not answer in time' : 'could not be reached'} (${cause}), ` +
        `so nothing was recorded here: claim, handoff, release, submit and close wait for the hub. ` +
        `Messages, inbox, opening and editing lanes, and memory keep working and sync when it returns.` +
        causeSentence(diagnosis) +
        // With the tailnet down the request never left this machine, so the hub cannot have heard it.
        (kind === 'timeout' && !tailnetDown
          ? ` The hub may have received this before the timeout — read the board before retrying.`
          : ``),
    );
    this.name = 'HubUnreachableError';
  }
}

function causeSentence(d: HubDiagnosis | undefined): string {
  if (!d) return '';
  if (d.tailscale === 'stopped') {
    return (
      ` Tailscale is stopped on this machine, and the hub's address is a Tailscale one, so it ` +
      `cannot be reached from here. Start Tailscale (\`tailscale up\`, or the menu-bar app) and retry.`
    );
  }
  if (d.tailscale === 'absent') {
    return (
      ` The hub's address is a Tailscale one, and no \`tailscale\` command was found on this ` +
      `machine. Install or start Tailscale here, then retry.`
    );
  }
  if (d.kind === 'unroutable') {
    return ` This machine has no route to the hub (${d.code}): check the network or VPN that reaches it.`;
  }
  if (d.kind === 'dns') {
    return ` The hub's name did not resolve (${d.code}): check the hub URL and this machine's DNS.`;
  }
  if (d.kind === 'refused') {
    return ` The hub's machine answered but nothing accepted the connection (${d.code}): is its daemon running?`;
  }
  return '';
}

/** The errno a fetch failure carries, walking `cause` (undici puts it one level down). */
export function failureCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof o.code === 'string' && o.code) return o.code;
    if (o.name === 'TimeoutError') return 'TimeoutError';
    cur = o.cause;
  }
  return null;
}

export function classifyFailure(code: string | null, text: string): HubFailureKind {
  if (code === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'refused';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN')
    return 'unroutable';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  return /timeout/i.test(text) ? 'timeout' : 'other';
}

/** A hub reached over a tailnet: a CGNAT 100.64/10 address (RFC 6598) or a MagicDNS `*.ts.net` name. */
export function isTailnetHost(hubUrl: string): boolean {
  let host: string;
  try {
    host = new URL(hubUrl).hostname;
  } catch {
    return false;
  }
  if (/\.ts\.net$/i.test(host)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Where a `tailscale` command may live. A daemon under launchd has a short PATH, and the macOS app
 * keeps its CLI inside the bundle.
 */
export const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

const TAILSCALE_TIMEOUT_MS = 3_000;
/** One failed submit after another must not shell out each time. */
export const TAILSCALE_CACHE_MS = 30_000;

export type RunTailscale = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; failed: boolean; text: string }>;

const execFileAsync = promisify(execFile);

const runTailscale: RunTailscale = async (bin, args) => {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    return { stdout, failed: false, text: stdout };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') throw err;
    // `tailscale status` exits non-zero when stopped; its stdout/stderr still say so.
    return {
      stdout: e.stdout ?? '',
      failed: true,
      text: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`,
    };
  }
};

/** Read `BackendState` without the integration schema, which requires a `Self` a stopped node may lack. */
export function parseTailscaleState(out: {
  stdout: string;
  failed: boolean;
  text: string;
}): TailscaleState {
  try {
    const parsed = JSON.parse(out.stdout) as { BackendState?: unknown };
    if (typeof parsed.BackendState === 'string') {
      return parsed.BackendState === 'Running' ? 'running' : 'stopped';
    }
  } catch {
    // not JSON: fall through to the text
  }
  if (/stopped|not running|NeedsLogin|logged out/i.test(out.text)) return 'stopped';
  return 'unknown';
}

let cached: { at: number; state: TailscaleState } | null = null;

/** This machine's Tailscale state, cached for `TAILSCALE_CACHE_MS`. */
export async function tailscaleState(
  run: RunTailscale = runTailscale,
  now: () => number = Date.now,
): Promise<TailscaleState> {
  if (cached && now() - cached.at < TAILSCALE_CACHE_MS) return cached.state;
  let state: TailscaleState = 'absent';
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      state = parseTailscaleState(await run(bin, ['status', '--json']));
      break;
    } catch {
      // ENOENT: try the next place it may live
    }
  }
  cached = { at: now(), state };
  return state;
}

/** Test seam: forget the cached state. */
export function resetTailscaleCache(): void {
  cached = null;
}

/** Diagnose one failed hub call and build the error that names its cause. Only runs on failure. */
export async function diagnoseHubFailure(
  hubUrl: string,
  err: unknown,
  run?: RunTailscale,
): Promise<HubUnreachableError> {
  const text = String(err);
  const code = failureCode(err);
  const kind = classifyFailure(code, text);
  let tailscale: TailscaleState | null = null;
  if (isTailnetHost(hubUrl)) {
    try {
      tailscale = await tailscaleState(run);
    } catch {
      tailscale = 'unknown';
    }
  }
  return new HubUnreachableError(hubUrl, text, { kind, code, tailscale });
}
