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
 * The words are the copy spec §4 (docs/design/console-signin-copy-spec.md), character for
 * character; the email is text only, one link on its own line, no tracking (ADR 620 decision 2).
 * If the built link lifetime changes, the "15 minutes" strings change in the same commit.
 */
export function signInMessage(m: SignInEmail): { subject: string; text: string } {
  const subject = 'Sign in to musterd';
  const text =
    `Sign in to your musterd account.\n\n` +
    `This link works for ${m.expiresMinutes} minutes, and only in the browser where you asked for it.\n\n` +
    `${m.link}\n\n` +
    `Didn't ask for this? Ignore this email.`;
  return { subject, text };
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
    }),
  });
  return res.ok;
}
