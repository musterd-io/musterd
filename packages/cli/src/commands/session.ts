import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bindingSeat,
  resolveAttestedWakeLease,
  type Binding,
  type SessionCapture,
} from '@musterd/protocol';
import { resolveWorkspaceKey } from '@musterd/protocol/project';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, requireUsableBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { dischargedIds, openActionNeeded } from '../render/rows.js';
import { clock, theme } from '../render/theme.js';
import { bindThread, pruneOnDisk, readRegistry } from '../session/continuity.js';
import { sessionDigest } from '../session/digest.js';
import { enumerateClaudeSessions } from '../session/enumerate.js';
import {
  LOCAL_SESSION_LIVE_MS,
  localSessionLiveness,
  type LocalSessionLiveness,
} from '../session/liveness.js';
import { tapHook } from '../trace/hook.js';
import { tailTranscript, transcriptPathFor } from '../trace/tail.js';
import { attestedModel, findWorkspaceDir, resolveClaimWorkspace } from './helpers.js';
import { composeSessionOrientation, type SessionOrientationInput } from './sessionOrientation.js';
import { runSessionStartProbe, type SessionStartProbe } from './sessionProbe.js';
import { composeSessionStatusline, type SessionStatuslineInput } from './sessionStatusline.js';

/**
 * `musterd session start|end --stdin | show` (ADR 131 §5, increment 4) — session capture. The
 * SessionStart/SessionEnd hooks pipe the harness's hook JSON (`{session_id, transcript_path, cwd}`)
 * into `start`/`end`, which write `binding.session` — the workspace-local capture the wake path
 * upgrades from fresh to `--resume`. Contract, enforced here:
 *
 * - **Local-only secrets.** The session id and transcript path land ONLY in the gitignored 0600
 *   `binding.json`. The daemon push (best-effort, after the local write) carries harness CLASS +
 *   event + a keyed one-way digest of the id — the wire schema still has no field for an id or a
 *   path. The digest is correlation, not disclosure: see `../session/digest.ts`.
 * - **Presence-neutral, never claiming.** The push rides `presenceNeutral()` (ADR 057) and hits a
 *   route that touches no presence row and no claim (ADR 108) — a hook must never flip the roster
 *   or displace the live occupant.
 * - **A hook must never fail.** Missing stdin, no session_id, no binding, unreachable daemon — all
 *   exit 0 silently. The hook one-liner also `|| true`s, but capture being belt-and-braces about
 *   it keeps a broken capture from ever bleeding into a harness session.
 * - **Anchored writes.** The workspace root is resolved from the hook's stdin `cwd` (walking up to
 *   the `.musterd/binding.json` holder), never bare `process.cwd()` — the ambient-cwd clobber
 *   (ADR 018) is exactly a hook-shaped process writing a sibling worktree's binding.
 *
 * `show` is the human/triage half: what is captured here, is it live, would a wake resume it.
 */
export interface SessionCommandDeps {
  probe?: SessionStartProbe;
  /** Test seam: the capture hook's whole-command budget (default {@link SESSION_CAPTURE_BUDGET_MS}). */
  budgetMs?: number;
  /** Test seam: the hook payload source (default: drain the real stdin). */
  stdin?: () => Promise<string>;
}

/**
 * The hard bound on `session start|end --stdin` as a whole (lane 01M3ABD9DM).
 *
 * `HttpClient` carries no AbortSignal, and the start path makes several network calls in sequence:
 * the self-heal probe's repair post, the never-evict roster read, the lease claim, the attestation,
 * the orientation's GETs. A daemon that accepts the socket and never answers (wedged, or a host
 * that slept mid-request) held each of them until undici's 300 s header timeout, and two of those
 * fill Claude Code's 600 s hook budget: a woken session sat 1,031,822 ms before its first turn
 * (dolly, 2026-09-22). The bound is on awake time, like every Node timer: a sleeping laptop pauses
 * it, which is what we want, since the harness's own timer pauses too.
 *
 * Past the budget the hook returns 0 with whatever it has already written. Everything it does is
 * fail-open already (a dead daemon is silence), and `bin` exits once the command settles, so the
 * stalled sockets die with the process instead of holding the session's first turn.
 */
export const SESSION_CAPTURE_BUDGET_MS = 30_000;

export async function sessionCommand(
  parsed: Parsed,
  deps: SessionCommandDeps = {},
): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'start' || sub === 'end') return captureCommand(sub, parsed, deps);
  if (sub === 'observe') return observeCommand(parsed, deps);
  if (sub === 'label-nudge') return labelNudgeCommand();
  if (sub === 'orient-nudge') return orientNudgeCommand();
  if (sub === 'orient-stamp') return orientStampCommand();
  if (sub === 'statusline') return statuslineCommand(parsed);
  if (sub === 'bind') return bindCommand(parsed);
  if (sub === 'show' || sub === undefined) return showCommand(parsed);
  throw new CliError(
    'usage: musterd session start --stdin | end --stdin | observe --stdin [--orient] [--interrupt] | label-nudge | orient-nudge | orient-stamp | statusline --stdin | bind --thread <id> | show  ' +
      '(start/end/observe are hook-driven — `musterd init` provisions the hooks; humans want `show`)',
    2,
  );
}

/** The harness class this capture path serves. The hook JSON shape below is Claude Code's; other
 *  harnesses get their own capture route per the per-class contract (design doc §3). */
const CAPTURE_HARNESS = 'claude-code';

/**
 * The harness the host spawned this session as (ADR 436 clause 3 — capture), stamped at spawn in
 * `MUSTERD_WAKE_HARNESS` beside the wake lease. It outranks the payload-shape inference below: a
 * woken OpenCode or Grok child fires a hook whose JSON can look like Claude Code's, and on
 * 2026-09-21/22 every such capture was recorded `claude-code`. Honoured only beside a lease — the
 * actuator sets both or neither, so a stray variable in an ordinary session asserts nothing.
 */
export function resolveWakeHarness(env: NodeJS.ProcessEnv): string | undefined {
  if (!resolveAttestedWakeLease(env)) return undefined;
  const raw = env['MUSTERD_WAKE_HARNESS']?.trim();
  return raw && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw) ? raw : undefined;
}

/** Drain stdin with a hard timeout — a hook wiring mistake (no JSON piped) must not hang a shell. */
const readStdin = readHookStdin;

/** The fields we use from the harness hook payload — parsed leniently, unknown fields ignored. */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** Cursor Agent hooks (ADR 198): structured selected-model id. */
  model_id?: string;
  /** Cursor Agent hooks (ADR 198): legacy composer model slug. */
  model?: string;
  /** Which harness produced this payload — inferred from field names (ADR 352). */
  harness?: 'claude-code' | 'cursor' | 'grok';
}

function parseHookPayload(raw: string): HookPayload {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return {};
    const o = json as Record<string, unknown>;
    // Cursor uses conversation_id; Claude Code uses session_id. Same capture slot.
    const sessionId =
      typeof o['session_id'] === 'string'
        ? o['session_id']
        : typeof o['sessionId'] === 'string'
          ? o['sessionId']
          : typeof o['conversation_id'] === 'string'
            ? o['conversation_id']
            : undefined;
    const roots = Array.isArray(o['workspace_roots'])
      ? o['workspace_roots'].filter((r): r is string => typeof r === 'string')
      : [];
    const cwd =
      typeof o['cwd'] === 'string'
        ? o['cwd']
        : typeof o['workspaceRoot'] === 'string'
          ? o['workspaceRoot']
          : roots.length > 0
            ? roots[0]
            : undefined;
    const harness: HookPayload['harness'] =
      typeof o['sessionId'] === 'string' || typeof o['hookEventName'] === 'string'
        ? 'grok'
        : typeof o['conversation_id'] === 'string'
          ? 'cursor'
          : 'claude-code';
    return {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(typeof o['transcript_path'] === 'string' && o['transcript_path']
        ? { transcript_path: o['transcript_path'] }
        : {}),
      ...(cwd ? { cwd } : {}),
      ...(typeof o['model_id'] === 'string' ? { model_id: o['model_id'] } : {}),
      ...(typeof o['model'] === 'string'
        ? { model: o['model'] }
        : typeof o['current_model_id'] === 'string'
          ? { model: o['current_model_id'] }
          : {}),
      harness,
    };
  } catch {
    return {};
  }
}

async function captureCommand(
  event: 'start' | 'end',
  parsed: Parsed,
  deps: SessionCommandDeps,
): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      `usage: musterd session ${event} --stdin  — hook-driven: pipe the harness's hook JSON in ` +
        '(`musterd init` wires the hooks); to inspect this workspace, use `musterd session show`',
      2,
    );
  }
  const raw = await (deps.stdin ?? readStdin)();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), deps.budgetMs ?? SESSION_CAPTURE_BUDGET_MS);
  });
  try {
    await Promise.race([capture(event, raw, deps), expired]);
  } finally {
    clearTimeout(timer);
  }
  return 0;
}

