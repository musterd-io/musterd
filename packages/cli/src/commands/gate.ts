import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  type ActorAttestation,
  CCD_SEND_MESSAGE_TOOL,
  type EnforcementMatch,
  type EnforcementPolicy,
  EnforcementPolicySchema,
  extractUlid,
  type GateToolCall,
  isMergeShapedCommand,
  isSessionReachTool,
  isWriteShaped,
  matchEnforcement,
  pushSpec,
  SUBAGENT_CHANNEL_TOOLS,
  textFingerprint,
} from '@musterd/protocol';
import { gitOutput } from '@musterd/protocol/project';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { HOOK_HTTP_TIMEOUT_MS, type HttpClient, isDaemonUnreachable } from '../client.js';
import { findBinding } from '../config.js';
import { CliError, isConnRefused } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { yieldDenyReason } from '../launcher/yield.js';
import { inferPayloadHarness, tapHook } from '../trace/hook.js';
import {
  isStageShaped,
  markSessionStart,
  pathsPredatingSession,
  sessionStartedAt,
  stalePathWarning,
} from '../workingTree.js';
import { harnessFromEnv, resolveRead } from './helpers.js';
import { isOwnSubagent, recordSubagent, spawnedAgentId } from './subagentLedger.js';

/**
 * `musterd gate check --stdin` (ADR 150 — structural inducement) — the PreToolUse enforcement gate.
 * A Claude Code PreToolUse hook pipes its `{tool_name, tool_input}` JSON in; this decides whether the
 * tool call proceeds. The whole path is **fail-open and best-effort**, exactly like the ADR 088
 * interrupt probe: any missing input, unbound folder, unreachable daemon, or unexpected error exits 0
 * (allow). An unfinished or unreachable gate must NEVER wedge a tool call — the ADR's guard metric.
 *
 * The flow keeps the common case free: the class table is matched CLIENT-side (one member-authed GET),
 * and an **undeclared** call returns before any POST — the overwhelming majority of tool calls incur one
 * cheap loopback GET and nothing else. Only a MATCHED call round-trips to `POST /gate`, where the daemon
 * adjudicates atomically and records the shapes-only decision row. The raw command/path used to match
 * never leaves the client except, on a match, as the `target` the daemon needs for the decision + a Gate
 * B ask body (never an audit row, ADR 051).
 */
/**
 * The flags `musterd gate` takes (lane
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
 * The flags `musterd gate` takes (lane
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
export const GATE_FLAGS = [
  '-',
  '--',
  '--all',
  '--porcelain',
  '-a',
  'a',
  'command',
  'data',
  'end',
  'error',
  'git',
  'ignore',
  'message',
  'model',
  'path',
  'recipient',
  'status',
  'to',
  'u',
  'utf8',
] as const;

export async function gateCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...GATE_FLAGS],
    'the flags `musterd gate` takes are listed by `musterd help gate`',
  );
  const sub = parsed.positionals[0];
  if (sub === 'check') return gateCheck(parsed);
  if (sub === 'record-subagent') return recordSubagentCommand();
  if (sub === 'record-push') return recordPushCommand();
  throw new CliError(
    'usage: musterd gate check --stdin  — hook-driven (a PreToolUse hook pipes the tool call in); ' +
      '`musterd init` provisions the hook',
    2,
  );
}

const readStdin = readHookStdin;

/**
 * Extract the gate's view of a Claude Code PreToolUse payload: the tool name, and either its target
 * path (`file_path`/`notebook_path` — Edit/Write/MultiEdit/NotebookEdit) or its command (Bash). Returns
 * null when there's nothing gate-relevant to match on (so the caller allows). Lenient — unknown fields
 * ignored, unknown tools yield a call with neither path nor command (never matches → allow).
 */
