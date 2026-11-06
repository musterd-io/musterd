#!/usr/bin/env node
/**
 * Authorize musterdbot once and stage its four chat secrets on the stream app (ADR 740, ADR 807).
 *
 * The hosted capture reads Twitch chat (`!who`, `!vote`) and posts polls on a bot account's user
 * token. With `--title` it instead authorizes the CHANNEL account for `channel:manage:broadcast`
 * and stages MUSTERD_TWITCH_CLIENT_ID + MUSTERD_TWITCH_CLIENT_SECRET + MUSTERD_TWITCH_REFRESH_TOKEN,
 * from which the title writer (ADR 711) mints its own access token at every stream start. Both
 * grants last until Twitch rotates the refresh token; then rerun this. That token comes from an OAuth authorization-code grant a human performs in a browser,
 * signed in as the bot. This script runs that flow on the operator's machine and hands the result
 * straight to `fly secrets import --stage` — it prints digests, never a value.
 *
 *   node scripts/broadcast/twitch-bot-auth.mjs --client-id <id> [--channel musterd_io] [--app musterd-broadcast] [--port 3000]
 *   node scripts/broadcast/twitch-bot-auth.mjs --client-id <id> --title     # sign in as the channel account
 *
 * The client secret is read from the terminal with echo off (or `MUSTERD_TWITCH_CHAT_CLIENT_SECRET`).
 * The app's OAuth Redirect URL must be exactly `http://localhost:<port>` (the console refuses a path
 * on the one http origin it allows, 2026-11-05): the default port 3000 matches the musterd-chat app
 * at https://dev.twitch.tv/console/apps. Any path on that origin is accepted as the callback.
 *
 * `--stage` is not optional (docs/wiki/broadcast-stream.md): the app has no release to deploy, so an
 * unstaged `secrets set` stores the value and then reports a failure that is not one.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];
const TITLE_SCOPES = ['channel:manage:broadcast'];
const AUTH_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const clientId = arg('client-id', process.env.MUSTERD_TWITCH_CHAT_CLIENT_ID);
const channel = arg('channel', process.env.MUSTERD_TWITCH_CHAT_CHANNEL ?? 'musterd_io');
const app = arg('app', 'musterd-broadcast');
const port = Number(arg('port', '3000'));
const title = process.argv.includes('--title');
const expectBot = title ? channel : arg('bot', 'musterdbot');
const SCOPES = title ? TITLE_SCOPES : BOT_SCOPES;

if (!clientId || process.argv.includes('--help')) {
  console.error(
    'usage: twitch-bot-auth.mjs --client-id <id> [--channel musterd_io] [--app musterd-broadcast] [--port 3000] [--bot musterdbot] [--title]',
  );
  process.exit(clientId ? 0 : 2);
}

/** Read one line with echo off; a pasted secret must not land in scrollback. */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = rl._writeToOutput;
    process.stderr.write(prompt);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl._writeToOutput = write;
      process.stderr.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Run a command with argv (never a shell), feeding stdin; resolves on exit 0. */
function run(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`)),
    );
    if (stdin !== undefined) p.stdin.end(stdin);
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

const clientSecret =
  process.env.MUSTERD_TWITCH_CHAT_CLIENT_SECRET?.trim() ||
  (await readHidden(`client secret for ${clientId} (hidden): `));
if (!clientSecret) {
  console.error('no client secret');
  process.exit(2);
}

const redirectUri = `http://localhost:${port}`;
const state = randomBytes(16).toString('hex');

const code = await waitForCode().catch((e) => {
  console.error(`authorization failed: ${e.message}`);
  process.exit(1);
});

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname === '/favicon.ico') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !err && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
      res.end(
        ok
          ? 'musterdbot authorized — back to the terminal.'
          : `authorization failed: ${err ?? 'bad state'}`,
      );
      server.close();
      if (ok) resolve(got);
      else reject(new Error(err ?? 'state mismatch'));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const u = new URL(AUTH_URL);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('scope', SCOPES.join(' '));
      u.searchParams.set('state', state);
      u.searchParams.set('force_verify', 'true');
      const who = title
        ? `${expectBot} (the channel account)`
        : `${expectBot} (not your own account)`;
      console.error(`\nSign in as ${who} and authorize:\n\n  ${u}\n`);
      openBrowser(u.toString());
    });
  });
}

const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});
if (!tokenRes.ok) {
  console.error(`token exchange failed: HTTP ${tokenRes.status}`);
  process.exit(1);
}
const tok = await tokenRes.json();
if (!tok.refresh_token || !tok.access_token) {
  console.error('token exchange returned no refresh token');
  process.exit(1);
}

const v = await fetch(VALIDATE_URL, { headers: { authorization: `OAuth ${tok.access_token}` } });
const who = v.ok ? await v.json() : null;
const missing = SCOPES.filter((s) => !(who?.scopes ?? []).includes(s));
if (!who || missing.length) {
  console.error(`token is missing scopes: ${missing.join(' ') || 'validate failed'}`);
  process.exit(1);
}
if (who.login !== expectBot) {
  console.error(
    `signed in as ${who.login}, expected ${expectBot} — nothing staged. Sign out of Twitch and rerun.`,
  );
  process.exit(1);
}
console.error(`✓ ${who.login} authorized with ${who.scopes.join(' ')}`);

const pairs = title
  ? [
      `MUSTERD_TWITCH_CLIENT_ID=${clientId}`,
      `MUSTERD_TWITCH_CLIENT_SECRET=${clientSecret}`,
      `MUSTERD_TWITCH_REFRESH_TOKEN=${tok.refresh_token}`,
    ]
  : [
      `MUSTERD_TWITCH_CHAT_CLIENT_ID=${clientId}`,
      `MUSTERD_TWITCH_CHAT_CLIENT_SECRET=${clientSecret}`,
      `MUSTERD_TWITCH_CHAT_REFRESH_TOKEN=${tok.refresh_token}`,
      `MUSTERD_TWITCH_CHAT_CHANNEL=${channel}`,
    ];
await run('fly', ['secrets', 'import', '-a', app, '--stage'], pairs.join('\n') + '\n');
console.error(
  title
    ? `✓ staged the title refresh pair (MUSTERD_TWITCH_CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN) on ${app} — the stream mints its own access token at start; \`fly secrets unset -a ${app} --stage MUSTERD_TWITCH_TOKEN\` retires the old ~4 h token if it is still listed`
    : `✓ staged four MUSTERD_TWITCH_CHAT_* secrets on ${app} — \`musterd stream doctor\` next`,
);
await run('fly', ['secrets', 'list', '-a', app]);
