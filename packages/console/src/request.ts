import type { IncomingMessage } from 'node:http';

/** The console's one session cookie name, as written by `hostCookie('session', …)` (ADR 615). */
export const SESSION_COOKIE = '__Host-session';
export const MAX_FORM_BYTES = 8 * 1024;

/** One named cookie's value from the request, or undefined. Never logs or returns the others. */
export function cookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export class FormError extends Error {
  constructor(
    readonly status: 413 | 415 | 400,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Read an `application/x-www-form-urlencoded` body, at most MAX_FORM_BYTES (ADR 620 decision 8:
 * wrong content types are refused; ADR 615: bodies are bounded). Anything else is a FormError.
 */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded')
    throw new FormError(415, 'unsupported_media_type');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_FORM_BYTES) throw new FormError(413, 'payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new FormError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
