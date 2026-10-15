/**
 * The one way the console writes a cookie (ADR 615). The skeleton sets none; sign-in (lane
 * 01M3Z43QYB) uses this. Every cookie is `__Host-` prefixed, which the browser enforces as Secure,
 * `Path=/` and no `Domain` — so no other subdomain of musterd.io can read or overwrite it — and
 * HttpOnly with SameSite=Lax. There is no option to weaken any of it.
 */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VALUE = /^[A-Za-z0-9._~-]{0,4096}$/;

export function hostCookie(name: string, value: string, maxAgeSeconds?: number): string {
  if (!NAME.test(name)) throw new Error('cookie name must be a short token');
  if (!VALUE.test(value)) throw new Error('cookie value must be URL-safe');
  const parts = [`__Host-${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) {
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0)
      throw new Error('cookie max-age must be a whole number of seconds');
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join('; ');
}