export function parseToolCall(raw: string): GateToolCall | null {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return null;
    const o = json as Record<string, unknown>;
    const rawTool =
      typeof o['tool_name'] === 'string'
        ? o['tool_name']
        : typeof o['toolName'] === 'string'
          ? o['toolName']
          : undefined;
    if (!rawTool) return null;
    const inputRaw =
      typeof o['tool_input'] === 'object' && o['tool_input'] !== null
        ? (o['tool_input'] as Record<string, unknown>)
        : typeof o['toolInput'] === 'object' && o['toolInput'] !== null
          ? (o['toolInput'] as Record<string, unknown>)
          : {};
    // Tool aliases: map other harnesses onto the class-table vocabulary Claude already uses.
    // - Grok CLI (ADR 352)
    // - Cursor Agent (ADR 369)
    const toolAlias: Record<string, string> = {
      run_terminal_command: 'Bash',
      search_replace: 'Edit',
      Shell: 'Bash',
      StrReplace: 'Edit',
      Delete: 'Write',
      Task: 'Agent',
    };
    const tool = toolAlias[rawTool] ?? rawTool;
    const input = inputRaw;
    const path =
      typeof input['file_path'] === 'string'
        ? input['file_path']
        : typeof input['notebook_path'] === 'string'
          ? input['notebook_path']
          : typeof input['target_file'] === 'string'
            ? input['target_file']
            : typeof input['path'] === 'string'
              ? input['path']
              : undefined;
    const command = typeof input['command'] === 'string' ? input['command'] : undefined;
    // ADR 163 — the payload ENVELOPE, not the tool input. `agent_id`/`agent_type` are present only on a
    // subagent's own tool calls and absent on the parent seat's; measured on Claude Code 2.1.220. On a
    // spawn call (`tool_name: Agent` / `Task`) the requested type + `model:` override live in tool_input
    // instead, and carry no agent_id — the two halves share no key, which is why nothing joins them here.
    const actorId =
      typeof o['agent_id'] === 'string'
        ? o['agent_id']
        : typeof o['subagent_id'] === 'string'
          ? o['subagent_id']
          : undefined;
    const actorType =
      typeof o['agent_type'] === 'string'
        ? o['agent_type']
        : typeof o['subagent_type'] === 'string'
          ? o['subagent_type']
          : undefined;
    const spawnType =
      typeof input['subagent_type'] === 'string'
        ? input['subagent_type']
        : typeof input['subagentType'] === 'string'
          ? input['subagentType']
          : undefined;
    const spawnModel = typeof input['model'] === 'string' ? input['model'] : undefined;
    const sendTo = typeof input['to'] === 'string' ? input['to'] : undefined;
    const sendRecipient = typeof input['recipient'] === 'string' ? input['recipient'] : undefined;
    const sendTarget = sendTo || sendRecipient || undefined;
    // ADR 167 — the harness session-messaging send. The raw body and raw target session id are reduced
    // to sha256-16 HERE, inside this frame, and never assigned onto the returned object: what the rest
    // of the pipeline never holds, it cannot leak (the body is another agent's incoming context, ADR
    // 128). Lenient like everything else — a shape change in the tool input degrades to a
    // fingerprint-less attestation, never a failure.
    const isSessionMsg = tool === CCD_SEND_MESSAGE_TOOL;
    const body =
      isSessionMsg && typeof input['message'] === 'string' ? input['message'] : undefined;
    const targetSession =
      isSessionMsg && typeof input['session_id'] === 'string' ? input['session_id'] : undefined;
    const nudgeRef = body ? extractUlid(body) : undefined;
    return {
      tool,
      ...(path ? { path } : {}),
      ...(command ? { command } : {}),
      ...(actorId ? { actorId } : {}),
      ...(actorType ? { actorType } : {}),
      ...(spawnType ? { spawnType } : {}),
      ...(spawnModel ? { spawnModel } : {}),
      ...(body ? { bodyFingerprint: textFingerprint(body) } : {}),
      ...(targetSession ? { sessionRef: textFingerprint(targetSession) } : {}),
      ...(nudgeRef ? { nudgeRef } : {}),
      ...(sendTarget ? { sendTarget } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The harness session id off the payload **envelope** (not `tool_input` — that slot belongs to the
 * ADR 167 send target). Measured present on every PreToolUse payload in ADR 163's table, alongside
 * `transcript_path` and `cwd`. Used only to key the ADR 239 per-session edit index, which never
 * leaves the machine — the id is deliberately not returned on `GateToolCall`, so nothing that goes
 * over the wire can pick it up.
 */
export function parseEnvelopeSessionId(raw: string): string | undefined {
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) return undefined;
    const o = json as Record<string, unknown>;
    const id = typeof o['session_id'] === 'string' ? o['session_id'] : o['sessionId'];
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace's musterd state dir. The PreToolUse hook `cd`s to the project root before running
 *  (see {@link repoRelativePath}), and `musterd init` gitignores `.musterd/`. */
function stateDir(): string {
  return join(process.cwd(), '.musterd');
}

const SESSION_REACH_DENY =
  'musterd seats may not reach other sessions (ADR 442). Directed acts reach teammates through ' +
  'team_send; a human is reached through their musterd surfaces, never a harness session.';

/**
 * The wall (ADR 442). Returns the deny reason, or null to allow. A seat Workspace refuses every
 * session-reaching tool except `SendMessage` aimed at a subagent this session spawned. An unbound
 * folder is outside the gate's jurisdiction.
 */
export function sessionReachReason(
  call: GateToolCall,
  sessionId: string | undefined,
  bound: boolean,
  state: string,
): string | null {
  if (!bound || !isSessionReachTool(call.tool)) return null;
  const scoped = (SUBAGENT_CHANNEL_TOOLS as readonly string[]).includes(call.tool);
  if (scoped && sessionId && call.sendTarget && isOwnSubagent(state, sessionId, call.sendTarget)) {
    return null;
  }
  return SESSION_REACH_DENY;
}

/**
 * ADR 501: the daemon's halted refusal ("halted by <human>: <reason>", a `forbidden` from member
 * auth) becomes the PreToolUse deny reason, with the lift named. Anything else — another
 * `forbidden`, an unreachable daemon, a non-CLI error — is null, and the gate keeps failing open.
 */
export function haltDenyReason(err: unknown, seat: string | undefined): string | null {
  if (!(err instanceof CliError) || err.code !== 'forbidden') return null;
  if (!err.message.startsWith('halted by ')) return null;
  return `${err.message} — a human lifts it with \`musterd resume ${seat ?? '<seat>'}\``;
}

/* ───────────── ADR 674 (Cloud 4 §4.7) — 60s enforcement cache & outage posture ───────────── */

/** ADR 674: how long a cached enforcement table is served before refreshing from the server. */
export const ENFORCEMENT_CACHE_TTL_MS = 60_000;
export const ENFORCEMENT_CACHE_FILE = 'enforcement-cache.json';
export const UNENFORCED_COUNTER_FILE = 'gate-unenforced.json';

export interface CachedEnforcement {
  team: string;
  server: string;
  fetched_at: number;
  enforcement: EnforcementPolicy;
}

export interface UnenforcedCounter {
  count: number;
  since_ts: number;
  until_ts: number;
}

/** Read `.musterd/enforcement-cache.json` for `(team, server)`, or null if missing/mismatched. */
export function readEnforcementCache(
  dir: string,
  team: string,
  server?: string,
): CachedEnforcement | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ENFORCEMENT_CACHE_FILE), 'utf8')) as {
      team?: unknown;
      server?: unknown;
      fetched_at?: unknown;
      enforcement?: unknown;
    };
    if (raw.team !== team) return null;
    if (server !== undefined && typeof raw.server === 'string' && raw.server !== server) {
      return null;
    }
    if (typeof raw.fetched_at !== 'number' || !Number.isFinite(raw.fetched_at)) return null;
    const parsed = EnforcementPolicySchema.safeParse(raw.enforcement);
    if (!parsed.success) return null;
    return {
      team,
      server: typeof raw.server === 'string' ? raw.server : (server ?? ''),
      fetched_at: raw.fetched_at,
      enforcement: parsed.data,
    };
  } catch {
    return null;
  }
}

