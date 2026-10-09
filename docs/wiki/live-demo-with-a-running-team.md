# Live demo with a running team

What a live demo that wakes real members taught us on 2026-10-09 (Demo Day): timings, the traps, and the commands that behave differently from how their names read.

Source runs: three one-sentence requests to the same four enrolled members, the last one live. The log is `docs/demo/demo-day-2026-10-09/rehearsal-log.md`. Every claim below carries the date it was observed and what would disprove it.

## Timings

- **A request to four enrolled members is fully answered in 2 to 5 minutes, and the first reply arrives in about a minute** (observed 2026-10-09). First and last reply, in minutes and seconds: run 1 0:54 and 4:58; run 2 0:52 and 3:34; live run 0:57 and 2:19. Falsify: send one huddle to the same four and read the turn timestamps with `musterd huddle show <id> --json`; a last reply under 60 seconds disproves it.
- **The slowest member improved from 4:58 to 2:19 once every member had a recorded session to resume** (observed 2026-10-09). Run 1 had two failed resumes and one cold start. The live run had none. Falsify: wake a member whose session record is stale and check `session=resumed` in `~/.musterd/host.log`; a fast resume from a stale record disproves it.
- **A 3-minute slot cannot hold a send-and-wait demo that starts at the half-way point** (observed 2026-10-09, when the slot shrank from 6 minutes to 3). Send the request in the first 20 seconds and keep talking while members arrive. Falsify: a request that is fully answered inside 90 seconds on this laptop.

## Members start one at a time

- **The wake host actuates due wakes serially, and polls each host-label group after the previous group's wakes verify** (read from `packages/cli/src/host/loop.ts`, 2026-10-09; the file's own comment says "Orders are actuated one at a time"). Two members were claimed 1.5 seconds after the send and two 45 seconds after, and members appeared on the office floor one after another. Falsify: send one huddle to four enrolled members and decode the lease ids as ULIDs; four timestamps within 2 seconds of each other disprove it.
- Lane `01M4HGY13ZZY0SZ6XBF0K0R1KH` proposes bounded concurrency. The reason for the serial design is not stated in the code that was read.

## Replies can arrive without a thread

- **A reply that references the huddle root by `meta.in_reply_to` but carries `thread` = null is not counted as a turn** (observed 2026-10-09, run 1: one of four members looked silent for the whole run). The composer's reply footer fixed it: in run 2 and the live run all four replies were counted. Falsify: a reply with `thread` = null that `huddle show` lists as a turn.
- A huddle addressed to `@team` summons nobody (ADR 386). A pasted backslash line continuation turned `--to` into message text and sent a huddle to `@team`, which woke nobody (observed 2026-10-09). Falsify: the same paste reaching the named members.

## Wake policy commands

- **`musterd residency on` replaces a member's whole override set, not only the flags passed** (observed 2026-10-09: passing `--cooldown` and `--hourly-cap` without `--flow auto` reset four members to `flow manual`; `residency status` showed it). Pass every override you want to keep. Falsify: `residency on` with one flag leaving the others set.
- **`musterd residency policy` sets team defaults only; `--seat` is ignored** (read from `packages/cli/src/commands/residency.ts`, 2026-10-09; not run). There is no per-seat form besides `residency on --seat <name> --workspace <folder>`, which re-registers the member on this machine. Falsify: `residency policy --seat X --flow manual` followed by a `residency status` that shows only X changed.
- **`--tool-policy seat-policy` lets a wake edit under the workspace's own permissions** (observed 2026-10-09: dolly opened a draft PR 50 seconds after a handoff). Whether it works for a member on another harness is untested: opencode's wake backend auto-rejects permission requests in a non-interactive run, and codex and grok were not tried. Falsify: an edit by an opencode, codex or grok wake under `seat-policy`.

## A lane handed to an editing member keeps waking it

- **A lane handed to a member on `seat-policy` and never resolved by that member is worked again on every dispatch tick** (observed 2026-10-09: three extra wakes in about ten minutes, each re-doing the task, one opening a second draft PR after the first was closed). Resolve the lane from the member's own session as its last step, and write that step into the lane. Falsify: a handed-off lane that stays claimed and is not woken again.
- **The dispatch loop was already on for this team** (inferred 2026-10-09, because a handoff was derived as a `work_order`; `musterd team policy` is admin-only and was not read). Turning it on is team-wide: every offline member on `flow auto` that owns a claimed or active lane would be started. Falsify: `musterd team policy` showing the dispatch loop off.

## What moves `main` during a talk

- **Any merge to `main` restarts the daemon once the tip settles; the auto-refresher forces it after 15 minutes** (observed 2026-10-09 at 13:22 and 13:48). `musterd service hold --auto --for 6h` is the admin command that stops it. Whether a docs-only merge also restarts the daemon was not confirmed. Falsify: a docs-only merge after which the refresh log shows no bounce.
- **A web merge republishes `/live` about a minute later and reloads open pages** (observed 2026-10-09 at 13:37). The daemon hold does not cover it. Falsify: a web merge after which an open `/live` page stays loaded.
- **A human's own CLI sends do not reach that human's own open `/live` tab** (read from `packages/server/src/protocol/route.ts` and `transport/hub.ts`, 2026-10-09; the symptom, a huddle bar that appeared only after a refresh, was seen once). The firehose skips the sender by member id, so a CLI send (HTTP) and a browser tab (WebSocket) are treated as one. Lane `01M4H7YKS5434WJWYQE1HRY3W1`. Falsify: open a huddle by CLI as the signed-in human and watch the tab without refreshing.

## The terminal

- **A shell function lives only in the terminal that defined it** (observed 2026-10-09). Closing the tab or opening a new one loses it. Put it in `~/.zshrc`. A pasted multi-line heredoc collapsed to one line and wrote nothing, and `zsh -n ~/.zshrc` confirmed the file was unchanged. Falsify: a function defined in one terminal and callable from a fresh one.
- Run `musterd` from the member's folder. From `~` it answers `missing bearer token`. A function that changes folder inside a subshell avoids it.

## The phone remote

- **A phone can step the deck through the artifact `room` capability, with the deck and the controller in one page** (built and tested with a stand-in room on 2026-10-09; the real two-device link was exercised once by nick and worked). The source and build script are in `docs/demo/demo-day-2026-10-09/remote/`. Publishing a new version reloads every open view and empties the room, so do not republish during a talk. Falsify: a republish that leaves an open deck page on its slide.
- **Two copies of the run of show drift.** The remote embeds a copy of `runofshow.html`; editing the standalone page changes nothing in the remote until it is rebuilt.
