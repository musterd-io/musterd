import { z } from 'zod';

const nonEmpty = z.string().min(1).max(4096);

const CodexHookInputSchema = z
  .object({
    hook_event_name: z.enum(['SessionStart', 'SessionEnd', 'PostToolUse']),
    session_id: nonEmpty.max(120),
    cwd: nonEmpty,
    transcript_path: nonEmpty.optional(),
    model: nonEmpty.max(120).optional(),
  })
  .strip();

export type CodexHookCommand = 'start' | 'end' | 'post-tool-use';

export type CodexHookEvent =
  | { event: 'start'; session_id: string; cwd: string; transcript_path?: string }
  | { event: 'end'; session_id: string; cwd: string; transcript_path?: string }
  | { event: 'post-tool-use'; session_id: string; cwd: string; model: string };

const expectedEvent: Record<CodexHookCommand, string> = {
  start: 'SessionStart',
  end: 'SessionEnd',
  'post-tool-use': 'PostToolUse',
};

/** Parse external Codex hook stdin before it can affect a local binding. */
export function parseCodexHookEvent(
  raw: string,
  expected: CodexHookCommand,
): CodexHookEvent | undefined {
  try {
    const parsed = CodexHookInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.hook_event_name !== expectedEvent[expected])
      return undefined;
    const { session_id, cwd, transcript_path } = parsed.data;
    if (expected === 'post-tool-use') {
      return parsed.data.model
        ? { event: expected, session_id, cwd, model: parsed.data.model }
        : undefined;
    }
    return { event: expected, session_id, cwd, ...(transcript_path ? { transcript_path } : {}) };
  } catch {
    return undefined;
  }
}

/** ADR 632: local rollout header, never a wire field. Only interactive sources count. */
const CodexAttendedMetaSchema = z
  .object({
    type: z.literal('session_meta'),
    payload: z
      .object({
        session_id: nonEmpty.max(120),
        cwd: nonEmpty,
        source: z.enum(['cli', 'vscode']),
      })
      .strip(),
  })
  .strip();

/** Read only the metadata record, excluding exec, subagents and unknown source kinds. */
export function parseCodexAttendedMeta(raw: string): { id: string; cwd: string } | undefined {
  try {
    const parsed = CodexAttendedMetaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return { id: parsed.data.payload.session_id, cwd: parsed.data.payload.cwd };
  } catch {
    return undefined;
  }
}