async function capture(
  event: 'start' | 'end',
  raw: string,
  deps: SessionCommandDeps,
): Promise<void> {
  const payload = parseHookPayload(raw);
  const captureDir = resolveCaptureDir(payload);
  if (event === 'start') await runSessionStartProbe(captureDir ?? undefined, deps.probe);
  await captureSession(event, payload);
  // ADR 445 R1 — the SessionStart / SessionEnd trace events ride the capture hook. After the
  // durable local write and the attestation, never before them; fire-and-forget like both.
  if (captureDir) {
    const binding = findBinding(captureDir, {});
    void tapHook(raw, {
      binding,
      dir: captureDir,
      harness: payload.harness ?? 'claude-code',
      kind: event === 'start' ? 'SessionStart' : 'SessionEnd',
    });
    // ADR 445 R2 (increment 2) — SessionEnd is the transcript tail's last chance at this session:
    // whatever the per-turn Stop reads left behind (a final partial turn, a session that never
    // fired Stop) is picked up here. Awaited, because a hook process that exits kills its posts;
    // the tail is bounded and fail-open, so the wait is what the gate costs, not a new risk.
    // Grok names no transcript in its payload; `transcriptPathFor` derives it from cwd + id.
    const transcriptPath = event === 'end' ? transcriptPathFor(payload) : undefined;
    if (event === 'end' && payload.session_id && transcriptPath) {
      await tailTranscript({
        binding,
        dir: captureDir,
        harness: payload.harness ?? 'claude-code',
        sessionId: payload.session_id,
        transcriptPath,
      });
    }
  }
  if (event === 'start') {
    // The orientation resolves from the SAME anchored dir capture writes to — never bare
    // process.cwd() (miley's #1072 review: the ADR 018 clobber shape, read edition — a mis-cwd'd
    // hook must not emit another seat's inbox and memory headline into this session's context).
    const tookOver = tookOverLine(process.env);
    if (tookOver) process.stdout.write(tookOver + '\n');
    const orientation = await emitSessionOrientation(captureDir);
    if (orientation) process.stdout.write(orientation + '\n');
  }
}

/**
 * The line a person's session opens with after `musterd <seat>` took a wake over (ADR 546): the
 * conversation above it is the wake's, and the wake was stopped mid-errand. The launcher sets
 * `MUSTERD_TOOK_OVER` to why the wake existed. A person's session is not a wake
 * (`MUSTERD_PROVENANCE` is unset), so the wake suppression of the orientation does not touch it.
 */
export function tookOverLine(env: NodeJS.ProcessEnv): string | null {
  const why = env['MUSTERD_TOOK_OVER']?.trim();
  if (!why) return null;
  return `You took over a wake that was running ${why} — its conversation is above; continue from where it stopped.`;
}

/** The one derivation of "which workspace does this hook payload belong to": explicit
 *  MUSTERD_BINDING wins, else walk up from the hook-reported cwd. Shared by capture (write side)
 *  and the orientation (read side) so the two can never disagree. */
function resolveCaptureDir(payload: HookPayload): string | null {
  const explicit = process.env['MUSTERD_BINDING'];
  return explicit
    ? dirname(dirname(explicit))
    : (findWorkspaceDir(payload.cwd ?? process.cwd()) ?? null);
}

type OrientationFetcher = (dir: string | null) => Promise<SessionOrientationInput | null>;

/** The default fetcher: three read-only GETs under the ANCHORED workspace's bound-seat identity —
 *  the binding at `dir`, never the ambient cwd's (ADR 018/036). A folder without a seat-pinned,
 *  keyed binding has no orientation. */
async function defaultOrientationFetcher(
  dir: string | null,
): Promise<SessionOrientationInput | null> {
  const binding = dir ? requireUsableBinding(dir) : null;
  const seat = binding ? bindingSeat(binding) : undefined;
  const key = binding?.seat_credential ?? binding?.agent_key;
  if (!binding || !seat || !key) return null;
  const team = binding.team;
  // The ADR 246 ladder (observed > env > declared), not the bare declaration: what this client
  // attests is what a reclaim would stamp on the seat.
  const model = attestedModel(binding, process.env);
  // A CLI act is intrinsically `cli` (ADR 286), matching gather()'s binding branch.
  const http = new HttpClient({
    server: binding.server,
    key,
    seat,
    ...(binding.session_lease !== undefined ? { sessionLease: binding.session_lease } : {}),
    surface: 'cli',
    ...(model !== undefined ? { model } : {}),
  });
  // Lane 01M2GTB0RA: the summary, not the brief — this runs on every turn of every session, and
  // the brief cost the daemon 0.5–1.8 s of its single thread per call for three numbers.
  const [inboxRes, brief, memory] = await Promise.all([
    http.inbox(team, { unread: true }),
    http.nextSummary(team),
    http.getMemoryEnvelope(team).catch(() => undefined), // absent memory is a normal state
  ]);
  // Lane 01M3TB3DA2: no roster read here — the orientation's read budget is fixed (three
  // presence-neutral reads) and a seat's own session is an agent's, never an admin human's. A
  // team-addressed ask therefore does not count; directed and eligible-set asks do.
  const waiting = openActionNeeded(
    inboxRes.messages,
    seat,
    inboxRes.answered ?? [],
    dischargedIds(inboxRes),
  ).map((m) => ({
    act: m.act,
    from: m.from,
    id: m.id,
  }));
  const now = Date.now();
  return {
    seat,
    team,
    ...(memory
      ? {
          memory: {
            headline: memory.headline,
            saved_at: memory.saved_at,
            size_bytes: memory.size_bytes,
          },
        }
      : {}),
    waiting,
    incidents: brief.incidents.map((id) => ({ id })),
    owed: brief.owed.map((r) => ({ laneId: r.lane, waitedMs: now - r.ts })),
    carrying: brief.carrying,
    holds: (brief.holds ?? []).map((h) => ({
      id: h.id,
      effect: h.effect,
      createdBy: h.created_by,
      expiresAt: h.expires_at,
    })),
  };
}

/**
 * Spec 2026-08-25 (session orientation) §A: the one deliberate exception to "capture adds zero
 * context". Read-only, bounded, wake-suppressed, silent on ANY failure — it rides the SessionStart
 * hook, whose stdout lands in model context. The composable-only bar lives in
 * {@link composeSessionOrientation}; this layer only decides silence.
 */
export async function emitSessionOrientation(
  dir: string | null,
  fetch: OrientationFetcher = defaultOrientationFetcher,
): Promise<string | null> {
  if (process.env['MUSTERD_PROVENANCE'] === 'wake') return null;
  try {
    const input = await fetch(dir);
    return input ? composeSessionOrientation(input) : null;
  } catch {
    return null; // hook contract: a failing orientation must never disturb the session it rides
  }
}

/**
 * `session statusline` — the user-facing half of the orientation (see `sessionStatusline.ts` for
 * why the SessionStart block could never be that half itself).
 *
 * Same anchoring discipline as capture and the orientation: resolve from the payload's cwd via
 * {@link resolveCaptureDir}, never bare `process.cwd()`. A statusline is the WORST place to get
 * this wrong — it redraws every turn, so a mis-anchored chip would sit there all session telling
 * the human they are in a seat they are not in.
 *
 * Unlike the orientation this is NOT wake-suppressed: a wake injects context, and suppression
 * exists to keep the block from re-priming an already-primed agent. The chip primes nobody — it is
 * a label on a terminal, and a woken session still needs to know which seat it belongs to.
 */
export type StatuslineFetcher = (dir: string | null) => Promise<SessionStatuslineInput | null>;

/** How long a whole render may take before the chip gives up and shows nothing.
 *
 *  A stopped daemon fails fast (connection refused), but a WEDGED one — socket held, not answering —
 *  is the mode guardian raised five times in one day, and `HttpClient` carries no AbortSignal. Without
 *  a bound, each redraw would hang until the harness killed it, leaving a stray node process per turn
 *  instead of the clean silence this path promises. Silence-on-failure is only true if failure is
 *  bounded (ryder's #1076 review). */
const STATUSLINE_BUDGET_MS = 1_500;