export function writeEnforcementCache(
  dir: string,
  team: string,
  server: string | undefined,
  enforcement: EnforcementPolicy,
  now: number = Date.now(),
): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ENFORCEMENT_CACHE_FILE),
      JSON.stringify({ team, server: server ?? '', fetched_at: now, enforcement }) + '\n',
    );
  } catch {
    /* best-effort cache */
  }
}

/** Read `.musterd/gate-unenforced.json`, or null when empty/missing. */
export function readUnenforcedCounter(dir: string): UnenforcedCounter | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, UNENFORCED_COUNTER_FILE), 'utf8')) as {
      count?: unknown;
      since_ts?: unknown;
      until_ts?: unknown;
    };
    if (typeof raw.count !== 'number' || raw.count < 1) return null;
    const since = typeof raw.since_ts === 'number' ? raw.since_ts : 0;
    const until = typeof raw.until_ts === 'number' ? raw.until_ts : since;
    return { count: Math.floor(raw.count), since_ts: since, until_ts: until };
  } catch {
    return null;
  }
}

/** Increment `.musterd/gate-unenforced.json` when a call proceeds unenforced during an outage. */
export function recordUnenforcedCall(dir: string, now: number = Date.now()): UnenforcedCounter {
  const prev = readUnenforcedCounter(dir);
  const next: UnenforcedCounter = prev
    ? { count: prev.count + 1, since_ts: prev.since_ts, until_ts: Math.max(prev.until_ts, now) }
    : { count: 1, since_ts: now, until_ts: now };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, UNENFORCED_COUNTER_FILE), JSON.stringify(next) + '\n');
  } catch {
    /* best-effort local counter */
  }
  return next;
}

