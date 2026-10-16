/**
 * The console's one outbound email: the sign-in link (ADR 620 decision 2). Sent through Cloudflare
 * Email Service's REST endpoint with plain `fetch` — no SDK. The API token is a least-privileged
 * secret used for nothing else, and the message carries no tracking: the link is the bare URL.
 * Never logs the address, the link or the token.
 */
export interface EmailConfig {
  accountId: string;
  apiToken: string;
  /** e.g. `musterd <signin@musterd.io>` — the domain must be onboarded to Email Sending. */
  fromAddress: string;
  fromName: string;
}

export interface SignInEmail {
  to: string;
  link: string;
  expiresMinutes: number;
}

/**
 * The words are placeholders until alfie's copy spec lands (lane 01M3Z43QYB); the shape — a bare
 * link, the expiry, and what to do if you did not ask — is ADR 620's.
 */
export function signInMessage(m: SignInEmail): { subject: string; text: string; html: string } {
  const subject = 'Your musterd sign-in link';
  const text =
    `Use this link to sign in to musterd. It works once, in the browser where you asked for it, ` +
    `for ${m.expiresMinutes} minutes:\n\n${m.link}\n\n` +
    `If you didn't ask to sign in, you can ignore this email. Nobody can use it without this link.`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html =
    `<p>Use this link to sign in to musterd. It works once, in the browser where you asked for it, ` +
    `for ${m.expiresMinutes} minutes:</p><p><a href="${esc(m.link)}">${esc(m.link)}</a></p>` +
    `<p>If you didn't ask to sign in, you can ignore this email.</p>`;
  return { subject, text, html };
}

export async function sendSignInEmail(
  cfg: EmailConfig,
  m: SignInEmail,
  doFetch: typeof fetch = fetch,
  endpoint = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/email/sending/send`,
): Promise<boolean> {
  const msg = signInMessage(m);
  const res = await doFetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      to: m.to,
      from: { address: cfg.fromAddress, name: cfg.fromName },
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  return res.ok;
}