/** The statusline's OWN fetcher — deliberately not the orientation's.
 *
 *  Two differences, both required rather than cosmetic:
 *
 *  1. **Presence-neutral.** The orientation touches presence, and that is correct: a session opening
 *     IS liveness. A statusline redraw is not — it fires as the conversation updates, so reusing the
 *     touching client would make an open terminal look `present` forever. That silences the
 *     away-notifier for the very seat it was reporting on (ADR 057, `touchAmbientPresence`'s own
 *     comment names this hazard), pins a dormant seat in the ADR 188 review pool, and — because the
 *     presence UPDATE rewrites surface/provenance/wake_lease unstickily — a redraw can NULL the
 *     ADR 241 lease of a woken session. A background redraw must never fake liveness.
 *  2. **Cheaper.** Two GETs, not three: the orientation's memory-envelope call is dropped outright
 *     because the chip renders no headline, and the inbox is asked for a bounded page instead of
 *     full envelope bodies we only take `.length` of. */
async function defaultStatuslineFetcher(
  dir: string | null,
): Promise<SessionStatuslineInput | null> {
  const binding = dir ? requireUsableBinding(dir) : null;
  const seat = binding ? bindingSeat(binding) : undefined;
  const key = binding?.seat_credential ?? binding?.agent_key;
  if (!binding || !seat || !key) return null;
  const team = binding.team;
  const model = attestedModel(binding, process.env); // ADR 246 ladder, same as every one-shot
  const http = new HttpClient({
    server: binding.server,
    key,
    seat,
    ...(binding.session_lease !== undefined ? { sessionLease: binding.session_lease } : {}),
    surface: 'cli',
    ...(model !== undefined ? { model } : {}),
  }).presenceNeutral();
  // Lane 01M2GTB0RA: the summary, not the brief — see defaultOrientationFetcher.
  const [inboxRes, brief] = await Promise.all([
    http.inbox(team, { unread: true, limit: STATUSLINE_INBOX_LIMIT }),
    http.nextSummary(team),
  ]);
  // Lane 01M3TB3DA2: exactly two reads, as pinned — see the orientation fetcher's note above.
  const waiting = openActionNeeded(
    inboxRes.messages,
    seat,
    inboxRes.answered ?? [],
    dischargedIds(inboxRes),
  );
  return {
    seat,
    team,
    waiting: waiting.length,
    // `unread_remaining`, NOT `truncated`: the server computes truncated as
    // `limit === undefined && full` (http.ts:3854), so it is exclusively the no-limit caller's
    // signal and is permanently absent here — reading it made the marker dead code (ryder's #1076
    // re-check). `unread_remaining` is the counterpart computed for the limit-naming branch.
    // It counts UNREAD rows while `waiting` counts the action-needed subset, so it means "more was
    // cut that I did not classify" — exactly a floor marker, which is all `n+` claims.
    ...((inboxRes.unread_remaining ?? 0) > 0 ? { waitingTruncated: true } : {}),
    incidents: brief.incidents.length,
    carrying: brief.carrying,
  };
}

/** Enough rows to count honestly for a chip; past this the count renders as `n+`. */
const STATUSLINE_INBOX_LIMIT = 100;

export async function emitSessionStatusline(
  dir: string | null,
  fetch: StatuslineFetcher = defaultStatuslineFetcher,
  budgetMs = STATUSLINE_BUDGET_MS,
): Promise<string | null> {
  try {
    const input = await Promise.race([
      fetch(dir),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs).unref?.()),
    ]);
    return input ? composeSessionStatusline(input) : null;
  } catch {
    return null; // a statusline that errors is strictly worse than no statusline
  }
}

async function statuslineCommand(parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      'usage: musterd session statusline --stdin  — harness-driven: pipe the statusLine JSON in ' +
        '(`musterd init` wires it); to inspect this workspace, use `musterd session show`',
      2,
    );
  }
  const payload = parseHookPayload(await readStdin());
  const chip = await emitSessionStatusline(resolveCaptureDir(payload));
  if (chip) process.stdout.write(chip + '\n');
  return 0;
}

async function observeCommand(parsed: Parsed, deps: SessionCommandDeps): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      'usage: musterd session observe --stdin [--orient] [--interrupt]  — Cursor hook-driven (ADR 198 / ADR 333 / ADR 369): pipe the Agent hook JSON in',
      2,
    );
  }
  const raw = await readStdin();
  const payload = parseHookPayload(raw);
  await observeCursorSession(payload);
  const captureDir = resolveCaptureDir(payload);
  if (parsed.flags['orient'] === true) {
    await runSessionStartProbe(captureDir ?? undefined, deps.probe);
    const json = formatCursorOrientation(await emitSessionOrientation(captureDir));
    if (json) process.stdout.write(json + '\n');
  }
  let raised: boolean | undefined;
  if (parsed.flags['interrupt'] === true) {
    const line = await checkHookInterrupt(captureDir);
    raised = line !== null;
    const json = formatCursorInterrupt(line);
    if (json) process.stdout.write(json + '\n');
  }
  // ADR 445 R1 — Cursor's sessionStart / postToolUse / afterShellExecution / afterMCPExecution all
  // arrive here; the tap maps Cursor's event names onto the column's spelling itself. After every
  // line this hook owes stdout, bounded and silent. The postToolUse probe's HookOutcome rides along.
  if (captureDir) {
    await tapHook(raw, {
      binding: findBinding(captureDir, {}),
      dir: captureDir,
      harness: 'cursor',
      // `--orient` is registered on sessionStart only; name it rather than trust a payload field.
      ...(parsed.flags['orient'] === true ? { kind: 'SessionStart' as const } : {}),
      ...(raised !== undefined
        ? { outcome: { hook: 'interrupt' as const, detail: { raised } } }
        : {}),
    });
  }
  return 0;
}

/** Cursor sessionStart injection (ADR 333): wrap the orientation block as the host's JSON seam.
 *  Null in → null out (hook stays silent). Exported for the unit that pins the shape. */
export function formatCursorOrientation(block: string | null): string | null {
  return block ? JSON.stringify({ additional_context: block }) : null;
}

/** Cursor postToolUse interrupt injection (ADR 369): wrap the interrupt line as the host's JSON seam.
 *  Null in → null out (hook stays silent). Exported for the unit that pins the shape. */
export function formatCursorInterrupt(line: string | null): string | null {
  return line ? JSON.stringify({ additional_context: line }) : null;
}

/** Hook postToolUse interrupt probe (ADR 369): query the daemon for waiting interrupt-class acts.
 *  Returns the daemon-composed line or null. Best-effort, fail-open, silent on any error. */
export async function checkHookInterrupt(dir: string | null): Promise<string | null> {
  if (process.env['MUSTERD_NO_NUDGE'] === '1') return null;
  const binding = dir ? requireUsableBinding(dir) : null;
  const seat = binding ? bindingSeat(binding) : undefined;
  const key = binding?.seat_credential ?? binding?.agent_key;
  if (!binding || !seat || !key) return null;
  const team = binding.team;
  const model = attestedModel(binding, process.env);
  const http = new HttpClient({
    server: binding.server,
    key,
    seat,
    ...(binding.session_lease !== undefined ? { sessionLease: binding.session_lease } : {}),
    surface: 'cli',
    ...(model !== undefined ? { model } : {}),
  });
  try {
    const res = await http.interruptCheck(team);
    return res.raised && res.line ? res.line : null;
  } catch {
    return null;
  }
}

/**
 * Is a session running here that the capture slot does not name? — the ADR 166 question, asked of
 * one reader that never asked it.
 *
 * `binding.session` is written only by the SessionStart hook. When that hook does not write for a
 * new session, the predecessor's block survives with its `ended_at` intact, and every later reader
 * concludes the live seat has ended. Enumerated session files are the stronger witness (ADR 166
 * "THE FLIP"), so they settle it: a transcript in this workspace being appended to *right now*,
 * whose id is not the captured one, means the slot is a corpse and names where the truth is.
 *
 * Returns the live session's transcript when the slot is contradicted, else undefined. Read-only,
 * best-effort, and silent on any failure — it rides a hook.
 */
function liveSessionElsewhere(
  dir: string,
  session: SessionCapture,
  now: number,
  enumerate: typeof enumerateClaudeSessions,
): { path: string; id: string } | undefined {
  try {
    const files = enumerate(dir);
    if (!files) return undefined; // the harness cannot enumerate — the slot stays the only witness
    // Newest, not first. A quiet slot healed onto an arbitrary warm neighbour would attest that
    // neighbour's model (ADR 455). The file touched most recently is the session being written.
    const live = files
      .filter((f) => now - f.mtime < LOCAL_SESSION_LIVE_MS && f.id !== session.id)
      .sort((a, b) => b.mtime - a.mtime)[0];
    return live ? { path: live.path, id: live.id } : undefined;
  } catch {
    return undefined;
  }
}

/** When a healed slot's session began: the transcript file appears at session start, so its
 *  birthtime is the honest `started_at`. Undefined on any stat failure — it rides a hook.
 *
 *  FLOORED, and that is load-bearing: `birthtimeMs` is fractional, while `SessionCaptureSchema`
 *  declares `started_at` as `z.number().int()`. Handing the float straight through wrote a binding
 *  that `readBinding` could no longer parse, so `findBinding` returned null for that workspace
 *  forever and every CLI path that resolves identity through it died silently — including this
 *  refresh, at its own first guard. TypeScript cannot see the difference: `.int()` is a runtime
 *  refinement on a field the type system only knows as `number`. */