export function clearUnenforcedCounter(dir: string): void {
  try {
    unlinkSync(join(dir, UNENFORCED_COUNTER_FILE));
  } catch {
    /* already absent */
  }
}

/**
 * The attestation and audit posts this process floated (lane 01M5G3J54H). `recordActor` is bounded
 * (HOOK_HTTP_TIMEOUT_MS) and swallows its own errors, so the posts never delay the decision — but
 * `exitAfterFlush` calls `process.exit` once stdout drains, which kills a request still in flight.
 * They used to survive only because the reachability nudge's inbox read held the process open after
 * every hook; `gateCheck` now settles them itself, after the decision is on stdout.
 */
const inFlight = new Set<Promise<unknown>>();
function track(p: Promise<unknown>): void {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}
export async function settleTracked(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

/** Flush any accumulated unenforced calls to `POST /teams/:slug/actor` on recovery. */
export function flushUnenforcedCounter(
  http: HttpClient,
  team: string,
  dir: string,
  tool: string,
): void {
  const pending = readUnenforcedCounter(dir);
  if (!pending) return;
  clearUnenforcedCounter(dir);
  track(
    http.recordActor(team, {
      kind: 'unenforced',
      tool,
      count: pending.count,
      since_ts: pending.since_ts,
      until_ts: pending.until_ts,
    }),
  );
}

/** Is this error an unreachable/unavailable team server (connection refused, timeout, or 5xx)? */
export function isGateServerUnreachable(err: unknown): boolean {
  if (isDaemonUnreachable(err) || isConnRefused(err)) return true;
  if (err instanceof CliError) {
    if (err.code === 'server_error') return true;
    if (/^server error \(5\d\d\)$/.test(err.message)) return true;
  }
  return false;
}

/**
 * ADR 674 (Cloud 4 §4.7): adjudicate a tool call when the team server cannot be reached.
 * - `block` posture or `costly-action` kind → fail closed (`deny` with `"gate unreachable"`).
 * - `warn` posture or unclassified → fail open and visibly (`unenforced` advisory in tool result).
 */
export function outageVerdictForMatch(match: EnforcementMatch | null): {
  decision: 'deny' | 'unenforced';
  reason: string;
} {
  if (match && (match.cls.posture === 'block' || match.cls.kind === 'costly-action')) {
    return {
      decision: 'deny',
      reason:
        `gate unreachable — '${match.cls.class}' requires server adjudication; ` +
        'wait for the team server or ask a human out of band.',
    };
  }
  if (match) {
    return {
      decision: 'unenforced',
      reason: `unenforced (gate unreachable): '${match.cls.class}' proceeded without server adjudication.`,
    };
  }
  return {
    decision: 'unenforced',
    reason:
      'unenforced (gate unreachable): tool call proceeded while the team server could not be reached.',
  };
}

/** PostToolUse `Agent` one-shot. Always exits 0 — a ledger miss must not break the spawn. */
async function recordSubagentCommand(): Promise<number> {
  try {
    const stdin = await readStdin();
    const sessionId = parseEnvelopeSessionId(stdin);
    const agentId = spawnedAgentId(stdin);
    if (sessionId && agentId) recordSubagent(stateDir(), sessionId, agentId);
    // ADR 163's spawn row, from the one hook that sees a Claude Code spawn (lane 01M4VTP73W). Awaited:
    // this is a one-shot process, and a floated request dies with it. Hook one-shot, so never reclaim.
    const att = spawnAttestation(stdin);
    if (att) {
      const { http, team, identity, explicit } = resolveRead(
        {},
        {
          claimSeatPerRequest: false,
          timeoutMs: HOOK_HTTP_TIMEOUT_MS,
        },
      );
      if (explicit && identity) await http.recordActor(team, att);
    }
  } catch {
    // Always exit 0.
  }
  return 0;
}

/**
 * ADR 730 §1 — what a Bash PostToolUse payload says was pushed, or null. The command names the
 * remote and the refspecs (`pushSpec`); the working tree names the branch and HEAD (`gitHere`). The
 * push is reported only when the command pushed the current branch — no refspec (push.default),
 * `--all`, or a refspec whose source is the branch, `HEAD` or `refs/heads/<branch>` and whose
 * destination, when given, is the branch again — and `refs/remotes/<remote>/<branch>` is at HEAD,
 * git's own record that it landed. A failed push, a dry run, a delete, a pushed detached HEAD, or a
 * push of some other branch (even from a branch already up to date on the remote — big-body's
 * decline, 2026-10-25) reports nothing. When the harness payload carries an exit code or an
 * interrupted flag, a non-zero or interrupted command reports nothing either. One `rev-parse`
 * beyond `gitHere`'s, and only on a `git push`.
 */
export function pushReportFor(
  stdin: string,
  cwd: string,
): { remote: string; branch: string; head: string } | null {
  const call = parseToolCall(stdin);
  if (!call || call.tool !== 'Bash' || call.command === undefined) return null;
  if (commandFailed(stdin)) return null;
  const spec = pushSpec(call.command);
  if (!spec || spec.del) return null;
  const { git_branch: branch, git_head: head } = gitHere(cwd);
  if (!branch || !head) return null;
  if (
    !spec.all &&
    spec.refspecs.length > 0 &&
    !spec.refspecs.some((r) => refspecPushes(r, branch))
  ) {
    return null;
  }
  const tracking = gitOutput(
    ['rev-parse', '--verify', '-q', `refs/remotes/${spec.remote}/${branch}`],
    cwd,
  );
  if (!tracking || tracking.trim() !== head) return null;
  return { remote: spec.remote, branch, head };
}

/** `<src>[:<dst>]` moves `branch` on the remote: src is the branch (by name or as HEAD), dst too. */
function refspecPushes(refspec: string, branch: string): boolean {
  const [src, dst] = refspec.split(':', 2);
  const isBranch = (ref: string | undefined) => ref === branch || ref === `refs/heads/${branch}`;
  return (src === 'HEAD' || isBranch(src)) && (dst === undefined || isBranch(dst));
}

/** The harness's own verdict on the command, when its PostToolUse payload carries one. */
function commandFailed(raw: string): boolean {
  try {
    const o = JSON.parse(raw) as { tool_response?: unknown };
    const r = o.tool_response;
    if (typeof r !== 'object' || r === null) return false;
    const { exit_code, exitCode, interrupted } = r as Record<string, unknown>;
    if (interrupted === true) return true;
    const code = typeof exit_code === 'number' ? exit_code : exitCode;
    return typeof code === 'number' && code !== 0;
  } catch {
    return false;
  }
}

/** PostToolUse `Bash` one-shot (ADR 730). Always exits 0 — a missed push must not break the command. */
async function recordPushCommand(): Promise<number> {
  try {
    const stdin = await readStdin();
    const report = pushReportFor(stdin, process.cwd());
    if (!report) return 0;
    // Hook one-shot, so never reclaim the seat; awaited, because a floated request dies with the
    // process. The daemon decides which lane this is (the seat's contending lane on that branch).
    const { http, team, identity, explicit } = resolveRead(
      {},
      { claimSeatPerRequest: false, timeoutMs: HOOK_HTTP_TIMEOUT_MS },
    );
    if (explicit && identity) await http.reportPush(team, report);
  } catch {
    // Always exit 0.
  }
  return 0;
}

/**
 * The `actor.subagent_spawn` attestation for an Agent PostToolUse payload, or null for anything else
 * (ADR 163). Lane 01M4VTP73W, 2026-10-13: zero spawn rows had ever been written — {@link attest}
 * records one from `gate check`, but Claude Code's PreToolUse gate matcher never names `Agent`, so
 * only this PostToolUse hook sees a Claude Code spawn. Here the spawned id is known too (the tool
 * response carries it), so a spawn joins the write rows its agent later makes. Shapes only: the
 * requested type and `model:` override when given (absent means inherited, never guessed), never the
 * prompt. A spawn with no declared type is still a spawn.
 */
export function spawnAttestation(raw: string): ActorAttestation | null {
  const call = parseToolCall(raw);
  if (!call || call.tool !== 'Agent') return null;
  const actorId = spawnedAgentId(raw);
  return {
    kind: 'subagent-spawn',
    tool: 'Agent',
    ...(call.spawnType ? { spawnType: call.spawnType } : {}),
    ...(call.spawnModel ? { spawnModel: call.spawnModel } : {}),
    ...(actorId ? { actorId } : {}),
  };
}

/**
 * ADR 239 — the working-tree check, as decided by the 2026-08-06 verdict. Returns the advisory when
 * a stage-shaped command would sweep in paths last modified before this session began, and
 * `undefined` otherwise (the overwhelmingly common case, costing one regex and no subprocess).
 *
 * `git status --porcelain` is the only git command on this path and it is read-only: the ADR forbids
 * touching another session's uncommitted work, for which there is no reflog.
 */
export function workingTreeWarning(
  command: string | undefined,
  startedAt: number | undefined,
  justMarked: boolean,
): string | undefined {
  if (!command || startedAt === undefined || !isStageShaped(command)) return undefined;
  // A marker created by THIS very command knows nothing — everything on disk would predate it, so
  // the warning would name the whole tree. Silence beats an accusation built from no evidence.
  if (justMarked) return undefined;
  const stale = pathsPredatingSession(startedAt);
  return stale.length > 0 ? stalePathWarning(stale, command) : undefined;
}

/** Emit the PreToolUse deny control JSON. Claude Code reads `hookSpecificOutput`; Cursor Agent reads
 *  `permission: deny` and surfaces `user_message` / `agent_message` (ADR 369). */
function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

/** Surface a warn-posture advisory without blocking or auto-granting. `additionalContext` (Claude Code)
 *  and `additional_context` (Cursor Agent) proceed normally and best-effort add the note to the model's
 *  context; a harness build that ignores it simply proceeds silently (warn's guaranteed half is the
 *  server-side audit row, not this surface). */
function emitWarn(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      additional_context: reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason },
    }) + '\n',
  );
}

