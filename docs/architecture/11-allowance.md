# 11 — Allowance (`@musterd/allowance`)

> **Living document.** Direction, not gospel: if it disagrees with the code, fix the smaller of the two
> in the same commit. Nick asked for this on 2026-10-19: a standalone page, on any machine, for any
> project, musterd on the door, published the way a package is published.

## What it is

`@musterd/allowance` is one local page, `what's left`. It reads provider windows that a provider
actually reports, and it says so when it cannot. It does not join a team, talk to the daemon, or
import another musterd package. Keys are read from the environment on the server and never written
into the HTML or the JSON.

Which accounts appear is the person's choice. The page is a form (`POST /accounts`, no script).
Checked ids are saved at `~/.allowance/config.json`, mode 0600, ids only. A missing or unreadable
file means ElevenLabs and is not rewritten. Unknown ids are dropped. An empty selection is allowed.

A number is drawn only from a body the provider's own client reads:

- ElevenLabs `GET /v1/user/subscription` (`xi-api-key` from `ELEVENLABS_API_KEY`): characters used,
  the cap, and `next_character_count_reset_unix` when they send it, plus voice slots when both
  counts are present.
- OpenAI, from the Codex sign-in in `~/.codex/auth.json` (`tokens.access_token` and
  `tokens.account_id`): `GET https://chatgpt.com/backend-api/wham/usage`. Each window is
  `used_percent` over a length of `limit_window_seconds` (18000 seconds is the 5-hour window,
  604800 is the weekly window). `reset_at` is unix seconds. `plan_type` is shown only when it is a
  short plan word. Email, user id and account id are never copied out.
- Claude, from `CLAUDE_CODE_OAUTH_TOKEN` or `claudeAiOauth.accessToken` in
  `~/.claude/.credentials.json`: `GET https://api.anthropic.com/api/oauth/usage`. `five_hour` and
  `seven_day` carry `utilization` and `resets_at`. A key containing `overage` is not a window.
- Cursor, from `accessToken` in `~/.cursor/auth.json`, or on macOS the keychain item the Cursor CLI
  stores (`cursor-access-token` / `cursor-user`):
  `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with an empty
  JSON body. `planUsage.totalPercentUsed` is the included window. A cycle of about a month is called
  monthly. `spendLimitUsage.individualLimit` is cents of on-demand, and the used figure is
  `individualUsed` or, when that field is absent, the limit minus `individualRemaining`. Auto and
  API percents are shares of the included pool, so they are not separate bars. `displayMessage` is
  never copied out.

OpenCode, Grok, Muse, Hume and Exa have no remaining-window read. When one of them is checked, the
card is the reason and no number. A checked account with no sign-in on this machine says so, and
shows no number.

The server listens on `127.0.0.1` only (port `4877`, or `ALLOWANCE_PORT`). The bin is `allowance`.
A sign-in is read in the server and never written into the HTML, the JSON, or the config file.
`POST /accounts` refuses a body over 4096 bytes and an `Origin` that is not loopback.

## File tree `packages/allowance/src/`

```
bin.ts            // shebang: Node 22 gate, ALLOWANCE_PORT, start on loopback, print the url
board.ts          // readBoard: the accounts the user turned on; a token stays inside its fetch
catalog.ts        // every account the page can offer, and the reason when it has no read
claude.ts         // Claude Code's usage read: oauth/usage, overage skipped, token from env or file
codex.ts          // Codex's usage read: wham/usage windows, identity fields never copied out
config.ts         // the saved account ids: parse, the form, ~/.allowance/config.json mode 0600
css.ts            // percentCss: .p0–.p100 so a bar width is a class, not an inline style
cursor.ts         // Cursor's usage read: included percent and on-demand cents, message dropped
elevenlabs.ts     // parseElevenLabs + readElevenLabs (redirect:'error', 5s budget lives with the caller)
format.ts         // counts, "left of", a share of a named window, on-demand dollars, reset phrases
page.ts           // renderPage: the paper page, the account form, every provider string escaped
server.ts         // 127.0.0.1 only; /, /api/board, POST /accounts, the stylesheet, the three font files
types.ts          // Board, windows, live / missing / error / quiet
```