function birthtimeOf(path: string): number | undefined {
  try {
    const t = statSync(path).birthtimeMs;
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
  } catch {
    return undefined;
  }
}

/** Does the slot's occupant still look like a working session? — its transcript touched within
 *  the same LOCAL_SESSION_LIVE_MS clock every other liveness read uses. No transcript path, or a
 *  quiet one, still read as not-live: the newcomer takes the slot, exactly as before the
 *  interloper gate.
 *
 *  A named path that is not on disk yet is the measured exception (2026-08-12 /clear): Claude
 *  Code's SessionStart names `transcript_path` before the file exists — the file appears at first
 *  turn, not at start. A stat miss used to read as not-live and an empty newcomer took a live
 *  slot 4s after capture. That occupant is live by construction for the same clock: `started_at`
 *  is already in the slot and needs no filesystem. Past the clock, a missing file is the
 *  crashed-predecessor residual and newest-wins resumes. */
function slotLooksLive(occupant: SessionCapture): boolean {
  if (!occupant.transcript_path) return false;
  try {
    return Date.now() - statSync(occupant.transcript_path).mtimeMs < LOCAL_SESSION_LIVE_MS;
  } catch {
    return Date.now() - occupant.started_at < LOCAL_SESSION_LIVE_MS;
  }
}

/** The interloper gate's activity predicate: the transcript exists AND carries a real turn.
 *  A bounded head read — an empty interloper has no file at all, and a genuine resumed session's
 *  transcript opens with its history, so 64KB is ample to find the first user/assistant entry. */
function transcriptHasTurn(path: string | undefined): boolean {
  if (!path) return false;
  try {
    const head = readFileSync(path, { encoding: 'utf8' }).slice(0, 65536);
    // Either JSONL shape counts — `type` (hook/transcript entries) or `role` (message objects,
    // the shape `readModelFromTranscript` already accepts). An empty interloper has neither,
    // because it has no file at all.
    return /"(?:type|role)"\s*:\s*"(?:user|assistant)"/.test(head);
  } catch {
    return false;
  }
}

/**
 * Ask the harness that owns this capture what model it is actually running. Never throws: a probe
 * failure must not fail a hook, and `undefined` simply falls through to the declared tier.
 */