/**
 * Make a tool's target path repo-relative so it compares against the class table and lane globs, which
 * are declared repo-relative (`packages/server/src/**`). The PreToolUse hook `cd`s to the project root
 * before running, so `process.cwd()` is that root and an absolute `file_path` under it relativizes
 * cleanly. A path already relative, or absolute-but-outside the root (→ a leading `../`), is left as-is
 * (the latter simply won't match a repo glob — correctly ungated).
 */
export function repoRelativePath(path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/**
 * Decide whether this call deserves an actor row, and fire it off (ADR 163, increment 1; ADR 167 adds
 * the third shape). Three shapes qualify and nothing else:
 *
 * - a **spawn** (`tool_name: Agent`) — the denominator: how much fan-out is happening at all;
 * - a **write-shaped call carrying `actorId`** — a subagent wrote under its parent seat's identity;
 * - a **harness session-message send** (ADR 167) — a seat used the identityless side channel.
 *
 * Reads never qualify, which is the point: nick's rule blesses read-only fan-out, and an `Explore`
 * sweep's hundreds of reads would swamp the ledger for nothing. Returns immediately — the promise is
 * intentionally floated, and `recordActor` swallows its own errors.
 */
export function attest(http: HttpClient, team: string, call: GateToolCall): void {
  // ADR 442 folded ADR 167's session-message observer into the wall: a session-reaching send is
  // denied (and audited as session-denied) before attest runs. This function no longer records it.
  if (call.tool === 'Agent') {
    if (call.spawnType === undefined && call.spawnModel === undefined) return;
    track(
      http.recordActor(team, {
        kind: 'subagent-spawn',
        tool: call.tool,
        ...(call.spawnType ? { spawnType: call.spawnType } : {}),
        ...(call.spawnModel ? { spawnModel: call.spawnModel } : {}),
      }),
    );
    return;
  }
  if (call.actorId === undefined || !isWriteShaped(call)) return;
  track(
    http.recordActor(team, {
      kind: 'subagent-write',
      tool: call.tool,
      actorId: call.actorId,
      ...(call.actorType ? { actorType: call.actorType } : {}),
      ...((call.path ?? call.command) ? { target: call.path ?? call.command } : {}),
    }),
  );
}

/**
 * ADR 697 §1 — the branch and HEAD this edit is made on, so a lane learns its branch from its edits
 * and a hold's hand-over can say where the holder's work is. One `git rev-parse`; a detached HEAD
 * sends no branch, and anything that fails sends neither (never a reason to fail the edit).
 */
export function gitHere(cwd: string): { git_branch?: string; git_head?: string } {
  // `--abbrev-ref` applies to every rev after it, so the full HEAD goes first.
  const out = gitOutput(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], cwd);
  if (!out) return {};
  const [head, branch] = out.split('\n').map((l) => l.trim());
  return {
    ...(branch && branch !== 'HEAD' && branch.length <= 255 ? { git_branch: branch } : {}),
    ...(head && /^[0-9a-f]{7,64}$/.test(head) ? { git_head: head } : {}),
  };
}

