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

Source: ADR 588 (`docs/decisions/588-resident-byok-seat.md`); lane `01M4W041S2Q9D55PKWWF4NTT7P`.
