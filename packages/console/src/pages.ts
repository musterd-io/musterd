import { readFileSync } from 'node:fs';

/**
 * The sign-in screens (design: docs/superpowers/specs/2026-10-15-console-signin-design.md;
 * words: docs/design/console-signin-copy-spec.md, character for character). Server-rendered,
 * no script, no inline style: every state is a class in assets/console.css, served under the
 * page CSP. Assets live in ../assets so both src (tests) and dist (deploy) resolve them.
 */

export const PAGE_CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const ASSETS = new Map<string, { type: string; body: Buffer; cache: string }>();
function asset(name: string, type: string, cache: string): void {
  try {
    ASSETS.set(`/${name}`, {
      type,
      body: readFileSync(new URL(`../assets/${name}`, import.meta.url)),
      cache,
    });
  } catch {
    // A missing asset 404s below; the pages still render.
  }
}
asset('console.css', 'text/css; charset=utf-8', 'public, max-age=300');
asset('favicon.svg', 'image/svg+xml', 'public, max-age=300');
for (const f of ['recursive-linear.woff2', 'recursive-casual.woff2', 'recursive-mono.woff2'])
  asset(`fonts/${f}`, 'font/woff2', 'public, max-age=31536000, immutable');

export function assetFor(path: string): { type: string; body: Buffer; cache: string } | null {
  return ASSETS.get(path) ?? null;
}

export function esc(s: string): string {
  // Text and double-quoted attribute values: & < > " are the characters that can break out.
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

// The lockup mark is the favicon's own SVG, inlined (it is markup, not a resource).
const MARK = (() => {
  try {
    return readFileSync(new URL('../assets/favicon.svg', import.meta.url), 'utf8')
      .replace('<svg ', '<svg aria-hidden="true" focusable="false" ')
      .trim();
  } catch {
    return '';
  }
})();

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

const GOOGLE_ICON =
  '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M9 3.48c1.69 0 2.83.73 3.48 1.34l2.54-2.48C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l2.91 2.26C4.6 5.05 6.62 3.48 9 3.48z"/><path fill="#4285F4" d="M17.64 9.2c0-.74-.06-1.28-.19-1.84H9v3.34h4.96c-.1.83-.64 2.08-1.84 2.92l2.84 2.2c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#FBBC05" d="M3.88 10.78A5.54 5.54 0 0 1 3.58 9c0-.62.11-1.22.29-1.78L.96 4.96A9.008 9.008 0 0 0 0 9c0 1.45.35 2.82.96 4.04l2.92-2.26z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.84-2.2c-.76.53-1.78.9-3.12.9-2.38 0-4.4-1.57-5.12-3.74L.97 13.04C2.44 15.98 5.48 18 9 18z"/></svg>';

const MAIL_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.78.78 2 1.75 2Zm12.28 1.5H1.97L8 7.97ZM1.5 12.25c0 .14.11.25.25.25h12.5a.25.25 0 0 0 .25-.25V5.4L8.72 9.63a1.25 1.25 0 0 1-1.44 0L1.5 5.4Z"/></svg>';

function shell(title: string, main: string): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light">\n<title>${esc(title)}</title>\n` +
    `<link rel="stylesheet" href="/console.css">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>\n<body>\n` +
    `<div class="c-shell">\n<a class="c-brand" href="https://musterd.io">${MARK}musterd</a>\n<main>\n${main}\n</main>\n` +
    `<footer class="c-foot"><a href="https://musterd.io/privacy">Privacy</a><a href="https://musterd.io">musterd.io</a></footer>\n</div>\n</body>\n</html>\n`
  );
}

export interface SignInOptions {
  providers: readonly string[];
  email: boolean;
  expired?: boolean;
  error?: { message: string; value: string } | null;
}

