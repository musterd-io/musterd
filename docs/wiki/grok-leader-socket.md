# Grok leader socket

A default Grok TUI does not listen on `~/.grok/leader.sock`. A TUI started with `--leader` does, and a second client on that socket can `session/prompt` its idle session into a new turn (Grok 1.0.52, measured 2026-10-13, n=1, lane `01M4M6QCMMCC9PK53F4537TZTY`).

## Default TUI is deaf (2026-10-13; falsify: `grok leader list` names a leader, or `~/.grok/leader.sock` exists, for a `grok` started with neither `--leader` nor `[cli] use_leader`) <!-- claim: other -->

Grok 1.0.52 (`0920c8169e27`). `[cli] use_leader` is absent from this machine's `~/.grok/config.toml`. The user guide's default for that key is false (`26-config-reference.md`: "Use the leader process for config reload and MCP watches").

- `ls ~/.grok/leader.sock` — no such file.
- `grok leader list` — "No leader candidates found."
- The live TUI in this workspace (pid 34354, cwd this repo) had anonymous socketpairs only. No filesystem leader socket.

The interactive help has `--leader-socket` and no documented `--leader`. `--leader` is accepted (`grok --leader --version` exits 0; `grok --bogus-flag --version` exits 2). `grok agent leader --help` is the documented way to run the shared process.

## Leader-attached TUI takes a prompt from a second client (2026-10-13; falsify: repeat the run below on 1.0.52 and the session's `chat_history.jsonl` has no second user turn) <!-- claim: other -->

Isolated leader: `grok agent leader --no-exit-on-disconnect --no-auto-update --leader-socket /tmp/grok-lazara-spike.sock`. It logged "ACP forwarding enabled" and `use_leader=false` for its own process.

TUI, held on a pty so the process stayed up: `grok --leader --leader-socket /tmp/grok-lazara-spike.sock --cwd /tmp/grok-spike-wd --always-approve --max-turns 4 --minimal` with the prompt "Reply with exactly the word PONG. Do not use tools."

- 18:50:07.798Z the TUI registered `client_id=25 client_type=grok-shell mode=Stdio yolo_mode=true client_version=1.0.52`.
- 18:50:07.900Z session `01a13699-be76-7952-b588-44d1abdf1182` spawned, `client_type=GrokPager`, cwd `/private/tmp/grok-spike-wd`.
- 18:50:09.973Z the first turn stopped (`prompt_length=51`, `stop_reason=stop`, no tool call). The assistant text in `chat_history.jsonl` is `PONG`. The pty title became "User demands exact PONG reply without to".
- Idle until 18:52:46.621Z (2 min 36 s). A second client, registered `mode=stdio`, called `session/list` and got that session id back, then `session/prompt` with "A second client is checking this idle session. Answer with the single word INJECTED and nothing else."
- The leader queued prompt `18f18c5f-2386-4ccf-94b4-06b57658c6db` (`prompt_length=101`) on the same session. The turn stopped at 18:52:48.621Z (`ttft_ms=612`, `stop_reason=stop`, no tool call). The prompter's `session/prompt` result was `stopReason: end_turn`.
- `chat_history.jsonl` for that session has the injected text as the next `user` turn and the assistant text `INJECTED`. The pty title became "Idle session ping and injection check".

The same socket accepted a `session/prompt` from a second stdio client against a session a first stdio client had created (`01a13699-1175-71d0-9555-fd53b721efcd`). The creating client received the `session/update` thought stream. That was a headless session, not a TUI. One trial.

`session/list` on this leader also returned session ids that this leader did not create, including the workspace TUI that was not attached to it. Those were not prompted.

## Wire, enough to repeat (2026-10-13; falsify: the first frame's leading four bytes are not a big-endian length, or `mode` accepts a value other than `stdio` and `headless`) <!-- claim: other -->

One frame is a big-endian u32 length, then one JSON object, max 64 MiB. A raw JSON write is refused as "Message too large" because the first four bytes are read as the length.

The first object is `{"type":"register","mode":"stdio"|"headless",...}`. `mode:"tui"` is rejected: "unknown variant `tui`, expected `headless` or `stdio`". The reply is `{"type":"registered","client_id":N,"ready":true,"leader_protocol_version":1,...}`.

ACP is a later frame `{"type":"acp","payload":"<json-rpc string>"}`. `payload` as an object is "invalid type: map, expected a string". `initialize` then `session/new` / `session/list` / `session/prompt` are ordinary ACP. `session/prompt` params are `{sessionId, prompt:[{type:"text", text}]}`.

Other frame types the register error named: `control`, `ping`, `disconnect`. Not exercised past seeing the names.

## What this does not settle

- A default musterd Grok seat stays deaf. Nothing in this repo starts `grok` with `--leader`, and `use_leader` is off unless someone sets it. The ingress exists only for a TUI that attached to a leader.
- A half-typed draft and an open approval dialog were not tried. The [idle-wake spec](../superpowers/specs/2026-10-07-idle-wake-design.md) §3 leaves both unmeasured on every harness.
- n=1. One idle TUI, one injected turn, Grok 1.0.52 on this laptop.
