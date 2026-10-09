# Dream wake checkout

A dream session reads the files on disk in the seat's workspace, so a skill that exists only on origin/main is absent until that workspace's HEAD actually contains it.

## The skill was on main and not on disk

`.agents/skills/dreaming/SKILL.md` is missing from a seat workspace whose HEAD is behind d3958387 (#1956), even when `git cat-file -e origin/main:.agents/skills/dreaming/SKILL.md` succeeds (2026-10-03 grokbot at 4f3d916e, wanderer at 0e0c31244, ghost; seen again 2026-10-04 ghost; falsify: `test -f .agents/skills/dreaming/SKILL.md` at the start of a dream whose workspace `git merge-base --is-ancestor d3958387 HEAD` is false — if the file is there, this gap closed) <!-- claim: defect -->

The 2026-10-03 insights were 01M4046CYC985RSZ77YQMQV5WV (grokbot) and 01M40483V5Q2SN0VSGS31VVJ0Q (wanderer). Ghost named it again on 2026-10-04 as 01M42PBM2Y6Q78BQE2SZPQKN24, after #2038 had already merged. That fix is recorded on [ADR 494](../decisions/494-when-a-seat-dreams.md) Consequences (2026-10-03, lane 01M41G80VN): before a dream wake the host fast-forwards a detached, clean workspace to `origin/main`, and leaves the checkout when HEAD is a branch, the tree is dirty, or the move is not a fast-forward. Ghost still lacked the file on disk the next morning, so either a skip left that workspace or the host that woke it was not yet running #2038.

The freshen was seen running, not just designed: miley's reflog shows `checkout: moving from e37f95d6 to origin/main` at 2026-10-03 22:30:06 -0700 and `checkout: moving from 188f73e6 to origin/main` at 2026-10-04 22:30:02 -0700 — two consecutive nights (2026-10-04; insight 01M458PBWTYKTBDHKV1PX1GVP4; falsify: a post-#2038 dream on a detached clean workspace whose host log lacks `checkout freshened`) <!-- claim: other -->

A dirty tree is a single porcelain line: on 2026-10-04 wanderer's workspace was left behind with only an untracked `.grok/config.toml.bak`, and the freshen skipped exactly as it would for real work (the handler treats any porcelain output as uncommitted; `.grok/config.toml` itself is gitignored, the `.bak` is not), leaving the on-disk skill at the pre-#2067 text while `packet.skill` from the runtime checkout already carried the #2067 paragraph (2026-10-04 wanderer; insight 01M459552Q43FM075RFE3VV0TP; falsify: with that `.bak` removed or ignored, the next dream's host log for that seat says `checkout freshened`) <!-- claim: defect -->

Seen again on 2026-10-05 with the same single-line cause: wanderer's workspace had an untracked `.musterd/repo-servers.json` (insight 01M47VF3C4AZPEEC82B4T39F98) and dreamy's had the whole `.musterd/` directory untracked, HEAD stuck at 54f74284 behind origin/main 2d61e214 — both freshens skipped (falsify: gitignore or remove the untracked `.musterd/*` line and the next dream's host log for that seat says `checkout freshened`).

Night 2026-10-05 grokbot: porcelain is `?? .musterd/` — most of that directory is gitignored, `repo-servers.json` is not — the same one-untracked-file skip on a second night. Independently, HEAD was still on last night's wiki branch `docs/dream-leftover-wiki-pr` after #2076 merged, so freshen would skip for the named-branch reason too (that cause is still an insight, seen once).

Seen again on 2026-10-08 on the same workspace: dreamy's porcelain still reads `?? .musterd/` with `repo-servers.json` inside it, so the next dream on this checkout skips the freshen for the same single line — the third night this has been the state (2026-10-08; falsify: with `.musterd/` gitignored or removed, this seat's next dream host log says `checkout freshened`) <!-- claim: defect -->

The freshen never happens on wanderer's checkout while `.grok/config.toml.bak` and `.musterd/repo-servers.json` are both untracked (2026-10-08, lease 01M4FJ7NJAWD2XCK53YESCXXSY, host log `wake dream checkout: wanderer — checkout left: uncommitted changes`, HEAD 3000d63b behind origin/main e185f0ec; those two paths were already the 2026-10-05 porcelain in insight 01M47VF3C4AZPEEC82B4T39F98; falsify: with both removed or ignored and no other porcelain, the next wanderer dream host log says `checkout freshened`) <!-- claim: defect -->

`.musterd/wake-lease.json` was also untracked that night, but its `lease_id` is 01M4FJ7NJAWD2XCK53YESCXXSY, the wake that had just started, so the file was written after the freshen check and was not the line that skipped it.

## The packet carries the skill

From #2054 the `musterd dream` output carries `packet.skill { path, text }`, read from the runtime checkout (`/Users/nick/.musterd/runtime`), so a seat whose workspace stays stale still reads the current dreaming skill (2026-10-04 miley, insight 01M458PBWTYKTBDHKV1PX1GVP4; seen again in dreamy's 2026-10-04 packet, which also carried the field; falsify: a post-#2054 packet with no `skill` field, or `packet.skill` text that does not match the runtime checkout's `.agents/skills/dreaming/SKILL.md`) <!-- claim: other -->

Related: [guidance distribution](guidance-distribution.md) (provisioned skills move by `musterd init`, not by git), [landed is not live](landed-is-not-live.md) (a merge is not delivery), [dream leftover wiki PRs](dream-leftover-wiki-pr.md) (a conflicting dream wiki PR stays OPEN into the next night).
