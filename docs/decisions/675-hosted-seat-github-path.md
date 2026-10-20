# 675 — A hosted seat lands its own PR: GitHub origin on the workspace, gh credential outside the jail

- Status: accepted
- Date: 2026-10-20
- Lane: `01M5BA87RCAR56THK1BPFK0E6Z` (goal `cloud-agents`)
- Builds on: ADR 463 §3 (a clone per seat), ADR 648 (the cloud host provisions its sponsor's
  seats), ADR 583 (the gateway holds the model key; the shell never sees it), the jail
  (`host/engines/jail.ts`: readers stay inside the workspace, `scrubEnv` drops anything that looks
  like a credential, `gh` is `gh pr …` only, `git` is a subset with no `credential` or `config`)

## Context

The cloud pilot's first board work order (2026-10-19, lane `01M5BA17DR` on `revive-staging`)
ran well until the end: `pilot-2` wrote the page, committed, pushed — and the push landed in
`/data/work/repo`, the machine's local mirror, because the provisioner clones a seat's workspace
from the host's checkout and a local clone's `origin` is that path. `gh pr create --draft` then
exited 4: the jail scrubs `GH_TOKEN` from every bash child by design, and nothing else on the
machine had signed gh in. The branch had to be carried off the machine by hand, twice.

`GH_TOKEN` was already on the machine, as a Fly secret the entrypoint header describes as "a
fine-grained token for the workspace repo (clone, push, PRs)". The 2026-09-06 cloud seat
(`docs/wiki/cloud-seat-from-inside.md`) pushed and opened PRs with it — its workspace's origin was
GitHub and the token was in the environment, before the jail existed.

## Problem

A hosted seat must push to GitHub and open a PR from inside the jail, and the jail must keep its
rule that a shell never sees a credential. Putting `GH_TOKEN` back in the environment would undo
the rule (`printenv` is an allowed reader). Having the host forward branches and open PRs on the
seat's behalf would keep the rule but needs a new verb on the wire and a second actor on every PR.

## Decision

1. **The seat's clone points at the real remote.** `provisionWorkspace` takes an `origin`; a clone
   gets `git remote set-url origin <origin>` after cloning (the objects still come from the local
   source). The cloud host passes its mirror's own `origin` URL (`musterd host --cloud-provision`),
   so a cloud seat's pushes leave the machine. A sponsor's own host passes nothing: a laptop clone
   keeps git's default, as before.
2. **gh holds the credential, outside the jail.** _(Amended 2026-10-20: "outside the jail" means out of the shell's reach, not out of the seat user's — see the note in Consequences.)_ The entrypoint moves `GH_TOKEN` to a shell local,
   unsets it, signs gh in with it (`gh auth login --with-token`, stored under `$HOME/.config/gh`,
   mode 0600, outside every workspace) and sets git's credential helper to gh (`gh auth
   setup-git`). The host loop starts with no `GH_TOKEN` in its environment. The seat's `git push`
   and `gh pr create` authenticate through gh; the shell cannot reach the token: readers may not
   leave the workspace (`~`, `..`), `gh auth …` and `git credential …` and `git config …` are not
   on the allowlist, and `scrubEnv` would drop the variable even if it were set.
3. **No new verb.** `gh pr create|view|merge …` already is the seat's PR verb in the jail; this
   ADR makes it work. A missing or failed `GH_TOKEN` is one line in `host.log` at boot ("the seat
   can clone and commit but not push or open PRs") and nothing else changes.
4. **What this grants, and to whom.** The seat's processes, not its shell, can push any non-main
   branch without force and open PRs on the one repository the fine-grained token names. A
   prompt-injected seat can therefore push a bad branch or open a bad PR there; it cannot merge
   past branch protection, reach another repository, or read the token out. The token's scope and
   expiry are the sponsor's: fine-grained, this repository, contents and pull requests, and short.

## Consequences

- A cloud seat provisioned after this ADR lands PRs itself. A workspace provisioned before it
  keeps its local-path origin until someone runs `git remote set-url origin <url>` in it once (the
  pilot's `pilot-2` was repointed by hand on 2026-10-20); the entrypoint's gh sign-in reaches
  every seat at the machine's next boot.
- _2026-10-20, from the automated security review of #2982:_ the pilot machine runs the host
  loop, the engine and the jail as one user (`seat`), and everything on the volume is that user's.
  So gh's credential file is readable by any code the jail may run as that user — a pnpm script,
  `vitest`, `eslint` — exactly as the model key in the host process's environment and the host key
  already are. The shell cannot reach it; same-user code can. That class is not this ADR's to
  close: it is the resident-bash OS sandbox lane (`01M4VYT6JWHYG6E8ZZ9J55AS9X`), which separates
  the jail's user from the host's; until then a hosted seat's push token is as exposed as its
  model key, and should be scoped and short-lived for the same reason. Two tightenings from the
  same review landed with this note: the clone's origin is stripped of any userinfo before it is
  written to the workspace (`publicOriginUrl`), and `git push` in the jail is an allowlist, not a
  deny-list (git accepts abbreviated long options, so `--mir` is `--mirror`): only `-u`,
  `--set-upstream`, `--force-with-lease`, `-q`, `--dry-run`, the remote `origin`, and the seat's
  own branch by name or `HEAD` — the native backend hands the jail the workspace's checked-out
  branch for that bound (second review round, 2026-10-20). Branch protection on `main` must apply to the token's account too (an
  admin's fine-grained token can bypass unprotected-for-admins rules); the pilot's token is the
  sponsor's, so "include administrators" is the setting to keep on.
- The host-forwarding design (the host pushes `agent/*` refs and opens PRs for the seat, the token
  never on the same machine as the model) is not taken. It stays the answer if the security track
  decides a seat's processes must not hold a push credential at all.
- Tests: the clone's origin is the given URL and the plain clone keeps the local path
  (`onboard/workspace.test.ts`); the cloud host's `origin` reaches the workspace factory
  (`host/provisioner.test.ts`); the jail refuses `gh auth token|status`, `git credential fill`,
  `git config`, and reads of `~/.config/gh` (`host/engines/jail.test.ts`).

## Observability & Evaluation

- **Traces:** `host.log` at boot carries one of `gh: signed in from GH_TOKEN …`, `! gh: sign-in
  from GH_TOKEN failed …`, or `gh: no GH_TOKEN …`. A seat's PR shows the seat as commit author and
  the token's account as the PR author; the lane's `pr` claim then verifies on `lane_submit`.
- **Eval:** the three test files above; live, `pilot-2`'s next work order ends in a PR it opened
  itself, with no bundle carried by hand.
- **Experiment:** n/a — a fix to the pilot's push path, judged by its tests and the next work
  order.