async function gateCheck(parsed: Parsed): Promise<number> {
  if (parsed.flags['stdin'] !== true) {
    throw new CliError(
      'usage: musterd gate check --stdin  — hook-driven: pipe the PreToolUse hook JSON in ' +
        '(`musterd init` wires the hook)',
      2,
    );
  }
  let wtWarn: string | undefined;
  // The hook protocol reads ONE control object off stdout, so the two advisories share a slot: an
  // enforcement decision always wins it (a deny must never be swallowed), and the ADR 239 warning is
  // flushed afterwards only if nothing was emitted. Tracked locally — this process handles one call.
  let emitted = false;
  let seatName: string | undefined;
  // ADR 445 R1 — what the trace tap needs once the decision is made: the payload (names, ids and
  // sizes are all the tap reads of it) and how the gate ruled.
  let tapPayload: string | undefined;
  // Widened by hand: tsc cannot see the assignments inside `decide` and would narrow to 'allow'.
  let decision = 'allow' as 'allow' | 'deny' | 'warn' | 'unenforced';
  const decide = async (): Promise<void> => {
    const stdin = await readStdin();
    tapPayload = stdin;
    const raw = parseToolCall(stdin);
    if (!raw) return; // nothing to match on → allow
    // ADR 546 — a person took this wake over: stop at this tool boundary. Before the wall and any
    // daemon round trip, so nothing can delay it; purely local.
    const yielded = yieldDenyReason(process.cwd(), process.env);
    if (yielded) {
      emitDeny(yielded);
      emitted = true;
      decision = 'deny';
      return;
    }
    // Normalize the target path to repo-relative BEFORE matching, so class + lane globs compare cleanly.
    const call: GateToolCall = raw.path ? { ...raw, path: repoRelativePath(raw.path) } : raw;
    // ADR 442 — the wall is decided here, before the working-tree check and before any daemon
    // round trip. A throw below must not be what opens it.
    const sessionIdEarly = parseEnvelopeSessionId(stdin);
    const state = stateDir();
    const reason = sessionReachReason(call, sessionIdEarly, findBinding() !== null, state);
    if (reason) {
      emitDeny(reason);
      emitted = true;
      decision = 'deny';
      try {
        const { http, team } = resolveRead(parsed.flags, {
          claimSeatPerRequest: false,
          timeoutMs: HOOK_HTTP_TIMEOUT_MS,
        });
        track(
          http.recordActor(team, {
            kind: 'session-denied',
            tool: call.tool,
            ...(harnessFromEnv() ? { harness: harnessFromEnv() } : {}),
          }),
        );
      } catch {
        // The audit is best-effort; the deny above already stands.
      }
      return;
    }
    // ADR 239 — both halves of the working-tree check, before anything that can throw or round-trip.
    // Purely local: the index is a file in this workspace's `.musterd/`, and nothing here is sent.
    const sessionId = parseEnvelopeSessionId(stdin);
    if (sessionId) {
      // One marker per session, stamped on the first tool call the gate sees. `justMarked` is what
      // keeps a session whose very first call IS the `git add -A` from indicting the whole tree.
      const justMarked = markSessionStart(state, sessionId);
      wtWarn = workingTreeWarning(call.command, sessionStartedAt(state, sessionId), justMarked);
    }
    // Hook one-shot: never reclaim the seat — a gate rides EVERY tool call, and a reclaim here
    // evicts the live adapter's presence and kills its lease (see ResolveReadOptions).
    const { http, team, server, identity, explicit } = resolveRead(parsed.flags, {
      claimSeatPerRequest: false,
      timeoutMs: HOOK_HTTP_TIMEOUT_MS,
    });
    if (!explicit || !identity) return; // ambient/unbound folder — no seat to gate → allow
    seatName = identity.name;
    // ADR 163 — actor attestation, BEFORE the class table and independent of it. Deliberately not
    // awaited: nothing downstream reads the result, and an observer on the critical path would be the
    // latency tax the ADR's guard metric forbids. Fires on undeclared calls by design (ADR 150 §Gate B
    // as amended) — it cannot change whether the call proceeds, so it is not mediation.
    attest(http, team, call);
    // ADR 516 increment 2: a Team hold on merges stops a merge-shaped command before anything else,
    // and without any class declared — a hold is the Team's rule, not a policy knob. The local match
    // only decides whether to ask (so ordinary calls pay no round trip); the daemon re-tests the
    // command and decides. Unreachable → the catch below fails open, the ADR 150 posture.
    if (call.command !== undefined && isMergeShapedCommand(call.command)) {
      try {
        const held = await http.holdCheck(team, { tool: call.tool, command: call.command });
        if (held.decision === 'deny') {
          emitDeny(held.reason);
          emitted = true;
          decision = 'deny';
          return;
        }
      } catch (err) {
        const halted = haltDenyReason(err, seatName);
        if (halted) throw err;
        // Otherwise proceed to the enforcement table below.
      }
    }
    const now = Date.now();
    const cached = readEnforcementCache(state, team, server);
    let enforcement: EnforcementPolicy | undefined;
    let serverReachable = false;
    let serverOutage = false;
    if (
      cached &&
      now - cached.fetched_at < ENFORCEMENT_CACHE_TTL_MS &&
      !readUnenforcedCounter(state)
    ) {
      enforcement = cached.enforcement;
    } else {
      try {
        const res = await http.getEnforcement(team);
        enforcement = res.enforcement;
        serverReachable = true;
        writeEnforcementCache(state, team, server, enforcement, now);
      } catch (err) {
        if (!isGateServerUnreachable(err)) throw err;
        serverOutage = true;
        enforcement = cached?.enforcement;
      }
    }
    const match = enforcement ? matchEnforcement(enforcement, call) : null;
    if (serverOutage) {
      const outage = outageVerdictForMatch(match);
      if (outage.decision === 'deny') {
        emitDeny(outage.reason);
        emitted = true;
        decision = 'deny';
      } else {
        recordUnenforcedCall(state, now);
        emitWarn(outage.reason);
        emitted = true;
        decision = 'unenforced';
      }
      return;
    }
    if (!match) {
      if (serverReachable) flushUnenforcedCounter(http, team, state, call.tool);
      return; // undeclared call → allow, no daemon round-trip (the common case)
    }
    try {
      const verdict = await http.gateCheck(team, {
        kind: match.cls.kind,
        class: match.cls.class,
        fingerprint: match.fingerprint,
        posture: match.cls.posture,
        tool: call.tool,
        target: match.target,
        ...(match.cls.kind === 'contended-surface' ? gitHere(process.cwd()) : {}),
      });
      flushUnenforcedCounter(http, team, state, call.tool);
      if (verdict.decision === 'deny') {
        emitDeny(verdict.reason);
        emitted = true;
        decision = 'deny';
      } else if (verdict.outcome === 'warned' && verdict.reason) {
        emitWarn(verdict.reason);
        emitted = true;
        decision = 'warn';
      }
    } catch (err) {
      if (!isGateServerUnreachable(err)) throw err;
      const outage = outageVerdictForMatch(match);
      if (outage.decision === 'deny') {
        emitDeny(outage.reason);
        emitted = true;
        decision = 'deny';
      } else {
        recordUnenforcedCall(state, now);
        emitWarn(outage.reason);
        emitted = true;
        decision = 'unenforced';
      }
    }
  };
  try {
    await decide();
  } catch (err) {
    // ADR 501 Decision 4 — the ONE case where the gate stops failing open: the daemon refused this
    // seat at auth because a human halted it. The refusal is the deny, word for word, plus the lift.
    const halted = haltDenyReason(err, seatName);
    if (halted && !emitted) {
      emitDeny(halted);
      emitted = true;
      decision = 'deny';
    }
    // Otherwise fail-open: a gate must never break the tool call it rides on (ADR 150 guard metric).
  }
  // The ADR 239 advisory survives a failure above on purpose: an unreachable daemon is exactly when a
  // second session in the folder is least likely to be noticed any other way.
  if (wtWarn && !emitted) emitWarn(wtWarn);
  // ADR 445 R1 — the PreToolUse trace event and the gate's own HookOutcome, in ONE post, after the
  // decision is on stdout: it cannot change whether the call proceeds, and the payload's tool input
  // never leaves this process. Bounded and silent (TRACE_POST_BUDGET_MS); an unbound folder, a seat
  // with no credential, or MUSTERD_NO_TRACE=1 all make it a no-op. Harness: env first, then the
  // payload's spelling — Grok sets no env var the gate can read. On Grok the interrupt probe (no
  // matcher) records every PreToolUse, so the gate posts only its outcome — one row per call, not
  // two for a write.
  if (tapPayload) {
    const harness = harnessFromEnv() ?? inferPayloadHarness(tapPayload);
    await tapHook(tapPayload, {
      binding: findBinding(),
      dir: process.cwd(),
      harness,
      kind: 'PreToolUse',
      observed: harness !== 'grok',
      outcome: {
        hook: 'gate',
        outcome: decision === 'deny' ? 'denied' : decision === 'unenforced' ? 'unenforced' : 'ok',
        detail: { decision },
      },
    });
  }
  await settleTracked();
  return 0;
}
