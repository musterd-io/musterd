# Wake take-over — coming back to a seat a wake holds

- Date: 2026-10-07
- Goal: `wake-take-over`
- Authors: nick (intent and choices), dolly (design)
- Builds on: ADR 543 (the launcher names a wake), ADR 491 Decision 6 (a live seat is launched
  again only after a warning), ADR 092 (a same-workspace successor ends its predecessor), ADR 354
  (the wake-lease file), ADR 241 (the wake lease on a Presence)

## Why

On 2026-10-07 nick ran `musterd dolly` to continue what dolly had been working on. A wake was live
in that folder: a headless `claude -p` the host had started five minutes earlier to carry on with
the same lane. nick did not know it existed. Both wanted the same thing: carry on with dolly's lane.

Today the launcher offers `y/N`. Answering `y` does this (checked in code):

1. The person's session claims the seat. After the ADR 092 grace (5 s), the server disconnects the
   wake's musterd connection, and the wake's MCP adapter exits (`onReplaced`).
2. The wake's `claude -p` keeps running, without musterd tools, in the same folder, until it ends or
   times out.
3. The lane is not handed to anyone. It stalls, and only a `claim.superseded` audit row records it.

## What success looks like

- When a person comes back to a seat a wake holds, the person ends up driving: the wake is musterd
  keeping work moving while nobody is there, not a peer to negotiate with.
- The work carries over. The person lands in the wake's own conversation, and does not need to know
  the wake existed for that to happen.
- Two live sessions never share one folder.
- The person can watch the wake first and decide.

## Decisions nick made

- Offer both **take over** and **watch** (2026-10-07).
- **⏎ defaults to take over** (2026-10-07). Watch is one key away.
- Take over lands in **the wake's conversation**, not the person's previous one and not a fresh one.

## The prompt

When `musterd <seat>` (or the picker) finds the seat live, and the live Presence is a wake on this
machine:

```
dolly is busy — a wake started 09:24 to carry on with lane 01M46YWG8Y.
  ⏎  take over   stop the wake, continue its conversation here
  w  watch       follow it live; ⏎ takes over at any point
  esc cancel
```

The reason clause comes from the roster's `wake_for` (ADR 543). A live session a person opened keeps
the `y/N` question unchanged.

## 1. Take over

1. **Find the wake.** The launcher reads `.musterd/wake-lease.json` in the seat's folder (ADR 354).
   It names the wake's process (`spawner_pid`) and lease, and gains one field, `session_id`: the
   conversation id the host passed the harness (`--session-id`). The host already chooses that id,
   so it only writes it down. _Correction (2026-10-07, while planning): today only the Codex
   backend writes this file; Claude Code wakes pass the lease through the environment alone. The
   Claude Code backend gains the same write._ If the file is missing or expired, or its lease does not match the
   roster's `wake_lease`, the launcher shows ADR 543's question instead and touches nothing.