export function signInPage(o: SignInOptions): string {
  const ways: string[] = [];
  if (o.providers.length) {
    const buttons = o.providers
      .map(
        (p) =>
          `<form method="post" action="/auth/${p}/start"><button class="c-button" type="submit">${p === 'github' ? GITHUB_ICON : GOOGLE_ICON}Continue with ${p === 'github' ? 'GitHub' : 'Google'}</button></form>`,
      )
      .join('\n');
    ways.push(`<div class="c-stack">\n${buttons}\n</div>`);
  }
  if (o.email) {
    const e = o.error;
    const field = e
      ? `<div class="c-field c-field--error">\n<label for="email">Email</label>\n<input id="email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required placeholder="you@example.com" value="${esc(e.value)}" aria-invalid="true" aria-describedby="email-error" autofocus>\n<p class="c-field__error" id="email-error">${esc(e.message)}</p>\n</div>`
      : `<div class="c-field">\n<label for="email">Email</label>\n<input id="email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required placeholder="you@example.com">\n</div>`;
    ways.push(
      `${o.providers.length ? '<p class="c-or">or</p>\n' : ''}<form class="c-stack" method="post" action="/auth/email/start">\n${field}\n<button class="c-button c-button--primary" type="submit">Email me a link</button>\n</form>`,
    );
  }
  const note =
    o.providers.length || o.email
      ? '\n<p class="c-note">musterd discards your GitHub or Google token after you sign in. A team never receives it.</p>'
      : '';
  const banner = o.expired
    ? '<p class="c-notice" role="status">Your sign-in expired. Sign in again.</p>\n'
    : '';
  return shell(
    'Sign in — musterd',
    `${banner}<h1>Sign in</h1>\n<p class="c-lede">Sign in to your musterd account.</p>\n${ways.join('\n')}${note}`,
  );
}

export function checkEmailPage(address: string): string {
  return shell(
    'Check your email — musterd',
    `<h1>Check your email</h1>\n<p class="c-lede">We sent a sign-in link to <strong>${esc(address)}</strong>. It works for 15 minutes, and only in this browser.</p>\n<a class="c-link" href="/">Use a different address</a>`,
  );
}

export function finishPage(token: string): string {
  return shell(
    'Finish signing in — musterd',
    `<h1>Finish signing in</h1>\n<p class="c-lede">This signs you in to your musterd account in this browser.</p>\n<form class="c-stack" method="post" action="/auth/email/confirm">\n<input type="hidden" name="t" value="${esc(token)}">\n<button class="c-button c-button--primary" type="submit">Sign in</button>\n<a class="c-button" href="/">Cancel</a>\n</form>`,
  );
}

export function wrongBrowserPage(): string {
  return shell(
    'Open this in the browser where you started — musterd',
    `<h1>Open this in the browser where you started</h1>\n<p class="c-lede">This link signs you in only in that browser. Go back to it and open the link from there.</p>`,
  );
}

function errorPage(heading: string, body: string | null, extra = ''): string {
  return shell(
    `${heading} — musterd`,
    `<h1>${esc(heading)}</h1>\n${body ? `<p class="c-lede">${esc(body)}</p>\n` : ''}${extra}<div class="c-stack">\n<a class="c-button c-button--primary" href="/">Back to sign-in</a>\n</div>`,
  );
}

export const errorPages = {
  link: () =>
    errorPage('This link is no longer valid.', 'It works once, for 15 minutes. Ask for a new one.'),
  github: () => errorPage("GitHub didn't complete sign-in.", 'You can try again.'),
  google: () => errorPage("Google didn't complete sign-in.", 'You can try again.'),
  disabled: () => errorPage('This account is disabled.', "You can't sign in with it."),
  rate: () => errorPage('Too many attempts.', 'Try again in a little while.'),
  unknown: (requestId: string) =>
    errorPage(
      'Something went wrong.',
      null,
      `<p class="c-ref">Quote this if you ask for help: <code>${esc(requestId)}</code></p>\n`,
    ),
};

export function accountPage(o: {
  methods: { provider: string; email: string | null }[];
  csrf: string;
}): string {
  const rows = o.methods
    .map((m) => {
      const icon =
        m.provider === 'github' ? GITHUB_ICON : m.provider === 'google' ? GOOGLE_ICON : MAIL_ICON;
      const who =
        m.provider === 'github'
          ? 'GitHub'
          : m.provider === 'google'
            ? 'Google'
            : `Email · ${esc(m.email ?? '')}`;
      return `<li>${icon}<span class="c-list__who">${who}</span></li>`;
    })
    .join('\n');
  return shell(
    'Your account — musterd',
    `<h1>Your account</h1>\n<p class="c-lede">You are signed in.</p>\n<h2 class="c-section-label">Sign-in methods</h2>\n<ul class="c-list">\n${rows}\n</ul>\n<form method="post" action="/logout">\n<input type="hidden" name="csrf" value="${esc(o.csrf)}">\n<button class="c-button" type="submit">Sign out</button>\n</form>`,
  );
}
