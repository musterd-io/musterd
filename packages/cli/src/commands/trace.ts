import { TraceEventKindSchema, type TraceSessionEvent } from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { findBinding } from '../config.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { writeIdleWakeState } from '../idleWake/state.js';
import { theme } from '../render/theme.js';
import { sessionDigest } from '../session/digest.js';
import { snapshotTodos } from '../todos/snapshot.js';
import { tapHook } from '../trace/hook.js';
import { tailOpencodeSession } from '../trace/opencode.js';
import { subagentTranscriptPathFor, tailTranscript } from '../trace/tail.js';
import { findWorkspaceDir, resolveRead } from './helpers.js';

/**
 * `musterd trace` — the trace tap's CLI surface (ADR 445).
 *
 * `trace hook --stdin [--harness <id>] [--kind <TraceEventKind>]` — the standalone hook tap
 * (increment 1a), registered on the Claude Code events no existing musterd hook already rides:
 * `UserPromptSubmit`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`.
 * The events that already spawn a musterd process (PreToolUse → gate, PostToolUse → interrupt
 * probe, SessionStart/End → capture) tap from inside those commands instead, so the per-call cost
 * stays what the gate costs now (ADR 445 §Consequences). On `Stop` and `SessionEnd` the same
 * process also runs the rail R2 transcript tail (increment 2): the turn just ended, so its
 * reasoning and usage are on disk, and this is the delta read that picks them up.
 *
 * Exit code for `hook` is always 0. A hook that can fail a turn is a regression; this one records
 * or it does not, and says nothing either way.
 *
 * `trace show [<session-id | digest>]` — one session end to end (increment 2): rail R1 hook events
 * and rail R2 transcript records interleaved in daemon sequence order. With no argument, the
 * workspace's captured session. A raw harness session id is digested locally with the workspace's
 * agent key — the id itself never crosses the wire (ADR 131 §5).
 */
/**
 * The flags `musterd trace` takes (lane
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
export const TRACE_FLAGS = [
  'cache',
  'completed',
  'data',
  'downgraded',
  'end',
  'error',
  'harness',
  'hex',
  'hook',
  'input',
  'kind',
  'metadata',
  'model',
  'openai',
  'output',
  'read',
  'reason',
  'reasoning',
  'sha256',
  'start',
  'text',
  'time',
  'tokens',
  'total',
  'type',
  'utf8',
  'write',
] as const;

export async function traceCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...TRACE_FLAGS],
    'the flags `musterd trace` takes are listed by `musterd help trace`',
  );
  const sub = parsed.positionals[0];
  if (sub === 'show') return traceShow(parsed);
  if (sub !== 'hook') {
    throw new CliError(
      'usage: musterd trace hook --stdin  |  musterd trace show [<session-id | digest>]',
      2,
    );
  }
  if (parsed.flags['stdin'] !== true) {
    throw new CliError('usage: musterd trace hook --stdin — pipe the hook JSON in', 2);
  }
  try {
    const raw = await readHookStdin();
    const kindFlag = flagStr(parsed.flags, 'kind');
    const kind = kindFlag ? TraceEventKindSchema.safeParse(kindFlag) : undefined;
    const dir = findWorkspaceDir() ?? process.cwd();
    const binding = findBinding(dir);
    const harness = flagStr(parsed.flags, 'harness') ?? 'claude-code';
    noteTurnMarker(raw, dir); // ADR 558 — the idle-wake turn markers ride the same tap
    await tapHook(raw, {
      binding,
      dir,
      harness,
      ...(kind?.success ? { kind: kind.data } : {}),
    });
    await tailAfterHook(raw, {
      binding,
      dir,
      harness,
      kind: kind?.success ? kind.data : undefined,
    });
  } catch {
    // fail-open by contract
  }
  return 0;
}

/**
 * ADR 558: the idle-wake turn markers. `UserPromptSubmit` → `last_prompt_at`, `Stop` →
 * `last_stop_at`, keyed to the payload's session, in the workspace's `.musterd/idle-wake.json`.
 * The MCP adapter reads them to tell "idle at the prompt" from "mid-turn" and to keep an inject
 * off a prompt the human just typed. Local and before the network tap, so a daemon that is down
 * still leaves the evidence.
 */
