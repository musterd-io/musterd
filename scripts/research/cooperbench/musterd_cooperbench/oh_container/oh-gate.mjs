// musterd's lane gate (ADR 150) as an OpenHands PreToolUse hook (the plugin's hooks/hooks.json).
//
// OpenHands pipes its own hook event in: {event_type, tool_name, tool_input, session_id, working_dir},
// where the file editor's tool_input is its action ({command, path, ...}). This turns a write into the
// payload `musterd gate check --stdin` reads (Claude Code's {tool_name, tool_input: {file_path}}), runs
// musterd's own gate, and turns its verdict into OpenHands' ({"decision": "deny", "reason"}). The gate
// logic is musterd's; this file only translates.
//
// `view` is a read: the gate matches on a path whatever the tool, so passing it through would refuse
// every read outside the agent's lanes. Only the editor's writes are sent.
//
// Like musterd's own hook command (`... || true`), any failure here allows the call: a gate that
// can't run must never stop the loop. gate_smoke.py is what proves the gate is armed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WRITES = new Set(['create', 'str_replace', 'insert', 'undo_edit']);

export function toMusterdPayload(event) {
  if (!event || event.tool_name !== 'file_editor') return null;
  const input = event.tool_input ?? {};
  if (!WRITES.has(input.command) || typeof input.path !== 'string') return null;
  return {
    tool_name: 'Edit',
    tool_input: { file_path: input.path },
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.working_dir ? { cwd: event.working_dir } : {}),
  };
}

export function toOpenHandsVerdict(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) continue;
    let out;
    try {
      out = JSON.parse(line);
    } catch {
      continue;
    }
    const hso = out?.hookSpecificOutput ?? {};
    if (hso.permissionDecision === 'deny') {
      return {
        decision: 'deny',
        reason: String(
          hso.permissionDecisionReason ?? out.agent_message ?? 'refused by the musterd lane gate',
        ),
      };
    }
    if (hso.additionalContext) return { additionalContext: String(hso.additionalContext) };
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const payload = toMusterdPayload(event);
  if (!payload) return;
  const gate = spawnSync('musterd', ['gate', 'check', '--stdin'], {
    input: JSON.stringify(payload),
    cwd: event.working_dir || process.cwd(),
    encoding: 'utf8',
    timeout: 25_000,
  });
  const verdict = gate.error ? null : toOpenHandsVerdict(gate.stdout);
  if (verdict) process.stdout.write(JSON.stringify(verdict) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
