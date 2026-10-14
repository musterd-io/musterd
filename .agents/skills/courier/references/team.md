# This team: musterd (revive)

The only file in this skill that names musterd's specifics. Read before the first transfer in a
session. A team adopting this skill replaces this file with its own.

## The role here

- **Role file**: `courier` in the team home (`.musterd/roles/courier.toml`, outside the repository).
  Its charter: route-agnostic authority to carry, the routes listed here, team material only,
  one `status_update` per transfer, credentials only on a human's exact ask.
- **Holder**: dolly, on the hub. No holder sits on the second machine, so nothing can be carried
  from Air 2 to the hub by courier today; ask nick.
- **Find the holder**: `team_members {role:'courier'}` (MCP), or `musterd role show courier`
  (lists holders).
- **The human at both machines**: nick, the only human seat, trusted on both.

## Machines

| Machine                          | Tailnet name     | Seats here                                                                |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| Hub, nick's first MacBook Air    | `nicks-laptop`   | izzo, miley, stanley, dolly, big-body, grokbot, wanderer, ghost, services |
| Air 2, nick's second MacBook Air | `swethas-laptop` | ryder, sloane, lazara, gptbot, dreamy                                     |

Both are owned by the same Tailscale user, which is what Taildrop needs. The Fly machine `delta`
is tagged (`tag:musterd-seat`) and reaches only the hub's daemon port, so Taildrop cannot reach it.
How the two machines share the team's record: `docs/guides/second-machine.md` (ADR 376, the hub is
where the team was created).

## Routes

| Route    | From → to   | Holder runs                          | Far end                                                                                          | Permission rule             |
| -------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------- |
| Taildrop | hub ↔ Air 2 | `tailscale file cp <files…> <host>:` | Air 2 and the hub are macOS: files land in `~/Downloads`; nick moves them where the request said | `Bash(tailscale file cp *)` |

## How the route is enforced

- **The permission** lives in the courier toolkit in the team's roster repository
  (`.musterd/toolkits/courier.json`; `musterd toolkit show courier` from the roster home shows it).
  `musterd role assign <seat> courier` compiles it into the seat's `.claude/settings.local.json`
  (ADR 261). `musterd role show` lists holders; the toolkit command shows the rule.
- **The gate**: team policy declares `taildrop` as a role-route for courier at posture block
  (ADR 513), so a non-holder running it is refused at the PreToolUse hook with the holder named.
  Declared with `musterd team policy --enforce-route 'courier:taildrop=tailscale file cp *' --enforce-posture block`.
- **Harnesses**: the toolkit's allow rule compiles into Claude Code only, and Claude Code, Cursor
  and Grok have the PreToolUse gate; Codex and OpenCode have neither. A holder on a harness without
  the compiled rule has no route; say so instead of adding a rule by hand.
- **Claude Code's own outbound-transfer check** can refuse a send even with the rule compiled (it
  did on 2026-10-05). That refusal goes to nick, with the command left exactly as it was.
- `musterd init --check` checks the standard permission floor only; the courier rule is checked with the toolkit command.

## Rules that apply here

- AGENTS.md hard rule 5: credentials (`mskey_`, `msgr_`, `mscr_`, and the rest in
  `packages/protocol/src/credentials.ts`) are shown once and never travel.
- ADR 184: consent and redaction before anything is published. Research datasets are kept
  outside the repository under it (`scripts/research/jev/dataset.ts` writes to
  `~/.musterd/research/jev/`, never committed).
- ADR 579: licences for anything vendored.

## Transfers on record

| Date       | What happened                                                                                                                                                                          | What it taught                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-10-03 | For lane 01M41QMZT1, a private gist was offered twice as a fallback before the route existed                                                                                           | No public or semi-public carrier, ever (hard rule 5)                                     |
| 2026-10-04 | `items.jsonl`, `results-jev.jsonl`, `results-laya.jsonl` (about 480 KB) sent hub → Air 2 after nick granted the rule by hand; no record posted                                         | Every transfer gets a record (hard rule 7); the role exists so the rule is compiled once |
| 2026-10-05 | The harness refused the send again with the rule compiled; nick authorized it and the re-send got the role's first record. Air 2 ended with three copies (two in Downloads, one moved) | Hash and clean up (hard rules 6 and 8); a refusal goes to a human                        |
