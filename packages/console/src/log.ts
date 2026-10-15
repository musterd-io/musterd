import { scrubCredentials } from '@musterd/protocol';

/**
 * The console's log (ADR 615). One JSON line per event on stdout. Hard rule 5, and the console is
 * where sign-in codes, magic links and session cookies will pass: so a field whose NAME says it
 * carries a secret is dropped outright, and every string that remains goes through
 * `scrubCredentials` (ADR 445). Request lines carry the route LABEL, never the raw path or query —
 * a magic-link token rides a query string.
 */
const SECRET_KEY = /authorization|cookie|token|secret|password|passwd|code|link|credential|key/i;

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = scrubCredentials(v).text;
    else if (v !== null && typeof v === 'object' && !Array.isArray(v))
      out[k] = redact(v as LogFields);
    else out[k] = v;
  }
  return out;
}

export function makeLog(sink: LogSink = (l) => process.stdout.write(`${l}\n`)) {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}) =>
    sink(JSON.stringify({ ts: Date.now(), level, msg, ...redact(fields) }));
  return {
    info: (msg: string, f?: LogFields) => emit('info', msg, f),
    warn: (msg: string, f?: LogFields) => emit('warn', msg, f),
    error: (msg: string, f?: LogFields) => emit('error', msg, f),
  };
}
export type Log = ReturnType<typeof makeLog>;
