# Halt as revocation — the first real halt, measured

A human halting an agent seat (ADR 501) revokes its musterd authority within one call and evicts its socket within milliseconds, but stops its local tool calls only on a harness that runs the PreToolUse gate — Codex has no such hook, so a halted Codex seat keeps working locally until it next touches musterd.

## What halt does, from the ledger (ADR 501)

`musterd halt <seat> --reason "<why>"` (human-only; admin any agent, a non-admin only the agents
they sponsor) sets the halt standing on the member, revokes every live session lease, evicts every
live presence, expires any unspawned wake lease, audits `seat.halted`, and delivers a `steer` to the
seat. While halted, every authenticated call from the seat answers `forbidden` "halted by <human>:
<reason>", both claim handshakes refuse with code `halted`, and residency hands the seat to no host.
`musterd resume <seat>` lifts it. The honest limit, stated on every surface: the halt lands at the
seat's next tool boundary or musterd call — nothing is killed.

## The dogfood run — 2026-10-03, big-body on Codex, mid-task

nick ran `musterd halt big-body --reason "dogfood halt"` while big-body (surface `codex`, model
`gpt-6-luna`, workspace `big-body@fix/raw-error-response`) was working a review. The CLI printed
the frame as specified, including `1 live session evicted`. Audit rows (`~/.musterd/musterd.db`):

| moment (UTC)   | row                                                            | gap from halt |
| -------------- | -------------------------------------------------------------- | ------------- |
| 20:14:33.877   | `seat.halted` by nick — 4 leases revoked, 1 presence evicted   | 0             |
| 20:14:33.877   | 4× `agent_session_lease.revoked` (cause `halt`)                | 0             |
| 20:14:33.877   | `presence.session_ended` (cause `halt`, halted_by nick)        | 0             |
| 20:14:33.897   | daemon log `ws_close` for big-body                             | **20 ms**     |
| 20:15:29.509   | `GET /inbox` → 403 — the seat's next musterd call, refused     | **56 s**      |
| 20:15:41–20:16 | interrupt-check, trace, telemetry, inbox all → 403, repeatedly | —             |

Four leases were live at the halt (the adapter's, renewed twice, plus two short CLI occupancies
from hook one-shots) and all four died in the one transaction. No `claim.refused` row: the seat did
not try to re-claim. No `seat.resumed` yet at the time of writing.

**What the seat experienced.** After the halt, big-body made a few more LOCAL tool calls, then
wrote: _"The roster also reports this big-body session was evicted when Nick halted the seat, so I
won't send a verdict or rejoin and risk displacing its current holder."_ Two readings:

- The seat learned it had been halted from musterd's own words — the `superseded`-style close and
  the 403 sentence — and stood down on its own. That is the notice the design wanted, without a
  harness channel.
- Its local tool calls were not denied, because **Codex wires no PreToolUse hook**: its
  `.codex/hooks.json` carries SessionStart, SessionEnd, PostToolUse and UserPromptSubmit only, so
  the gate has no event to ride on that harness (2026-10-03; falsify: `grep PreToolUse packages/cli/src/onboard/harnesses/codex*.ts` finds a wiring, or big-body's hooks.json gains one). <!-- claim: defect -->
  Claude Code, Cursor and Grok onboarding do wire PreToolUse,
  so on those harnesses the next tool call is denied with "halted by nick: dogfood halt — a human
  lifts it with `musterd resume big-body`". On Codex the halt is revocation and eviction only —
  exactly the limit ADR 501 Decision 6 names, now observed rather than argued.

Measured on the live ledger (2026-10-03; falsify: re-run a halt on a Claude Code seat mid-tool and read the `gate.denied`-shaped hook output — a Codex seat will show only 403s, a Claude Code seat a PreToolUse deny; if the Codex seat's local tools are denied, this page is wrong about the hook). <!-- claim: other -->

## Verdict for lane 01M41DRZTY

Criteria from the spec §6: the halt revoked every lease and evicted every presence (yes); the seat's
next musterd call was refused with the reason (yes, 56 s later — the seat's own cadence, not the
daemon's); the next tool call was denied (**no on Codex, by construction**; untested on Claude
Code in the wild). The window between the halt and the seat actually stopping is therefore
harness-bound: 20 ms to the socket, one musterd call to the refusal, and on a gated harness one
tool boundary. On Codex it is "whenever the seat next reads musterd" — which it did within a
minute and then stood down.

Follow-up worth a lane: a Codex PreToolUse equivalent if the harness ever exposes one; until then
the halt frame on Codex seats should say "local tools are not gated on this harness".

Related: [`delivery-measurement.md`](delivery-measurement.md) (the same tool-boundary rail, measured
the other way), ADR 501, the spec `docs/superpowers/specs/2026-10-03-halt-as-revocation-design.md`.
