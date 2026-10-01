import { LANE_TODO_MAX_CHARS, LANE_TODOS_MAX_ITEMS } from '@musterd/protocol';

/**
 * The to-do tools' own state, folded from a harness transcript (ADR 487 §5.2).
 *
 * Two harnesses, three tools:
 *   - Claude Code `TodoWrite` — `input.todos: [{content, status}]`, the WHOLE list each call, so the
 *     last call wins outright.
 *   - Claude Code `TaskCreate` / `TaskUpdate` — incremental: a create is `{subject}` and its id
 *     arrives in the tool result ("Task #3 created…"); an update is `{taskId, status?, subject?}`.
 *   - Codex `update_plan` — `arguments: '{"plan":[{step, status}]}'`, the whole plan each call.
 *
 * Cursor is not read: it registers no stop hook and keeps no transcript a hook can open
 * (ADR 487 Consequences, 2026-09-30). Measured the same day, none of these tools was called once
 * in 14 days on this team — this is insurance for other teams, kept cheap: a delta with none of the
 * tool names in it is skipped without parsing a line.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** The folded state carried between reads (the reads are deltas). Plain JSON on purpose. */
export interface TodoState {
  /** The last whole-list write (TodoWrite / update_plan), in order. */
  list: { title: string; status: TodoStatus }[] | null;
  /** Task-tool tasks by id, in creation order. */
  tasks: Record<string, { title: string; status: TodoStatus }>;
  /** Task creates waiting for the result that names their id, by tool_use id. */
  pending: Record<string, string>;
}

export const EMPTY_TODO_STATE: TodoState = { list: null, tasks: {}, pending: {} };

const TOOL_NAMES = /"(?:TodoWrite|TaskCreate|TaskUpdate|update_plan)"/;

function status(raw: unknown): TodoStatus {
  return raw === 'completed' || raw === 'in_progress' || raw === 'deleted' ? raw : 'pending';
}

function title(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > LANE_TODO_MAX_CHARS ? `${t.slice(0, LANE_TODO_MAX_CHARS - 1)}…` : t;
}

function record(o: unknown): Record<string, unknown> | null {
  return typeof o === 'object' && o !== null && !Array.isArray(o)
    ? (o as Record<string, unknown>)
    : null;
}

/** Fold one transcript delta into the state. Lines that are not to-do calls are ignored. */
export function foldTodos(state: TodoState, harness: string, delta: string): TodoState {
  if (!TOOL_NAMES.test(delta) && Object.keys(state.pending).length === 0) return state;
  const next: TodoState = {
    list: state.list,
    tasks: { ...state.tasks },
    pending: { ...state.pending },
  };
  for (const line of delta.split('\n')) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (harness === 'codex') foldCodex(next, o);
    else foldClaude(next, o);
  }
  return next;
}

function foldClaude(state: TodoState, o: unknown): void {
  const content = record(record(o)?.['message'])?.['content'];
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const b = record(raw);
    if (!b) continue;
    if (b['type'] === 'tool_use') {
      const input = record(b['input']) ?? {};
      if (b['name'] === 'TodoWrite' && Array.isArray(input['todos'])) {
        state.list = (input['todos'] as unknown[]).flatMap((t) => {
          const r = record(t);
          const name = title(r?.['content']);
          return name ? [{ title: name, status: status(r?.['status']) }] : [];
        });
      } else if (b['name'] === 'TaskCreate' && typeof b['id'] === 'string') {
        const name = title(input['subject'] ?? input['description']);
        if (name) state.pending[b['id']] = name;
      } else if (b['name'] === 'TaskUpdate') {
        const id = String(input['taskId'] ?? '');
        const task = state.tasks[id];
        if (!task) continue;
        const renamed = title(input['subject']);
        state.tasks[id] = {
          title: renamed ?? task.title,
          status: input['status'] !== undefined ? status(input['status']) : task.status,
        };
      }
    } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
      const name = state.pending[b['tool_use_id']];
      if (name === undefined) continue;
      delete state.pending[b['tool_use_id']];
      const m = /Task #(\w+)/.exec(JSON.stringify(b['content'] ?? ''));
      if (m) state.tasks[m[1]!] = { title: name, status: 'pending' };
    }
  }
}

function foldCodex(state: TodoState, o: unknown): void {
  const p = record(record(o)?.['payload']);
  if (!p || p['type'] !== 'function_call' || p['name'] !== 'update_plan') return;
  let args: unknown;
  try {
    args = typeof p['arguments'] === 'string' ? JSON.parse(p['arguments']) : p['arguments'];
  } catch {
    return;
  }
  const plan = record(args)?.['plan'];
  if (!Array.isArray(plan)) return;
  state.list = plan.flatMap((s) => {
    const r = record(s);
    const name = title(r?.['step']);
    return name ? [{ title: name, status: status(r?.['status']) }] : [];
  });
}

/** The unfinished titles the snapshot carries: not completed, not deleted, bounded. */
export function unfinishedTodos(state: TodoState): string[] {
  const all = [...(state.list ?? []), ...Object.values(state.tasks)];
  return all
    .filter((t) => t.status === 'pending' || t.status === 'in_progress')
    .map((t) => t.title)
    .slice(0, LANE_TODOS_MAX_ITEMS);
}
