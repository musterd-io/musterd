import { isMusterdCredential } from '@musterd/protocol';

type Level = 'info' | 'warn' | 'error';

export interface LogFields {
  msg: string;
  team?: string;
  member?: string;
  act?: string;
  conn?: string;
  [k: string]: unknown;
}

function emit(level: Level, fields: LogFields): void {
  if (process.env['MUSTERD_SILENT'] === '1') return;
  const line = JSON.stringify({ ts: Date.now(), level, ...fields });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** Structured single-line JSON logger (07-conventions format). Never logs tokens. */
export const log = {
  info: (fields: LogFields) => emit('info', fields),
  warn: (fields: LogFields) => emit('warn', fields),
  error: (fields: LogFields) => emit('error', fields),
};

const REDACTED = '[redacted]';

/**
 * A request path made safe to log or echo (hard rule 5). The path is the one part of a request the
 * log keeps, and a remote MCP connector URL carries its secret there: every segment under an `mcp`
 * segment is redacted (`/mcp/<token>`, ADR 446's `/mcp/:team`, its `.well-known` twin), and so is
 * any credential-shaped segment anywhere, checked percent-decoded so `%6Dscr_` cannot slip past.
 */
export function redactPath(path: string): string {
  let underMcp = false;
  return path
    .split('/')
    .map((segment) => {
      if (segment === '') return segment;
      if (underMcp) return REDACTED;
      if (segment.toLowerCase() === 'mcp') {
        underMcp = true;
        return segment;
      }
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Malformed encoding: judge the raw segment.
      }
      return isMusterdCredential(decoded) ? REDACTED : segment;
    })
    .join('/');
}

/**
 * The log fields for a failed call. `String(error)` for a network failure is `TypeError: fetch
 * failed` and nothing more: undici puts the reason (a reset socket, `other side closed`, a connect
 * timeout) on `.cause`. A joiner's pull failed once a minute for ten minutes behind exactly that
 * line, with no way to tell a flaky link from a hub that hung up (second-machine run, 2026-10-02).
 */
export function failureFields(error: unknown): { error: string; cause?: string } {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause === undefined || cause === null) return { error: String(error) };
  const code =
    typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '';
  const text = cause instanceof Error ? cause.message : String(cause);
  return { error: String(error), cause: code ? `${code}: ${text}` : text };
}
