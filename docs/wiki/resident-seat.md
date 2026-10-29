# Enrolling a resident seat

A resident seat is a Member enrolled with harness `musterd`, run in-process by `musterd host` on an API key the operator names (ADR 588). Enrolling one is opt-in per seat and needs a git checkout and a human-bound folder before anything else.

## The steps

1. **Have a git checkout.** `musterd agent` needs a repo checkout to work in; a bare folder does not enroll.
2. **Bind a human-owned folder.** The seat's workspace is a folder a human owns; the seat is jailed to it (ADR 588 Decision 4).
3. **Mint the seat with the installer, not by hand.** `bootstrap mint --install --into <folder>` writes the seat credential where the host reads it. Do not copy a printed key.
4. **Put the key in the Keychain.** Enrol with `musterd residency on --harness musterd --key-env <VAR>`, then store the key as the Keychain item `musterd:<VAR>`: `security add-generic-password -s musterd:<VAR> -a musterd -w`. With `-w` last, `security` prompts for the key, so it stays out of shell history. The host reads the item at each wake when `<VAR>` is unset in its own environment (ADR 605). The host registry stores the variable name, never the value.
5. **Confirm the roster shows the seat `hearing`.** The Keychain is read at each wake, so the host does not need a restart. A key put in the host's environment instead does: `launchctl kickstart` the host job after setting it.

## Three traps

- **No checkout, no seat.** A folder that is not a git checkout looks enrolled and then fails at the first wake. Check `git -C <folder> status` first.
- **Never a printed key.** Printing the minted key into a terminal or a file puts it in scrollback and logs. Let `--install --into` write it.
- **Never `launchctl setenv` a key named `ANTHROPIC_API_KEY`.** It puts the key in the environment of every process the user starts, and Claude Code and the Anthropic SDKs read that variable on their own, so anyone else on that macOS login spends the key. It also disappears on reboot. On 2026-10-15 a 10:24 reboot cleared it, and the pilot's worker seat deferred every wake until a person noticed (ADR 605). Use the Keychain item from step 4. It survives reboots and only `musterd host` asks for it. It is not a lock against someone who shares your macOS login and goes looking for it: they can read the item, as they could read a process's environment. Separate logins are the boundary.
- **The seat file must reach the roster remote, or every other machine's sync stops at the seat's first event.** `musterd agent` and `team add` push `.musterd/seats/<seat>.toml` themselves now (ADR 592) and print one line saying so; if they print a warning instead, run the commands in it before enrolling. A hub whose fold stopped on the seat pulls the roster repo on its own once the file is pushed — a stop that lasts longer than a minute names a root a person must `git pull` by hand (the hub's log, `sync_roster_refresh_failed`). On 2026-10-13 the file sat uncommitted for 100 minutes and held every lane on the team (ADR 591).

## A resident seat cannot stop its own lane wakes

While a resident seat owns a lane, the host keeps waking it every one to three minutes, even when the lane hasn't changed. Each wake is a fresh session, billed to the operator's key. The seat itself can't turn the wakes off. To stop them, a person parks the lane, takes it off the seat, or stops `musterd host`.

- A lane set to `blocked` keeps waking its seat. On night 2026-10-14, mason got 13 no-op `continue_lane` wakes on blocked lane `01M4FF0P6H`, about one a minute (insight `01M4Z8A0R1`). (2026-10-14; falsify: a blocked lane owned by a resident seat goes 30 minutes with no lane wake while nothing on it changes) <!-- claim: defect -->
- Being away doesn't hold lane wakes, and blocking a lane moves them to the seat's next lane. On night 2026-10-16, mason was away until 02:48Z at nick's request, to save spend. After its Console lane was blocked, the wakes moved to its next owned lane, `01M5162W38`: eight no-op `begin_lane` wakes between 19:09Z and 19:30Z (insight saved that night). (2026-10-16; falsify: a resident seat set to away with one or more owned lanes goes 30 minutes with no lane wake while nothing on its lanes changes) <!-- claim: defect -->
- A seat can't park its own lane: `lane_update {state: parked}` from the seat is refused with "only a human may park". (2026-10-14; falsify: a resident seat's `lane_update {state: parked}` on its own lane succeeds) <!-- claim: defect -->

To pause a resident seat for spend, ask a person to park its lanes or stop the host. Setting it away won't do it.

Source: ADR 588 (`docs/decisions/588-resident-byok-seat.md`); lane `01M4W041S2Q9D55PKWWF4NTT7P`.