2. **Ask it to stop at a tool boundary.** The launcher writes a yield marker,
   `.musterd/wake-yield.json` `{lease_id, by, at}`, in the seat's folder. A wake's `PreToolUse` hook
   runs `musterd gate` (wakes load the seat's `settings.local.json` through `--setting-sources
   project,local`). When the marker names the session's own lease, `gate` denies the call with: "a
   person has taken over this seat — end your turn now; do not retry". The model ends its turn and
   `claude -p` exits. A tool call already running finishes first.
3. **Hard stop.** If the wake process is still alive 10 s after the marker is written, the launcher
   sends SIGTERM to its process group, and SIGKILL 5 s later, the same escalation the host uses for
   its own timeouts (`host/backends/claudeCode.ts`).
4. **Record the run as `yielded`.** The host sees its child exit, finds the yield marker for that
   lease, removes it, and sends `yielded: true` on the supplementary wake report it already sends at
   run exit (recorded on `residency.wake_cost`). The primary report landed at verification, long
   before any take-over, so a `yielded` wake never counts as a failed wake. It does not re-derive a wake for the same
   lane while the person's session is attached, because the attended-session deferral already
   covers that.
5. **Open the wake's conversation.** The launcher runs the harness with `--resume <session_id>` in
   the person's terminal, as the same seat. The lane stays the seat's, so there is no handoff. The
   session's first turn carries one line: "you took over a wake that was carrying on with lane
   01M46YWG8Y".

## 2. Watch

A live view of the wake's transcript (`~/.claude/projects/<folder>/<session_id>.jsonl`), read
incrementally with the existing transcript reader (`trace/transcript.ts`, `trace/tail.ts`):

```
watching dolly · wake · carry on with lane 01M46YWG8Y · started 09:24 · $1.64
  09:27  ▸ team_wake_context  lane 01M46YWG8Y
  09:27  “The umbrella's three PRs are merged; checking main has all of them.”
  09:28  ▸ Bash  git log --oneline origin/main -5
  09:29  ▸ lane_submit  01M46YWG8Y → nick
  ⏎ take over · esc leave it running
```

- Assistant text is trimmed to one line per message. A tool call shows its name and one short
  argument (a command, a path, a lane id). Tool results are not shown.
- It opens with the last 10 events, then follows new ones.
- All text passes through `scrubCredentials` before it is printed.
- **⏎** runs §1. **esc** exits and leaves the wake running.
- **The wake exits while watched:** the launcher is not its parent and cannot read an exit code,
  so it reads the transcript. If the last assistant record stopped on `end_turn`, the view says
  `wake finished — opening its conversation` and resumes it. Otherwise it says `wake ended before
  finishing` and asks `⏎ open its conversation · esc quit`.
- Watch is read-only. It writes nothing to the folder or the daemon.

## 3. Edges

- **No TTY.** `--take-over` runs §1 without a prompt, and `--watch` opens §2. `--force` on a live
  *wake* means take over. On a live session a person opened, `--force` keeps today's meaning. With
  no TTY and no flag, the launcher refuses, names the wake (ADR 543), and names both flags.
- **The picker** shows the same menu in its confirm step, from the shared function in
  `launcher/rows.ts`.
- **A wake on another machine:** "dolly is live on mini-2 — a wake to carry on with lane X. Take
  over from there." Nothing is stopped across machines.
- **Unchanged:** the `y/N` question for a live session a person opened, and ADR 092's same-folder
  replacement.

## Protocol and ADR

One ADR covers:

- `session_id` on `WakeLeaseFileSchema` (optional, so older hosts still parse),
- `yielded` on the (supplementary) wake report,
- the take over / watch prompt replacing `y/N` for a local wake. This amends ADR 491 Decision 6
  and ADR 543.

## Testing

- **Unit:** the menu text and keys. The yield check in `musterd gate`: it denies only for the
  session's own lease, and an absent or expired marker is a no-op. Parsing `session_id`. Watch
  lines rendered from a recorded transcript. The finished and failed endings.
- **Integration:** a fake harness child that loops on tool calls until `gate` denies one, then
  exits. Assert that the lease settles `yielded`, that no wake for the same lane re-fires while the
  person is attached, and that the hard stop fires when the child ignores the marker.
- **End to end:** `musterd <seat>` with a fake `claude` binary. Take over ends with the wake process
  gone and `--resume <wake session_id>` invoked. Watch, then esc, leaves the wake running.

## Increments

| # | Lane | What |
| --- | --- | --- |
| 1 | `01M4C6VGFH9G9XC3Q9D5SPET2H` | Protocol and host: `session_id` in the wake-lease file; the `yielded` outcome; the ADR |
| 2 | `01M4C6VMNF59JHWAKCGFTA48RH` | Yield and stop: the marker, the `gate` denial, the hard-stop escalation |
| 3 | `01M4C6VNN7HDB9GCXF08GTZ2BV` | Launcher: the menu in `musterd <seat>` and the picker, take over, flags, `--force` on a wake |
| 4 | `01M4C6VP9V8RY75B3HYGT51PX0` | Watch mode |

Each increment depends on the one before it.

## Out of scope

- Taking over a wake on another machine.
- Changing what happens when two sessions a person opened meet (ADR 092 stands).
- What `-r` resumes when no wake is live. Today it resumes the binding's last session, which can be
  a finished wake's. That is worth a separate look, not this Goal.