export function noteTurnMarker(raw: string, dir: string, now = Date.now()): void {
  try {
    const p = JSON.parse(raw) as { hook_event_name?: unknown; session_id?: unknown };
    if (typeof p.session_id !== 'string' || !p.session_id) return;
    if (p.hook_event_name === 'UserPromptSubmit')
      writeIdleWakeState(dir, { session_id: p.session_id, last_prompt_at: now });
    else if (p.hook_event_name === 'Stop')
      writeIdleWakeState(dir, { session_id: p.session_id, last_stop_at: now });
  } catch {
    /* fail-open by contract */
  }
}

/**
 * Rail R2 rides the turn-boundary hooks: after the tap, a `Stop` or `SessionEnd` payload that
 * names a transcript runs the delta read, and a `SubagentStop` payload reads that subagent's
 * sidechain transcript (lane 01M4VTRMXYZ). Bounded and silent like the tap itself.
 */
async function tailAfterHook(
  raw: string,
  opts: {
    binding: ReturnType<typeof findBinding>;
    dir: string;
    harness: string;
    kind?: string | undefined;
  },
): Promise<void> {
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== 'object' || o === null) return;
    const payload = o as Record<string, unknown>;
    const rawKind = opts.kind ?? payload['hook_event_name'] ?? payload['hookEventName'];
    const kind = rawKind === 'subagentStop' ? 'SubagentStop' : rawKind;
    const sessionId =
      typeof payload['session_id'] === 'string' && payload['session_id']
        ? payload['session_id']
        : typeof payload['sessionId'] === 'string' && payload['sessionId']
          ? payload['sessionId']
          : typeof payload['conversation_id'] === 'string' && payload['conversation_id']
            ? payload['conversation_id']
            : undefined;
    if (kind === 'SubagentStop') {
      if (!sessionId) return;
      const sub = subagentTranscriptPathFor({
        ...(typeof payload['agent_id'] === 'string' ? { agent_id: payload['agent_id'] } : {}),
        ...(typeof payload['subagent_id'] === 'string'
          ? { subagent_id: payload['subagent_id'] }
          : {}),
        ...(typeof payload['agent_transcript_path'] === 'string'
          ? { agent_transcript_path: payload['agent_transcript_path'] }
          : {}),
        ...(typeof payload['subagent_transcript_path'] === 'string'
          ? { subagent_transcript_path: payload['subagent_transcript_path'] }
          : {}),
        ...(typeof payload['transcript_path'] === 'string'
          ? { transcript_path: payload['transcript_path'] }
          : {}),
      });
      if (!sub) return;
      await tailTranscript({
        binding: opts.binding,
        dir: opts.dir,
        harness: opts.harness,
        sessionId,
        transcriptPath: sub.transcriptPath,
        agentId: sub.agentId,
      });
      return;
    }
    if (kind !== 'Stop' && kind !== 'SessionEnd') return;
    // OpenCode keeps no transcript file; its R2 reads the session store instead (opencode.ts).
    if (opts.harness === 'opencode') {
      if (sessionId) {
        await tailOpencodeSession({ binding: opts.binding, dir: opts.dir, sessionId });
      }
      return;
    }
    const transcriptPath = payload['transcript_path'];
    if (!sessionId) return;
    if (typeof transcriptPath !== 'string' || !transcriptPath) return;
    await tailTranscript({
      binding: opts.binding,
      dir: opts.dir,
      harness: opts.harness,
      sessionId,
      transcriptPath,
    });
    // ADR 487 §5.2: the same turn-boundary read carries the unfinished-to-do snapshot.
    await snapshotTodos({
      binding: opts.binding,
      dir: opts.dir,
      harness: opts.harness,
      transcriptPath,
    });
  } catch {
    /* fail-open by contract */
  }
}

