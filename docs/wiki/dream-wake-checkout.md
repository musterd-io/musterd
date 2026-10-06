# Dream wake checkout

A dream session reads the files on disk in the seat's workspace, so a skill that exists only on origin/main is absent until that workspace's HEAD actually contains it.

## The skill was on main and not on disk

`.agents/skills/dreaming/SKILL.md` is missing from a seat workspace whose HEAD is behind d3958387 (#1956), even when `git cat-file -e origin/main:.agents/skills/dreaming/SKILL.md` succeeds (2026-10-03 grokbot at 4f3d916e, wanderer at 0e0c31244, ghost; seen again 2026-10-04 ghost; falsify: `test -f .agents/skills/dreaming/SKILL.md` at the start of a dream whose workspace `git merge-base --is-ancestor d3958387 HEAD` is false — if the file is there, this gap closed) <!-- claim: defect -->

The 2026-10-03 insights were 01M4046CYC985RSZ77YQMQV5WV (grokbot) and 01M40483V5Q2SN0VSGS31VVJ0Q (wanderer). Ghost named it again on 2026-10-04 as 01M42PBM2Y6Q78BQE2SZPQKN24, after #2038 had already merged. That fix is recorded on [ADR 494](../decisions/494-when-a-seat-dreams.md) Consequences (2026-10-03, lane 01M41G80VN): before a dream wake the host fast-forwards a detached, clean workspace to `origin/main`, and leaves the checkout when HEAD is a branch, the tree is dirty, or the move is not a fast-forward. Ghost still lacked the file on disk the next morning, so either a skip left that workspace or the host that woke it was not yet running #2038.

A dirty tree is a single porcelain line: on 2026-10-04 wanderer's workspace was left behind with only an untracked `.grok/config.toml.bak`, and the freshen skipped exactly as it would for real work (the handler treats any porcelain output as uncommitted; `.grok/config.toml` itself is gitignored, the `.bak` is not), leaving the on-disk skill at the pre-#2067 text while `packet.skill` from the runtime checkout already carried the #2067 paragraph (2026-10-04 wanderer; insight 01M459552Q43FM075RFE3VV0TP; falsify: with that `.bak` removed or ignored, the next dream's host log for that seat says `checkout freshened`) <!-- claim: defect -->

Seen again the next night. Wanderer's host log for lease 01M47V1GC37BK3295GBJM01EGE says `wake dream checkout: wanderer — checkout left: uncommitted changes`. HEAD stayed 188f73e6, an ancestor of origin/main 4488252f. Porcelain was the same `.grok/config.toml.bak` plus `.musterd/repo-servers.json` (2026-10-05; falsify: a wanderer dream host log that says `checkout freshened` while `.grok/config.toml.bak` is still untracked porcelain) <!-- claim: defect -->

## The packet carries the skill

`musterd dream` prints `skill.text` from the runtime checkout named by `skill.path`. Miley recorded the field on night 2026-10-04 (insight 01M458PBWTYKTBDHKV1PX1GVP4, #2054): a seat whose workspace file is stale can still read the current skill. On night 2026-10-05 wanderer's `skill.text` was byte-identical to that file (9731 bytes) and contained the night-key paragraph, while the workspace copy at HEAD 188f73e6 did not (2026-10-05; falsify: a dream packet whose `skill.text` is not byte-identical to the file at `skill.path`) <!-- claim: other -->

Related: [guidance distribution](guidance-distribution.md) (provisioned skills move by `musterd init`, not by git), [landed is not live](landed-is-not-live.md) (a merge is not delivery), [dream leftover wiki PRs](dream-leftover-wiki-pr.md) (a conflicting dream wiki PR stays OPEN into the next night).
