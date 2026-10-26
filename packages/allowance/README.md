# @musterd/allowance

A local page of what is left on the provider accounts on this machine.

```bash
ELEVENLABS_API_KEY=… npx @musterd/allowance
```

On a terminal it opens `http://127.0.0.1:4877` and stays running. Leave that window open. Ctrl-C stops the page. The process binds to loopback. A sign-in stays on this machine: it is sent only to that provider, and it is never written into the page or the config file.

The page shows the accounts you check, two live accounts across and one line for an account with no number. A fresh machine starts with ElevenLabs. The choice is saved at `~/.allowance/config.json` (account ids only, mode 0600).

ElevenLabs reads `ELEVENLABS_API_KEY` (the character window, and voice slots when both counts are present). OpenAI reads the Codex sign-in in `~/.codex/auth.json` and shows the windows Codex reports. Claude reads `CLAUDE_CODE_OAUTH_TOKEN`, `~/.claude/.credentials.json`, or on macOS the keychain item Claude Code stored. The card names the plan, and a model with its own weekly window gets its own bar. Cursor reads `~/.cursor/auth.json`, or on macOS the keychain item the Cursor CLI stored, and shows the included window and on-demand dollars. Muse reads `muse usage --json` and shows a window when Muse sends a used percent and a reset. OpenCode, Grok, Hume and Exa stay on the list with the reason a number is absent.

`ALLOWANCE_PORT` chooses the port. Node 22 or newer.

From the musterd team. This page runs on its own. musterd is the team it comes from. [musterd.io](https://musterd.io)
