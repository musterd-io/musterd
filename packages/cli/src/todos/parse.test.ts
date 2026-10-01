import { describe, expect, it } from 'vitest';
import { EMPTY_TODO_STATE, foldTodos, unfinishedTodos } from './parse.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';
const use = (name: string, input: unknown, id = 'tu1') =>
  line({ message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, text: string) =>
  line({ message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

describe('foldTodos — Claude Code (ADR 487 §5.2)', () => {
  it('TodoWrite is the whole list: the last call wins and completed items drop out', () => {
    let s = foldTodos(
      EMPTY_TODO_STATE,
      'claude-code',
      use('TodoWrite', {
        todos: [
          { content: 'write the parser', status: 'in_progress' },
          { content: 'wire the hook', status: 'pending' },
        ],
      }),
    );
    s = foldTodos(
      s,
      'claude-code',
      use('TodoWrite', {
        todos: [
          { content: 'write the parser', status: 'completed' },
          { content: 'wire the hook', status: 'in_progress' },
        ],
      }),
    );
    expect(unfinishedTodos(s)).toEqual(['wire the hook']);
  });

  it('Task tools fold incrementally across deltas: the id arrives in the create result', () => {
    let s = foldTodos(EMPTY_TODO_STATE, 'claude-code', use('TaskCreate', { subject: 'gate' }, 'a'));
    s = foldTodos(s, 'claude-code', result('a', 'Task #1 created successfully: gate'));
    s = foldTodos(s, 'claude-code', use('TaskCreate', { subject: 'docs' }, 'b'));
    s = foldTodos(s, 'claude-code', result('b', 'Task #2 created successfully: docs'));
    expect(unfinishedTodos(s)).toEqual(['gate', 'docs']);
    s = foldTodos(s, 'claude-code', use('TaskUpdate', { taskId: '1', status: 'completed' }));
    s = foldTodos(s, 'claude-code', use('TaskUpdate', { taskId: '2', status: 'deleted' }));
    expect(unfinishedTodos(s)).toEqual([]);
  });

  it('skips a delta naming no to-do tool without touching the state', () => {
    const s = foldTodos(EMPTY_TODO_STATE, 'claude-code', use('Bash', { command: 'ls' }));
    expect(s).toBe(EMPTY_TODO_STATE);
  });

  it('bounds titles and count, and survives garbage lines', () => {
    const long = 'x'.repeat(500);
    const todos = Array.from({ length: 30 }, (_, i) => ({
      content: `${i} ${long}`,
      status: 'pending',
    }));
    const s = foldTodos(
      EMPTY_TODO_STATE,
      'claude-code',
      'not json\n' + use('TodoWrite', { todos }),
    );
    const out = unfinishedTodos(s);
    expect(out).toHaveLength(20);
    expect(out[0]!.length).toBe(140);
  });
});

describe('foldTodos — Codex update_plan', () => {
  it('reads the plan from the function_call arguments string', () => {
    const s = foldTodos(
      EMPTY_TODO_STATE,
      'codex',
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({
            plan: [
              { step: 'read the spec', status: 'completed' },
              { step: 'build the fold', status: 'in_progress' },
            ],
          }),
        },
      }),
    );
    expect(unfinishedTodos(s)).toEqual(['build the fold']);
  });
});
