# 11 — Allowance (`@musterd/allowance`)

> **Living document.** Direction, not gospel: if it disagrees with the code, fix the smaller of the two
> in the same commit. Nick asked for this on 2026-10-19: a standalone page, on any machine, for any
> project, musterd on the door, published the way a package is published.

## What it is

`@musterd/allowance` is one local page, `what's left`. It reads provider windows that a provider
actually reports, and it says so when it cannot. It does not join a team, talk to the daemon, or
import another musterd package. Keys are read from the environment on the server and never written
into the HTML or the JSON.

The first read is ElevenLabs `GET /v1/user/subscription` (`xi-api-key` from `ELEVENLABS_API_KEY`):
characters used, the cap, and `next_character_count_reset_unix` when they send it, plus voice slots
when both counts are present. OpenAI, Claude, OpenCode, Grok, Muse, Cursor, Hume and Exa are on the
page as quiet rows. A quiet row has a reason and no number.

The server listens on `127.0.0.1` only (port `4877`, or `ALLOWANCE_PORT`). The bin is `allowance`.

## File tree `packages/allowance/src/`

```
bin.ts            // shebang: Node 22 gate, ALLOWANCE_PORT, start on loopback, print the url
board.ts          // readBoard: ElevenLabs plus the quiet catalog; the key stays in the fetch
catalog.ts        // QUIET: the providers with no read yet, each a name and a reason
css.ts            // percentCss: .p0–.p100 so a bar width is a class, not an inline style
elevenlabs.ts     // parseElevenLabs + readElevenLabs (redirect:'error', 5s budget lives with the caller)
format.ts         // counts, "left of", reset phrases, fill percent, html escape
page.ts           // renderPage: the paper page, every provider string escaped
server.ts         // 127.0.0.1 only; /, /api/board, /allowance.css, the three font files
types.ts          // Board, windows, live / missing / error / quiet
```