function observeModelFor(harnessId: string, payload: HookPayload): string | undefined {
  try {
    return HARNESSES.find((h) => h.id === harnessId)?.observeModel?.({
      ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      ...(payload.model_id ? { model_id: payload.model_id } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * The capture itself, stdin-free (exported for tests + the e2e harness): resolve the workspace,
 * write/annotate `binding.session`, then push the harness-class-only attestation best-effort.
 */
/**
 * The resumable attestation (harness class + correlation digest), best-effort: a dead daemon must
 * never fail a hook, and the local capture is complete without it. Returns whether the push LANDED,
 * which is the only thing that may be written down as attested.
 *
 * The digest travels; the id does not. It is what lets the ledger distinguish one session flapping
 * from two short-lived sessions of the same seat — the question that made 48 same-seat
 * captured→ended pairs unreadable on 2026-08-05.
 *
 * Exported so `codexHook.ts` can share it (lane 01M1JBH9CR): codex's own `attest()` never sent
 * `seat`/`sessionLease` and 401'd unconditionally, silently, on every call since it was written —
 * this is the implementation that already gets the credential shape right.
 */
export async function pushAttestation(
  binding: Binding,
  session: SessionCapture,
  event: 'start' | 'end',
  dir: string,
  // The capture's own harness (ADR 436 clause 3). Until 2026-09-24 this defaulted to `claude-code`
  // and the hook path passed nothing, so the ledger said `claude-code` for every Grok capture even
  // when the local slot said `grok`.
  harness: string = session.harness,
  // Whether a refused lease may be answered with a claim. A session event (start/end) may; the
  // tool boundary may only while this slot has never spent its claim — see `claim_attempted_at`.
  mayClaim = true,
): Promise<boolean> {
  const seat = bindingSeat(binding);
  const key = binding.seat_credential ?? binding.agent_key;
  if (!binding.agent_key || !key || !seat) return false;
  // The wake lease (ADR 241/252), when this process was spawned by a wake: the correlation
  // token rides the child's env, so it is attested here exactly as the presence-touch path
  // attests it. Never defaulted — an ordinary session has no `MUSTERD_WAKE_LEASE` and says
  // nothing (ADR 236). This is what lets a lease that dies `lease_expired` still be known to
  // have PAID for a session: the captured row names the lease by identity, not by timing.
  const wakeLease = resolveAttestedWakeLease(process.env);
  const body = {
    seat,
    harness,
    event,
    session_digest: sessionDigest(binding.agent_key, session.id),
    ...(wakeLease ? { wake_lease: wakeLease } : {}),
  };
  // A CLI hook is intrinsically `cli` (ADR 286); the workspace label is what keeps a claim from
  // this one-shot from evicting the live adapter in the same worktree (ADR 340, #1131).
  //
  // The model rides too, through the ADR 246 ladder (observed > env > declared). The reclaim below
  // is a real seat claim, and a claim is where a Presence gets its model: built without one it
  // minted a `cli` row attesting nothing — the newest non-held row, so the seat read `unknown` to
  // the ADR 188 picker until something else attested. Measured 2026-09-02: the two big-body
  // `worker_unattested` rows that survived the claim storm each sat 4s after a bare `cli` claim,
  // and post-storm the seats made 244 `cli` claims to 50 `claude-code`. The hook holds the
  // harness's own observation in `binding.model_observed`; sending it is not a declaration.
  const model = attestedModel(binding, process.env);
  const client = (sessionLease: string | undefined) =>
    new HttpClient({
      server: binding.server,
      team: binding.team,
      workspace: resolveClaimWorkspace(process.env, dir),
      workspaceKey: resolveWorkspaceKey(process.env, dir),
      key,
      seat,
      surface: 'cli',
      ...(sessionLease !== undefined ? { sessionLease } : {}),
      ...(model !== undefined ? { model } : {}),
    }).presenceNeutral();
  try {
    await client(binding.session_lease).attestSession(binding.team, body);
    return true;
  } catch (err) {
    // unreachable daemon / auth drift — the local capture stands; `residency status` names drift
    if (!isSessionLeaseRefusal(err)) return false;
  }
  // The stored lease was refused, not the credential. `binding.session_lease` is minted once, at
  // claim, and lives five minutes (ADR 337); every hook after that presented a dead lease and this
  // path swallowed the refusal with "unreachable" — local slot written, ledger silent (lane
  // 01M1F92X69, measured on seat ryder 2026-09-01). ADR 337 §4 is the remedy: one fresh claim, in
  // reply to the refusal and never before it (a claim per hook is the 2026-09-01 storm, #1138).
  //
  // Once per slot, not once per tool call: `attestSlotIfUnattested` rides every tool call, and a
  // claim that succeeds while the attest still fails — or a claim the daemon refuses — would
  // otherwise be retried at the storm's cadence against an occupied seat. The slot remembers that
  // its claim was spent; only a fresh session event gets another.
  if (!mayClaim) return false;
  stampClaimAttempted(dir, session.id);
  // Never evict. Two worktrees bound to one seat is the ordinary shape here, and a claim from this
  // worktree SUPERSEDES an adapter live in the other (`claim.superseded {same_workspace:false}` —
  // the storm's own audit row), leaving that adapter running on a dead lease. Same-workspace
  // coexistence is the server's (ADR 340, #1131); elsewhere is refused here, before the socket
  // opens, and the slot stays unattested — an undercount that says so beats a silent eviction.
  if (await heldElsewhere(client(undefined), binding, dir)) return false;
  //
  // The minted lease is deliberately NOT written back to the binding. It is bound to the Presence
  // this claim holds, and closing the socket releases that Presence (`held_until`, ws.ts cleanup),
  // which `hasValidSessionLease` reads as dead — measured 2026-09-01: a second hook presenting the
  // lease the first had just minted was refused in ~1 of 4 runs, the other 3 being the close still
  // in flight. A one-shot cannot leave a live lease behind; a lease that outlives its claim is a
  // server decision, not a client one.
  let claim: { lease: string; close: () => void };
  try {
    claim = await client(undefined).claimSessionLease();
  } catch {
    return false; // the seat is someone else's, or the daemon went away mid-way: not ours to force
  }
  try {
    await client(claim.lease).attestSession(binding.team, body);
    return true;
  } catch {
    return false;
  } finally {
    claim.close();
  }
}

/**
 * Is this seat live in a workspace other than `dir`'s? Read from the roster, which answers an
 * anonymous or stale-lease caller too (`tryAuth`) — the whole point is to ask BEFORE holding any
 * authority. `away` counts as live: the adapter is still connected and a claim would still evict it.
 * A roster the daemon will not give us is read as "held elsewhere": refusing to claim is the safe
 * miss, an eviction is not.
 */
async function heldElsewhere(http: HttpClient, binding: Binding, dir: string): Promise<boolean> {
  const seat = bindingSeat(binding);
  const here = resolveClaimWorkspace(process.env, dir);
  try {
    const { members } = await http.roster(binding.team);
    const me = members.find((m) => m.name === seat);
    if (!me) return true;
    return me.presences.some(
      (p) => p.status !== 'offline' && p.workspace != null && p.workspace !== here,
    );
  } catch {
    return true;
  }
}

/** Remember that this slot's one claim was spent, whatever came of it. Re-read, same id, or nothing. */
function stampClaimAttempted(dir: string, sessionId: string): void {
  const fresh = findBinding(dir, {});
  if (!fresh?.session || fresh.session.id !== sessionId) return;
  saveBinding(dir, { ...fresh, session: { ...fresh.session, claim_attempted_at: Date.now() } });
}

/** The server's two lease refusals (`missing` / `invalid, expired, or revoked agent session lease`)
 *  — as opposed to a refused credential, a refused seat, or no daemon, none of which a claim fixes. */
function isSessionLeaseRefusal(err: unknown): boolean {
  return (
    err instanceof CliError &&
    err.code === 'unauthorized' &&
    /agent session lease/.test(err.message)
  );
}

/**
 * Tell the daemon about a slot it was never told about (lane 01M159BHJK).
 *
 * SessionStart is not the only way a session comes to hold the workspace slot, but it was the only
 * one that attested. The interloper gate turns a newcomer away with "no slot write AND no daemon
 * attestation" — and a fresh session cannot satisfy that gate's activity predicate, because a
 * transcript has no turn yet at SessionStart. The heal in {@link refreshModelObservation} then hands
 * the slot to the session actually running, at the first tool boundary, and writes it locally with
 * nothing sent anywhere.
 *
 * Measured on seat ryder 2026-08-28: a session that took the slot exactly that way ran for two
 * hours, claimed a lane and closed one, and never appeared on the ledger at all — its digest
 * `982f768adf12` returned zero audit rows, while the newest session the daemon knew of was a wake
 * child that had ended 90 minutes before. The gate's note that "the slot self-corrects at the next
 * SessionStart" is true of the slot and false of the ledger, which has no later moment to correct in.
 *
 * So the boundary that always happens reconciles it. Deliberately narrow:
 *   · only an un-ended slot — a corpse is not a session to announce;
 *   · only when `attested_at` is absent, so this is one push per session, not one per tool call;
 *   · the stamp is written only when the push LANDED, so an unreachable daemon stays due instead of
 *     being marked done — the failure this closes must not be re-openable by one bad minute;
 *   · nothing here writes or steals a slot, so the interloper gate keeps deciding who holds it. A
 *     newcomer the gate turned away has no slot, and therefore still announces nothing.
 */
export async function attestSlotIfUnattested(dirHint?: string): Promise<void> {
  try {
    const dir = dirHint ?? findWorkspaceDir();
    if (!dir) return;
    const binding = findBinding(dir, {});
    const session = binding?.session;
    if (!binding || !session) return;
    if (session.ended_at !== undefined || session.attested_at !== undefined) return;
    const mayClaim = session.claim_attempted_at === undefined;
    if (!(await pushAttestation(binding, session, 'start', dir, session.harness, mayClaim))) return;
    // Re-read: the push is awaited, and a concurrent hook may have rewritten the slot meanwhile.
    // Stamping a slot that has since changed id would mark a DIFFERENT session as announced.
    const fresh = findBinding(dir, {});
    if (!fresh?.session || fresh.session.id !== session.id) return;
    saveBinding(dir, { ...fresh, session: { ...fresh.session, attested_at: Date.now() } });
  } catch {
    // A tool-boundary reconciler must never fail the tool call it rides on.
  }
}

export async function captureSession(event: 'start' | 'end', payload: HookPayload): Promise<void> {
  if (!payload.session_id) return; // no id, nothing to capture — a hook must never fail

  // Resolve the workspace: an explicit MUSTERD_BINDING (the harness env rides through the hook)
  // wins, else walk up from the hook-reported cwd. Bare process.cwd() is only the last resort —
  // the hook one-liner cd's to CLAUDE_PROJECT_DIR, so it agrees with `payload.cwd` anyway.
  const dir = resolveCaptureDir(payload);
  if (!dir) return; // not a musterd workspace — nothing to capture

  const binding = findBinding(dir, {});
  if (!binding) return;

  let session: SessionCapture;
  if (event === 'start') {
    // ── The interloper gate (lane 01KZAEGF2K step 3) ──────────────────────────────────────────
    // Measured 2026-08-06: empty ~4-second claude-code processes fire real SessionStart/SessionEnd
    // hooks in seat folders (same-digest pairs; no transcript anywhere; no marker), capture the
    // slot on start, and their perfectly honest `ended` demotes the LIVE session mid-work. ADR
    // 108's probe-displacement finding one layer down — probe-safety was applied to autojoin and
    // never to capture. So: a newcomer may not TAKE a live-looking slot until its own transcript
    // shows a turn. Gated means invisible — no slot write AND no daemon attestation, so the pair
    // never exists on the ledger (its `end` is already a no-op via the mismatched-id guard below).
    //
    // Deliberately the OVERWRITE is gated, never the capture itself (dolly's variant, this lane):
    // an empty or ended or stale slot keeps today's newest-wins, so a fresh workspace still
    // captures on SessionStart — which matters wherever enumeration cannot see the workspace and
    // the slot IS the whole local-session guard (ADR 131). The activity predicate is
    // transcript-HAS-A-TURN, not file-exists. The `birthtimeOf` contradiction is settled
    // (measured 2026-08-12): the file appears at first turn, not at start — so a named-but-
    // missing occupant transcript is live by construction via `started_at` for
    // LOCAL_SESSION_LIVE_MS (see `slotLooksLive`). Known bounded residual: a crashed
    // (never-ended) predecessor defers a genuine newcomer's takeover for up to
    // LOCAL_SESSION_LIVE_MS; enumeration-first liveness keeps the guard honest meanwhile, and
    // the slot self-corrects at the next SessionStart.
    const occupant = binding.session;
    if (
      occupant &&
      occupant.id !== payload.session_id &&
      !occupant.ended_at &&
      slotLooksLive(occupant) &&
      !transcriptHasTurn(payload.transcript_path)
    ) {
      return;
    }
    session = {
      harness: resolveWakeHarness(process.env) ?? payload.harness ?? CAPTURE_HARNESS,
      id: payload.session_id,
      ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
      started_at: Date.now(),
    };
  } else {
    // SessionEnd is advisory: only annotate the capture it belongs to. A mismatched id means the
    // ending session was never captured here (or a newer one already overwrote it) — leave it be.
    if (!binding.session || binding.session.id !== payload.session_id) return;
    session = { ...binding.session, ended_at: Date.now() };
  }

  // The model observation. Additive and best-effort: only SessionStart observes (SessionEnd is
  // advisory and may fire long after the model is knowable), and a harness that cannot observe — or
  // a transcript that is missing or has moved format — leaves any PRIOR observation in place rather
  // than erasing it. Losing a good observation to one bad read would re-open the very lie this
  // closes: the roster would silently fall back to a stale declaration.
  //
  // Expect this to observe NOTHING on a fresh session: the transcript named here is the new one, and
  // it carries no assistant turn yet. `refreshModelObservation` below is what actually lands the
  // observation, at the first tool boundary — this call only catches a resumed transcript.
  const captureHarness = session.harness;
  const observed = event === 'start' ? observeModelFor(captureHarness, payload) : undefined;
  const model_observed = observed
    ? { model: observed, harness: captureHarness, observed_at: Date.now() }
    : binding.model_observed;

  saveBinding(dir, { ...binding, session, ...(model_observed ? { model_observed } : {}) });

  // ADR 210: sweep dead continuity bindings when a session ends. Transcripts vanish and horizons
  // pass between sessions, and a dead binding is a resume attempt that will fail and spend a
  // fallback. Best-effort and after the durable write — a hook must never fail over a cache.
  if (event === 'end') {
    try {
      const owner = bindingSeat(binding);
      if (owner) pruneOnDisk(dir, { team: binding.team, seat: owner }, { now: Date.now() });
    } catch {
      // never fatal — the registry is an optimization
    }
  }

  // The resumable attestation (harness class + correlation digest), best-effort AFTER the durable
  // local write: a dead daemon must never fail the hook, and capture is complete without it.
  //
  // The digest travels; the id does not. It is what lets the ledger distinguish one session
  // flapping from two short-lived sessions of the same seat — the question that made 48 same-seat
  // captured→ended pairs unreadable on 2026-08-05. Note the `end` branch above: a mismatched id
  // returns early, so an `ended` push always carries the digest of the capture it belongs to.
  // `start` records the landing so the tool boundary knows this slot is already announced; a failed
  // push leaves `attested_at` absent, which is what makes {@link attestSlotIfUnattested} retry.
  if ((await pushAttestation(binding, session, event, dir)) && event === 'start') {
    // Re-read: the push is awaited, and a concurrent writer (a slot heal, a model observation) may
    // have rewritten the binding meanwhile. Stamping from the pre-await copy would revert it.
    const fresh = findBinding(dir, {});
    if (!fresh?.session || fresh.session.id !== session.id) return;
    saveBinding(dir, { ...fresh, session: { ...fresh.session, attested_at: Date.now() } });
  }
}

/**
 * Cursor Agent hook path (ADR 198): stamp `binding.session` with `harness: 'cursor'` and observe
 * the live `model_id` from the hook payload. Same never-fail / never-erase / refresh-throttle
 * contract as Claude's transcript refresh — fidelity differs (hook fields, not JSONL).
 */
export async function observeCursorSession(
  payload: HookPayload,
  enumerate?: typeof enumerateClaudeSessions,
): Promise<string | undefined> {
  const explicit = process.env['MUSTERD_BINDING'];
  const dir = explicit
    ? dirname(dirname(explicit))
    : findWorkspaceDir(payload.cwd ?? process.cwd());
  if (!dir) return undefined;

  if (!payload.session_id) {
    // cursor-agent often dispatches afterMCPExecution without conversation_id. Enumeration
    // still knows the live .txt (ADR 268) — do not no-op.
    refreshModelObservation(dir, enumerate);
    return undefined;
  }

  const binding = findBinding(dir, {});
  if (!binding) return undefined;

  const now = Date.now();
  const prior = binding.session;
  const same = prior?.id === payload.session_id && prior.harness === 'cursor';
  const session: SessionCapture = {
    harness: 'cursor',
    id: payload.session_id,
    ...(payload.transcript_path
      ? { transcript_path: payload.transcript_path }
      : same && prior.transcript_path
        ? { transcript_path: prior.transcript_path }
        : {}),
    started_at: same ? prior.started_at : now,
  };

  const observed = observeModelFor('cursor', payload);
  const priorObs = binding.model_observed;
  const current =
    observed !== undefined &&
    priorObs !== undefined &&
    priorObs.model === observed &&
    priorObs.observed_at >= session.started_at &&
    now - priorObs.observed_at < OBSERVATION_REFRESH_MS;

  if (observed && !current) {
    saveBinding(dir, {
      ...binding,
      session,
      model_observed: { model: observed, harness: 'cursor', observed_at: now },
    });
    // fall through to attest-on-new-session below
  } else if (!same && !observed) {
    // New conversation, no model in the payload: a leftover observation is a stopped clock
    // (ADR 268). Omit cannot say this — saveBinding's merge-guard treats omit as preserve.
    const { model_observed: _dropped, ...rest } = binding;
    saveBinding(dir, { ...rest, session }, { drop: { model_observed: true } });
  } else {
    saveBinding(dir, { ...binding, session, ...(priorObs ? { model_observed: priorObs } : {}) });
  }

  if (!same || prior?.ended_at !== undefined) {
    // Best-effort like the claude-code path, refused-lease reclaim included; local capture stands.
    await pushAttestation(binding, session, 'start', dir, 'cursor');
  }

  return observed && !current ? observed : undefined;
}

/**
 * How long an observation stands before the next tool boundary re-reads the transcript. Bounds two
 * opposite failures: too short and every tool call pays a 256 KiB tail read; too long and a
 * mid-session `/model` switch attests the old model for the rest of the run.
 */
export const OBSERVATION_REFRESH_MS = 5 * 60_000;

/**
 * Re-observe the running model from the captured transcript (ADR 158 follow-up).
 *
 * SessionStart is the wrong and only moment `captureSession` observes: the transcript it is handed
 * is the *new* session's, which has no assistant turn yet, so `observeModel` returns `undefined`
 * every single time and the deliberate never-erase fallback pins the previous observation forever.
 * Two lies come out of that, and this closes both:
 *
 * - **The carry-forward.** A seat that switched models between sessions attests the old one for the
 *   whole new session — the stale declaration ADR 158 set out to kill, relocated one field over.
 * - **The mid-session switch.** `readModelFromTranscript` walks backwards precisely so a run that
 *   switched models attests the one it is running *now*; observing once, at the start, threw that away.
 *
 * Runs at the tool boundary (the PostToolUse interrupt hook), where the transcript is guaranteed to
 * carry at least one assistant turn. Cheap by construction: a bounded tail read, at most once per
 * `OBSERVATION_REFRESH_MS`, skipped entirely once the observation is current. Never throws and never
 * erases — same hook contract as capture. Returns the newly written model, or `undefined` for "no
 * change", which is the overwhelmingly common path.
 */
/**
 * ADR 521: the transcript-less refresh. Opencode keeps sessions in `opencode.db`, so a binding
 * with no `transcript_path` is the normal state, not a missing capture — and the old bail retired
 * model observation for the seat's whole life. The opencode probe reads the live `session_v2` row
 * for the workspace directory itself, so it needs no slot and no hook: ask it directly.
 *
 * Same contract as the transcript path: throttled (`OBSERVATION_REFRESH_MS`), never throws,
 * never erases (an unreadable store keeps the prior observation). Gated on the opencode
 * workspace marker, so every other transcript-less caller pays one file check, not a subprocess.
 * A prior observation from another harness is re-probed immediately — a seat that changed
 * harness must not keep attesting the old one's model.
 */
export function refreshTranscriptlessObservation(
  dir: string,
  binding: Binding,
  now: number = Date.now(),
): string | undefined {
  try {
    if (!existsSync(join(dir, '.opencode', 'opencode.json'))) return undefined;
    const prior = binding.model_observed;
    if (
      prior !== undefined &&
      prior.harness === 'opencode' &&
      now - prior.observed_at < OBSERVATION_REFRESH_MS
    )
      return undefined;
    const observed = observeModelFor('opencode', { cwd: dir });
    if (!observed) return undefined;
    saveBinding(dir, {
      ...binding,
      model_observed: { model: observed, harness: 'opencode', observed_at: now },
    });
    return observed;
  } catch {
    return undefined;
  }
}

export function refreshModelObservation(
  dirHint?: string,
  // Injected for tests, mirroring `localSessionLiveness` — the enumerator reads the real
  // ~/.claude/projects tree, which a unit test must not depend on.
  enumerate: typeof enumerateClaudeSessions = enumerateClaudeSessions,
): string | undefined {
  try {
    const dir = dirHint ?? findWorkspaceDir();
    if (!dir) return undefined;
    const binding = findBinding(dir, {});
    if (!binding) return undefined;
    const session = binding?.session;
    // ADR 521: no transcript to re-read (opencode keeps sessions in opencode.db, not a file).
    // Ask the harness that owns the workspace directly instead of retiring observation for life.
    if (!session?.transcript_path) return refreshTranscriptlessObservation(dir, binding);

    // Only a live captured session has a transcript worth re-reading — but "ended" is a claim by the
    // SLOT, and ADR 166 already established that the slot is the weaker witness: enumerated session
    // files decide, because "a workspace with a live session and a newer dead one is exactly the case
    // the slot gets wrong". This reader never got that flip, and the cost is specific.
    //
    // The capture is only replaced by a SessionStart hook. When that hook does not write for a new
    // session — measured live on 2026-07-29: 3 of 5 active seats carried a predecessor's block, one
    // of them 16 days old — the corpse stays on disk with `ended_at` set, and every later read
    // concludes the LIVE seat has ended. Bailing here then silently retires model *observation* for
    // the rest of that seat's life, so attestation falls back to the stale declaration: ADR 163's
    // named failure, "worse, because it looks trustworthy".
    //
    // So an ended slot ends the refresh only when nothing contradicts it. If the workspace has a
    // live session that the slot does not name, the slot is a corpse and the live transcript is the
    // one worth reading.
    const now = Date.now();
    const live = liveSessionElsewhere(dir, session, now, enumerate);
    if (session.ended_at !== undefined && !live) return undefined;

    // The heal (lane 01KYQF0STK). An ended slot contradicted by a live session is not just a bad
    // witness to route around — it is a corpse that keeps doing damage: `session show` reports the
    // seat ended, and the wake ladder resumes the BLIP's transcript, because a valid-but-wrong slot
    // id outranks enumeration. The route table proved SessionStart fires on every spawn route; the
    // corpse gets there by being written LAST — a short concurrent session (a wake beside an
    // idle-but-open interactive session) steals the slot and stamps `ended_at`, and the long-lived
    // session never fires SessionStart again to take it back. So the tool boundary — the boundary
    // that always happens — gives the slot to the session that is actually running. `started_at`
    // comes from the transcript's birthtime (the file appears when the session begins).
    //
    // A recently-touched slot is never overridden by a warm neighbour (izzo, 2026-07-29: four
    // seconds in, the refresh read the predecessor). A quiet unended slot is the other corpse
    // (izzo, 2026-09-24, ADR 455): SessionStart was gated or never wrote, `ended_at` is absent,
    // and the refresh kept reading the old transcript — the roster showed opus for a session
    // running fable. Quiet means `slotLooksLive` is false, the same 10-minute clock. Live-beside-
    // live, both transcripts still moving, stays with the wake guard.
    // Cursor CLI is the other exception (ADR 268): the slot often still names a live desktop
    // session with no ended_at while cursor-agent writes a sibling .txt — heal that too.
    const priorId = session.id;
    let healedBinding = binding;
    let slot = session;
    // Tracked beside the slot because `SessionCapture.transcript_path` is optional in the type while
    // the guard above has already made it present here — and the heal below only ever replaces it
    // with another concrete path.
    let slotTranscript = session.transcript_path;
    const slotQuiet = !slotLooksLive(session);
    if (live && (session.ended_at !== undefined || session.harness === 'cursor' || slotQuiet)) {
      slot = {
        harness: session.harness,
        id: live.id,
        transcript_path: live.path,
        started_at: birthtimeOf(live.path) ?? now,
      };
      slotTranscript = live.path;
      healedBinding = { ...binding, session: slot };
      saveBinding(dir, healedBinding);
    }

    const prior = healedBinding.model_observed;
    // Current already? Two ways to be stale: observed before this session began (the carry-forward),
    // or simply old enough that a mid-run switch could have happened since.
    const current =
      prior !== undefined &&
      prior.observed_at >= slot.started_at &&
      now - prior.observed_at < OBSERVATION_REFRESH_MS;
    if (current) return undefined;

    // The harness that captured the session owns the parse — a codex-captured session must not be
    // read with Claude Code's eyes.
    const harness = slot.harness;
    // Read from the SLOT — which the heal above has already pointed at the live session if the
    // captured one turned out to be a corpse. Preferring `live` directly instead was a scope error
    // with the same shape as the bug it was fixing, one step further out: `liveSessionElsewhere` is
    // any transcript in the project dir touched inside LOCAL_SESSION_LIVE_MS, so a HEALTHY slot was
    // overridden by whichever neighbour happened to be warm. Measured on izzo, 2026-07-29 — a seat
    // that closed one session and opened another three minutes later attested the predecessor's
    // model four seconds in, which is precisely where a *different* model is most likely to be read.
    const observed = observeModelFor(harness, {
      transcript_path: slotTranscript,
      session_id: slot.id,
    });
    if (!observed) {
      // The slot just moved to a different session and that transcript has no model yet. Keeping
      // the previous session's observation would stamp it onto the new one (ADR 268 for Cursor;
      // ADR 455 for every harness — a missing attestation is honest, a wrong one is not). A
      // failed re-read of the SAME session still never-erases.
      if (slot.id !== priorId) {
        const { model_observed: _dropped, ...rest } = healedBinding;
        saveBinding(dir, { ...rest, session: slot }, { drop: { model_observed: true } });
      }
      return undefined; // same session and unreadable — the prior observation stands
    }

    saveBinding(dir, {
      ...healedBinding,
      model_observed: { model: observed, harness, observed_at: now },
    });
    return observed;
  } catch {
    return undefined; // rides a hook: a refresh must never fail the tool call it hangs off
  }
}

/**
 * `session label-nudge` — retired by ADR 442 (the wall). It sent sessions to the Claude Code peer
 * sweep, which renamed every session on the machine; a seat no longer reaches outside itself, and
 * the host labels seat sessions (ADR 166). Kept as a silent no-op because seats provisioned before
 * the wall still run it from their UserPromptSubmit hook — an unknown subcommand there would be
 * noise on every turn until the hook is refreshed.
 */
function labelNudgeCommand(): number {
  return 0;
}

/**
 * The orient nudge (spec 2026-08-25-session-orientation-design.md §B) — the label-nudge pattern
 * applied to orientation: a per-turn line that repeats until a stamp lands, because the one-shot
 * SessionStart ask was measured to fail (see the label-nudge history above). Unlike the label
 * sweep, orientation is a property of THIS session, not this machine, so the stamp is
 * workspace-local and keyed by the session id — a new session makes the old stamp stale and the
 * nudge fires again.
 *
 * WHICH id matters, because the slot is not always the running session. When SessionStart is
 * turned away by the interloper gate (a predecessor that never ended still looks live), the slot
 * names the predecessor for up to LOCAL_SESSION_LIVE_MS, until the tool-boundary heal hands it
 * over. Measured on izzo 2026-09-28: the skill stamped the predecessor's id at 19:59, the heal
 * landed at 20:05, and the 20:06 nudge fired on a session that had already oriented. So both sides
 * prefer the running session's OWN id — the hook payload's `session_id` for the nudge,
 * `CLAUDE_CODE_SESSION_ID` for the stamp — and the stamp also records the slot id it saw, which
 * keeps the old slot-keyed behaviour wherever a harness reports no id of its own.
 */
export const ORIENT_NUDGE_TEXT =
  'musterd: unoriented seat session — run the musterd-orient skill now.';

/**
 * What the orient hook says to a session that has no seat (lane 01M4E4MSW1). Orienting reads the inbox
 * and the lane board AS a seat; a session whose autojoin failed (alfie, 2026-10-07: a revoked
 * credential) has none, so "run the orient skill" sent it to read as nobody and then stamp itself
 * done. One line, like the orient text, with the way in and the repair for the usual cause.
 */
export const NO_SEAT_NUDGE_TEXT =
  'musterd: this session has no seat yet — run team_join now (CLI: `musterd claim <seat>`). ' +
  'If it says the credential is revoked or expired, a team admin runs ' +
  '`musterd team bootstrap mint --seat <seat> --install` on this machine; orient after that.';

function orientStampPath(dir: string): string {
  return join(dir, '.musterd', 'orient-stamp.json');
}

/**
 * Whether this folder holds a live seat: the adapter writes the session lease it was handed into the
 * binding (ADR 471), and the interrupt probe is deaf without one. A local fact, so the nudge — which
 * rides every prompt — makes no network call. A lease that has since died is the deaf line's to say.
 */
function seatedHere(dir: string): boolean {
  return findBinding(dir, {})?.session_lease !== undefined;
}

/**
 * What the per-prompt hook should say, if anything. Silent outside a seat workspace with a captured
 * session; `'no-seat'` when that workspace has no live seat; `'orient'` when it has one and the
 * stamp does not name this session.
 *
 *  Known first-turn race (miley's #1072 review note): at SessionStart the nudge hook and the
 *  capture hook are unordered — if the nudge reads first, it compares the stamp against the
 *  PREVIOUS session's capture and can stay quiet on turn 0. Deliberately left: the per-turn
 *  UserPromptSubmit repeat self-heals on the next prompt, which is exactly why the repeat exists
 *  (the label-nudge lesson). The stamp key is race-free from turn 1 onward. The same repeat covers
 *  `'no-seat'` on a turn before the adapter's autojoin has landed its lease. */
export function orientNudge(dir: string | null, runningId?: string): 'orient' | 'no-seat' | null {
  if (!dir) return null;
  const binding = findBinding(dir, {});
  const slotId = binding?.session?.id;
  if (!binding || binding.claim?.mode !== 'seat' || slotId === undefined) return null;
  if (!seatedHere(dir)) return 'no-seat';
  const current = runningId ?? slotId;
  try {
    const rec = JSON.parse(readFileSync(orientStampPath(dir), 'utf8')) as {
      session_id?: unknown;
      slot_id?: unknown;
    };
    // Either id the stamp saw may name this session: its own id (the heal case) or the slot's (a
    // running id inherited from a parent harness's env, while the slot was right all along).
    return rec.session_id !== current && rec.slot_id !== current ? 'orient' : null;
  } catch {
    return 'orient'; // no stamp (or unreadable) ⇒ due
  }
}

/** Due iff this is a seated seat workspace with a captured session the stamp does not name. */
export function orientNudgeDue(dir: string | null, runningId?: string): boolean {
  return orientNudge(dir, runningId) === 'orient';
}

/** Stamp this session oriented (exported for tests; `orient-stamp` is the CLI face). `runningId` is
 *  the session's own id when the harness reports one; the slot's id is recorded beside it. */
export function writeOrientStamp(
  dir: string | null,
  now = Date.now(),
  runningId?: string,
): boolean {
  const slotId = dir ? findBinding(dir, {})?.session?.id : undefined;
  const sessionId = runningId ?? slotId;
  if (!dir || sessionId === undefined) return false;
  // A session with no seat has oriented to nothing: stamping it would quiet the nudge that is
  // trying to get it one. Refuse, and the nudge keeps asking (lane 01M4E4MSW1).
  if (!seatedHere(dir)) return false;
  writeFileSync(
    orientStampPath(dir),
    JSON.stringify({
      session_id: sessionId,
      ...(slotId !== undefined ? { slot_id: slotId } : {}),
      oriented_at: now,
    }) + '\n',
  );
  return true;
}

/** The running session's own id from the environment. Claude Code sets `CLAUDE_CODE_SESSION_ID` for
 *  the processes it spawns; other harnesses report none here, and the slot stands in. */
function runningSessionIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const id = env['CLAUDE_CODE_SESSION_ID']?.trim();
  return id ? id : undefined;
}

/** How long the nudge waits for its hook payload. Short: it rides every prompt, and a missing
 *  payload only means falling back to the env or the slot. */
const ORIENT_NUDGE_STDIN_MS = 500;

/** `session orient-nudge` — hook-driven, hence silent-or-one-line and never failing. */
async function orientNudgeCommand(): Promise<number> {
  try {
    if (process.env['MUSTERD_PROVENANCE'] === 'wake') return 0; // a wake's errand IS its orientation
    // The hook payload names the session the prompt belongs to. A terminal has no payload to read.
    const payloadId = process.stdin.isTTY
      ? undefined
      : parseHookPayload(await readHookStdin(ORIENT_NUDGE_STDIN_MS)).session_id;
    const runningId = payloadId ?? runningSessionIdFromEnv(process.env);
    const nudge = orientNudge(findWorkspaceDir(), runningId);
    if (nudge === 'no-seat') process.stdout.write(`${NO_SEAT_NUDGE_TEXT}\n`);
    else if (nudge === 'orient') process.stdout.write(`${ORIENT_NUDGE_TEXT}\n`);
  } catch {
    // hook contract: never fail, never noise
  }
  return 0;
}

/** `session orient-stamp` — the musterd-orient skill's final step. Best-effort: on any failure
 *  the stamp is simply absent and the nudge repeats, which is the correct failure direction. A
 *  session with no seat is refused loudly (exit 1) rather than stamped. */
function orientStampCommand(): number {
  try {
    const dir = findWorkspaceDir();
    if (writeOrientStamp(dir, Date.now(), runningSessionIdFromEnv(process.env))) return 0;
    // Not stamped. Say why when the reason is the one that matters — no seat — and exit non-zero so
    // the skill does not read silence as success (alfie, 2026-10-07: it stamped a seatless session).
    if (dir && findBinding(dir, {})?.session?.id !== undefined && !seatedHere(dir)) {
      process.stderr.write(
        `musterd: not stamped — ${NO_SEAT_NUDGE_TEXT.replace(/^musterd: /, '')}\n`,
      );
      return 1;
    }
  } catch {
    // best-effort; the nudge simply repeats
  }
  return 0;
}

/** The acted-on verdict line, with its source (ADR 166: enumerated decides when available). */
function writeVerdict(liveness: LocalSessionLiveness): 0 {
  const verdicts: Record<LocalSessionLiveness['state'], string> = {
    live: `live — a local session is working here (transcript touched < ${LOCAL_SESSION_LIVE_MS / 60_000} min ago); a wake would defer`,
    resumable: 'resumable — a wake would try `--resume` first (fresh on any failure)',
    'gc-expired': 'gc-expired — past the harness GC horizon; a wake runs fresh',
    none: 'none',
  };
  process.stdout.write(
    `  ${theme.accent(verdicts[liveness.state])} ${theme.meta(`(judged by ${liveness.source === 'enumerated' ? 'session files' : 'the captured slot'})`)}\n`,
  );
  return 0;
}

/**
 * `musterd session bind --thread <id>` — the repair half of ADR 210's continuity registry.
 *
 * A threaded send binds automatically, so this exists for the cases where that never happened: a
 * capture that arrived after the send, an inherited session, or a thread whose dialogue moved to a
 * new session. It binds the CURRENT capture and nothing else — it cannot name a session by hand,
 * because a hand-named session is exactly the unprovable claim the whole ADR refuses to act on.
 */
async function bindCommand(parsed: Parsed): Promise<number> {
  const thread = flagStr(parsed.flags, 'thread');
  if (!thread) throw new CliError('usage: musterd session bind --thread <thread-id>', 2);

  const dir = findWorkspaceDir();
  const binding = dir ? findBinding() : null;
  if (!dir || !binding)
    throw new CliError('no workspace binding here — run: musterd claim <name>', 2);

  const seat = binding.claim?.mode === 'seat' ? binding.claim.name : null;
  if (!seat)
    throw new CliError('this workspace holds no seat claim — nothing to bind a thread to', 2);

  if (!binding.session) {
    // Not an error: a harness with no hook path (a Codex seat writes no capture at all today) simply
    // has nothing to bind, and every wake on this thread stays fresh — the correct failure direction.
    process.stdout.write(
      theme.dim('no captured session in this workspace — wakes on this thread stay fresh\n'),
    );
    return 0;
  }

  const bound = bindThread(dir, {
    team: binding.team,
    seat,
    thread_id: thread,
    capture: binding.session,
    now: Date.now(),
  });
  if (!bound) {
    process.stdout.write(
      theme.dim('the captured session names no transcript — wakes on this thread stay fresh\n'),
    );
    return 0;
  }
  const count = readRegistry(dir, { team: binding.team, seat }).bindings.length;
  process.stdout.write(
    `bound thread ${theme.bold(thread)} to this session (${count} thread${count === 1 ? '' : 's'} bound)\n`,
  );
  return 0;
}

async function showCommand(parsed: Parsed): Promise<number> {
  const dir = findWorkspaceDir();
  const liveness: LocalSessionLiveness = dir
    ? localSessionLiveness(dir)
    : { state: 'none', source: 'slot' };

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ workspace: dir, ...liveness }) + '\n');
    return 0;
  }
  if (!dir) {
    process.stdout.write(
      theme.meta('no workspace here (no .musterd/binding.json on the walk-up)') + '\n',
    );
    return 0;
  }
  process.stdout.write(`${theme.accent('session')} — ${dir}\n`);
  // ADR 166 inc 2: the verdict can be enumerated with no slot capture at all — say what the
  // harness's own session files show before (or instead of) describing the capture.
  if (liveness.source === 'enumerated' && liveness.enumerated) {
    const e = liveness.enumerated;
    process.stdout.write(
      `  ${theme.meta('sessions')} ${e.count} on disk` +
        (e.id !== undefined ? `  ${theme.meta('newest')} ${e.id}` : '') +
        (e.mtime !== undefined ? ` (touched ${clock(e.mtime)})` : '') +
        '\n',
    );
  }
  const s = liveness.session;
  if (!s) {
    process.stdout.write(
      theme.meta(
        'no captured session — start a harness session here (the SessionStart hook captures it), ' +
          'or run `musterd init --check` if hooks may be missing',
      ) + '\n',
    );
    return writeVerdict(liveness);
  }
  process.stdout.write(
    `  ${theme.meta('harness')} ${s.harness}  ${theme.meta('id')} ${s.id}\n` +
      `  ${theme.meta('started')} ${clock(s.started_at)}` +
      (s.ended_at !== undefined ? `  ${theme.meta('ended')} ${clock(s.ended_at)}` : '') +
      '\n',
  );
  if (s.transcript_path) {
    const size =
      liveness.transcriptBytes !== undefined
        ? `${(liveness.transcriptBytes / 1024).toFixed(0)} KiB`
        : 'missing';
    const touched =
      liveness.transcriptMtime !== undefined ? `touched ${clock(liveness.transcriptMtime)}` : '';
    process.stdout.write(
      `  ${theme.meta('transcript')} ${s.transcript_path} (${size}) ${touched}\n`,
    );
  }
  writeVerdict(liveness);
  // `--seat`-style flags are meaningless here; nudge a confused caller toward the right verb.
  if (flagStr(parsed.flags, 'seat')) {
    process.stdout.write(
      theme.meta(
        '(session show reads THIS workspace; for enrollment state use `musterd residency status`)',
      ) + '\n',
    );
  }
  return 0;
}
