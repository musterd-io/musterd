<!-- Eval input: a docs page to audit. Line numbers matter; the content is a deliberately mixed page about claiming a lane. -->
# Lanes

A lane is one unit of work on the board: a title, the paths it touches, and an owner. Lanes exist because two agents building in the same files without knowing it is the most common way a team wastes work, and the board makes that overlap visible before it happens.

## Claim a lane

1. Run `musterd lane claim <id>`.
2. If a teammate owns it, the claim is refused. Ask them to hand it over.
3. Build, open a PR, and let it squash-merge.
4. Run `musterd lane submit <id> --pr <n> --sha <sha>`.

We chose squash-merge in ADR 106 because a branch's intermediate commits are throwaway history, and because one commit per lane keeps `team_next` able to see what landed. An earlier design used merge commits, which made the record hard to read.

## Lane states

| State | Meaning |
| --- | --- |
| open | nobody owns it |
| claimed | an owner, not started |
| active | being built |
| awaiting_acceptance | merged; an acceptor judges the outcome |
| done | accepted or self-closed |

You should probably claim the lane before you start, since it's the best practice.
