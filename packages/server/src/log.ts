import { isMusterdCredential, TOKEN_PREFIXES } from '@musterd/protocol';

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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A credential-shaped run — a registered prefix where a token can start, then its base64url tail. */
const CREDENTIAL_RUN = new RegExp(
  `(^|[^A-Za-z0-9_-])(?:${Object.values(TOKEN_PREFIXES).map(escapeRegExp).join('|')})[A-Za-z0-9_-]*`,
  'gi',
);

/** Free text made safe to log (hard rule 5): every credential-shaped run becomes `[redacted]`. */
export function redactCredentialText(text: string): string {
  return text.replace(CREDENTIAL_RUN, (_run, lead: string) => `${lead}${REDACTED}`);
}

/** How much of a failure's message a request log line keeps. */
export const FAILURE_TEXT_MAX = 300;

/**
 * The cause of a 5xx, for that request's own log line (lane 01M3ZPM3FE): the error's class, the
 * Postgres SQLSTATE when there is one (the pg driver nests the server's error as `cause`), and a
 * one-line message cut to {@link FAILURE_TEXT_MAX} with credential-shaped text redacted. A pg error
 * names the statement, never its parameters, and no request body is ever read here.
 */
export function requestFailureFields(err: unknown): {
  err_class: string;
  sqlstate?: string;
  err: string;
} {
  const codeOf = (e: unknown): unknown =>
    e !== null && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : undefined;
  const nested = err instanceof Error ? err.cause : undefined;
  const code = codeOf(nested) ?? codeOf(err);
  const sqlstate = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return {
    err_class: err instanceof Error ? err.name : typeof err,
    ...(sqlstate ? { sqlstate } : {}),
    err: redactCredentialText(text).slice(0, FAILURE_TEXT_MAX),
  };
}

const requestFailures = new WeakMap<object, ReturnType<typeof requestFailureFields>>();

/** Record why `res` is answering a 5xx; the request logger reads it once the response finishes. */
export function noteRequestFailure(res: object, err: unknown): void {
  requestFailures.set(res, requestFailureFields(err));
}

/** The failure noted for `res`, if any. */
export function requestFailure(res: object): ReturnType<typeof requestFailureFields> | undefined {
  return requestFailures.get(res);
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
