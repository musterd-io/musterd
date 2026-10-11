import { connect } from 'node:net';
import type { InjectAdapter, InjectResult } from './inject.js';

/**
 * Claude Code's inbox socket (v2.1.224+; ADR 558 §6). "When the receiving session is idle, Claude
 * Code starts a new turn with the message" (code.claude.com/docs/en/cross-session-messaging). The
 * framing is undocumented publicly; Claude Code prints it in its own `[uds-messaging]` debug help
 * (2.1.296): NDJSON, an optional `{"type":"auth"}` first line, then a `{"type":"user"}` message.
 *
 * The variables are read from THIS process's environment — the adapter is a child of `claude` like
 * any hook. The token is never logged, persisted, or echoed in a reason (hard rule 5).
 */
const CONNECT_TIMEOUT_MS = 5_000;

export function claudeInbox(env: NodeJS.ProcessEnv): InjectAdapter {
  const socketPath = env['CLAUDE_CODE_MESSAGING_SOCKET'];
  const token = env['CLAUDE_CODE_MESSAGING_TOKEN'];
  return {
    harness: 'claude-code',
    probe: () => (socketPath ? { ready: true } : { ready: false, reason: 'no-messaging-socket' }),
    inject: (line) =>
      new Promise<InjectResult>((resolve) => {
        if (!socketPath) return resolve({ ok: false, reason: 'no-messaging-socket' });
        let settled = false;
        const sock = connect(socketPath);
        const done = (r: InjectResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          resolve(r);
        };
        const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), CONNECT_TIMEOUT_MS);
        // Only the errno code — never the error message, which could carry the path or anything
        // else the runtime chose to include.
        sock.on('error', (err: NodeJS.ErrnoException) =>
          done({ ok: false, reason: `connect:${err.code ?? 'error'}` }),
        );
        sock.on('connect', () => {
          const lines =
            (token ? `${JSON.stringify({ type: 'auth', token })}\n` : '') +
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: line } })}\n`;
          sock.end(lines, () => done({ ok: true }));
        });
      }),
  };
}
