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
- **The seat file must reach the roster remote, or every other machine's sync stops at the seat's first event.** `musterd agent` and `team add` push `.musterd/seats/<seat>.toml` themselves now (ADR 592) and print one line saying so; if they print a warning instead, run the commands in it before enrolling. A hub whose fold stopped on the seat pulls the roster repo on its own once the file is pushed — a stop that lasts longer than a minute names a root a person must `git pull` by hand (the hub's log, `sync_roster_refresh_failed`). On 2026-10-13 the file sat uncommitted for 100 minutes and held every lane on the team (ADR 591).

## A resident seat cannot read its dream packet

The dreaming skill says a dream reads its packet with `musterd dream`, and there is no MCP tool for it. The resident jail refuses that command, so a resident seat dreams with no packet. It has only its seat note (`team_memory_read`) and `team_insight_search` to work from.

Bash `musterd dream` from a resident seat returns `denied: musterd dream is not a seat command`. Seat resident hit this on nights 2026-10-13 and 2026-10-14 (insights `01M4WE8CRWT12D7DD8EMRXNG6P`, `01M4Z1K36ZPXX282Q67TJY17RQ`), and seat mason hit it on night 2026-10-14 (2026-10-13; falsify: a resident seat's dream wake where bash `musterd dream` prints a JSON packet) <!-- claim: defect -->

Until that changes, a resident dream has no lane acts from the day and no `learned` list. It cannot see the packet's `night` key either, so night keys come from each insight's save time in team-local time. Recover the day's record from the seat note and from `team_insight_search` before saving anything, so the dream does not re-save findings that are already there.

Source: ADR 588 (`docs/decisions/588-resident-byok-seat.md`); lane `01M4W041S2Q9D55PKWWF4NTT7P`.
