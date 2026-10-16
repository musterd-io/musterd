import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { sameSecret } from './secrets.js';

/**
 * CSRF for the console (ADR 620 decision 8). Two checks on every state-changing request, both
 * required:
 *
 * 1. **Origin** is exactly the pinned issuer. No suffix match, no reflection, and a missing or
 *    `null` Origin is refused — a browser sends one on every cross-origin and same-origin POST.
 * 2. **A CSRF token** bound to the session: `sha256("csrf\0" + session id)`, base64url. Only a
 *    holder of the session cookie can compute it, and the page that renders the form puts it in a
 *    hidden field. It changes when the session id rotates.
 *
 * SameSite=Lax on the cookie is defence in depth, not the rule: sibling subdomains are same-site.
 */
export function csrfTokenFor(sessionId: string): string {
  return createHash('sha256').update(`csrf\0${sessionId}`, 'utf8').digest('base64url');
}

export function originAllowed(req: IncomingMessage, issuer: string): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin !== 'null' && origin === issuer;
}

export function csrfTokenValid(sessionId: string, submitted: unknown): boolean {
  return typeof submitted === 'string' && sameSecret(csrfTokenFor(sessionId), submitted);
}
