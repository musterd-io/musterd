# Enrolling a resident seat

A resident seat is a Member enrolled with harness `musterd`, run in-process by `musterd host` on an API key the operator names (ADR 588). Enrolling one is opt-in per seat and needs a git checkout and a human-bound folder before anything else.

## The steps

1. **Have a git checkout.** `musterd agent` needs a repo checkout to work in; a bare folder does not enroll.
2. **Bind a human-owned folder.** The seat's workspace is a folder a human owns; the seat is jailed to it (ADR 588 Decision 4).
3. **Mint the seat with the installer, not by hand.** `bootstrap mint --install --into <folder>` writes the seat credential where the host reads it. Do not copy a printed key.
4. **Put the key in launchd's environment.** The API key goes into the launchd job's env under the variable name the seat was enrolled with (`musterd residency on --harness musterd --key-env <VAR>`). The host registry stores the variable name, never the value.
5. **Kickstart the host.** `launchctl kickstart` the host job so it re-reads its env and spawns the seat. Confirm the roster shows the seat `hearing`.

## Three traps

- **No checkout, no seat.** A folder that is not a git checkout looks enrolled and then fails at the first wake. Check `git -C <folder> status` first.
- **Never a printed key.** Printing the minted key into a terminal or a file puts it in scrollback and logs. Let `--install --into` write it.
- **The key lives in launchd's env, and the host must restart to see it.** Setting the variable in a shell does nothing to a running host. Kickstart after every key change.

Source: ADR 588 (`docs/decisions/588-resident-byok-seat.md`); lane `01M4W041S2Q9D55PKWWF4NTT7P`.