async function traceShow(parsed: Parsed): Promise<number> {
  const dir = findWorkspaceDir() ?? process.cwd();
  const binding = findBinding(dir);
  const arg = parsed.positionals[1];
  let digest: string;
  if (arg && /^[0-9a-f]{8,32}$/.test(arg)) {
    digest = arg;
  } else {
    const sessionId = arg ?? binding?.session?.id;
    if (!sessionId) {
      throw new CliError(
        'no session — pass a harness session id or digest, or run from a workspace with a captured session',
        2,
      );
    }
    if (!binding?.agent_key) {
      throw new CliError(
        'this workspace has no agent key, so a raw session id cannot be digested — pass the digest instead',
        2,
      );
    }
    digest = sessionDigest(binding.agent_key, sessionId);
  }
  const { team, http } = resolveRead(parsed.flags);
  const { events } = await http.getTraceSession(team, digest);
  if (parsed.flags['json'] === true) {
    process.stdout.write(JSON.stringify({ digest, events }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(renderTraceSession(digest, events) + '\n');
  return 0;
}

const clockSec = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** First line of a content field, bounded — a preview, never the record. */
function preview(text: unknown, max = 96): string {
  if (typeof text !== 'string' || !text) return '';
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** One row's right-hand cell: what happened, in the kind's own vocabulary. */
export function traceEventSummary(e: TraceSessionEvent): string {
  const d = e.detail ?? {};
  const agentTag = subagentSummaryTag(e.agent_id, d['agent_type']);
  if (e.kind === 'usage') {
    const parts: string[] = [];
    const inTok = num(d['input_tokens']);
    const outTok = num(d['output_tokens']);
    const cache = num(d['cache_read_tokens']);
    if (inTok !== undefined) parts.push(`in ${inTok}`);
    if (cache !== undefined && cache > 0) parts.push(`cache ${cache}`);
    if (outTok !== undefined) parts.push(`out ${outTok}`);
    const model = typeof d['model'] === 'string' ? d['model'] : undefined;
    return [parts.join(' · '), model, agentTag].filter(Boolean).join('  ');
  }
  if (e.kind === 'reasoning' || e.kind === 'assistant_text') {
    const text = preview(e.content?.[e.kind === 'reasoning' ? 'reasoning' : 'assistant']);
    if (text) return [text, agentTag].filter(Boolean).join(' · ');
    const size = num(d[e.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']);
    const why = typeof e.content_pruned_at === 'number' ? 'content pruned' : 'structural';
    const base =
      size !== undefined
        ? `${size} bytes (${why})`
        : typeof e.content_pruned_at === 'number'
          ? '(content pruned)'
          : '';
    return [base, agentTag].filter(Boolean).join(' · ');
  }
  if (e.kind === 'unknown') {
    const type = typeof d['type'] === 'string' ? d['type'] : 'unparsed';
    return d['downgraded'] === true ? `DOWNGRADED — ${String(d['reason'] ?? '')}` : type;
  }
  if (e.kind === 'HookOutcome') {
    const hook = typeof d['hook'] === 'string' ? d['hook'] : '';
    return [hook, e.outcome ?? ''].filter(Boolean).join(' · ');
  }
  const bits: string[] = [];
  if (e.tool_name) bits.push(e.tool_name);
  if (typeof e.duration_ms === 'number') bits.push(`${e.duration_ms}ms`);
  if (e.outcome && e.outcome !== 'ok') bits.push(e.outcome);
  if (agentTag) bits.push(agentTag);
  return bits.join(' · ');
}

function subagentSummaryTag(agentId: string | null | undefined, agentType: unknown): string {
  const type = typeof agentType === 'string' && agentType ? agentType : undefined;
  if (type && agentId) return `${type} (${agentId})`;
  if (type) return type;
  if (agentId) return `agent ${agentId}`;
  return '';
}

/** The whole-session render: a header, then one line per event in sequence order. */
export function renderTraceSession(digest: string, events: TraceSessionEvent[]): string {
  if (events.length === 0) {
    return theme.meta(`session ${digest} — no trace events (not recorded, or not yours to read)`);
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const spanMs = last.ts - first.ts;
  const spanMin = Math.round(spanMs / 60_000);
  const lines: string[] = [
    theme.bold(`session ${digest}`) +
      theme.meta(
        `  ${first.harness} · seat ${first.seat} · ${events.length} events · ` +
          (spanMin > 0 ? `${spanMin}m` : `${Math.max(1, Math.round(spanMs / 1000))}s`),
      ),
  ];
  for (const e of events) {
    const kindLabel =
      e.kind === 'reasoning' || e.kind === 'assistant_text' || e.kind === 'usage'
        ? theme.dim(e.kind.padEnd(18))
        : e.kind === 'unknown'
          ? theme.warn(e.kind.padEnd(18))
          : e.kind.padEnd(18);
    const summary = traceEventSummary(e);
    lines.push(
      `${theme.meta(String(e.seq).padStart(5))} ${theme.meta(clockSec(e.ts))} ${kindLabel} ${
        e.kind === 'reasoning' || e.kind === 'assistant_text' ? theme.dim(summary) : summary
      }`.trimEnd(),
    );
  }
  return lines.join('\n');
}
