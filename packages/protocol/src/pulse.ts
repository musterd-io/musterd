/**
 * The seat pulse (ADR 660) — a seat's harness tool-call cadence as counts and kinds only.
 *
 * Both halves of the heartbeat share this arithmetic: the daemon projects a `seat_pulse` frame
 * from the ADR 445 trace rows it just ingested, and the eval in ADR 660 §Observability runs the same
 * projection over `trace.db` offline. Nothing here reads a body, a path or a command — the fold's
 * only input is the structural tool name `structuralToolName` already stored, and the projection's
 * only inputs are `tool_use_id`, `ts` and the folded kind.
 */
import { type PulseKind } from './frames.js';
import { TRACE_TOOL_NAMESPACES } from './traceSync.js';

/** The trailing window a pulse's `intensity` counts over. */
export const PULSE_WINDOW_MS = 60_000;

export type { PulseKind };

/** One counted call: a `PostToolUse` / `PostToolUseFailure` row with a `tool_use_id`. */
export interface PulseInput {
  tool_use_id: string;
  ts: number;
  kind: PulseKind | null;
}

export interface Pulse {
  /** Distinct `tool_use_id`s in the window. */
  intensity: number;
  /** Kind of the latest call in the window that had one; null when none did. */
  kind: PulseKind | null;
  /** `ts` of that call, 0 when `kind` is null. */
  last_ts: number;
}

/**
 * The fold, per harness, over the names `TRACE_TOOL_NAMESPACES` admits. Three sets each: everything
 * else — musterd's own `mcp__*` tools, plan/todo/image tools, `other` — folds to null and still
 * counts in `intensity`. `test` is never produced here: no structural row says a shell call was a
 * test run (spec §3.4 — a client-side classifier, later).
 */
const FOLD: Record<
  string,
  { read: readonly string[]; edit: readonly string[]; run: readonly string[] }
> = {
  'claude-code': {
    read: ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoRead'],
    edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    run: ['Bash', 'BashOutput', 'KillShell', 'Monitor', 'Agent', 'Task'],
  },
  codex: {
    read: ['web_search', 'view_image'],
    edit: ['apply_patch'],
    run: ['Bash', 'Shell', 'exec_command', 'write_stdin', 'webrun'],
  },
  cursor: {
    read: ['Read', 'Grep', 'Glob', 'Search', 'ListDir', 'WebFetch', 'WebSearch'],
    edit: ['Write', 'Edit', 'Delete'],
    run: ['Bash', 'Shell', 'Task'],
  },
  opencode: {
    read: ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch'],
    edit: ['write', 'edit', 'patch', 'multiedit'],
    run: ['bash', 'task'],
  },
  grok: {
    read: ['read_file', 'glob', 'grep', 'list_dir', 'web_search', 'browse'],
    edit: ['write_file', 'edit_file'],
    run: ['bash'],
  },
};

const KIND_BY_NAME: ReadonlyMap<string, ReadonlyMap<string, PulseKind>> = new Map(
  Object.entries(FOLD).map(([harness, sets]) => {
    const m = new Map<string, PulseKind>();
    for (const n of sets.read) m.set(n, 'read');
    for (const n of sets.edit) m.set(n, 'edit');
    for (const n of sets.run) m.set(n, 'run');
    return [harness, m];
  }),
);

/** Every harness the fold knows is one the namespace table knows — the test pins the converse per name. */
export const PULSE_FOLD_HARNESSES: readonly string[] = Object.keys(FOLD).filter(
  (h) => h in TRACE_TOOL_NAMESPACES,
);

export function foldPulseKind(harness: string, structuralName: string): PulseKind | null {
  return KIND_BY_NAME.get(harness)?.get(structuralName) ?? null;
}

export function projectPulse(window: readonly PulseInput[], now: number): Pulse {
  const floor = now - PULSE_WINDOW_MS;
  const seen = new Set<string>();
  let kind: PulseKind | null = null;
  let last_ts = 0;
  for (const c of window) {
    // A producer clock ahead of the daemon's reads as "just now", never as dropped.
    if (c.ts < floor) continue;
    seen.add(c.tool_use_id);
    if (c.kind !== null && c.ts >= last_ts) {
      kind = c.kind;
      last_ts = c.ts;
    }
  }
  return { intensity: seen.size, kind, last_ts };
}
