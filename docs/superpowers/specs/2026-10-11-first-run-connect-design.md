# First run: connect the agents you already have — design

**Status:** design approved in conversation by nick, 2026-10-11. Lane `01M4FDBVGB` (stanley), goal
`first-run-10-minutes`, "First run 2/3". Context: [business plan brainstorm](2026-10-09-business-plan-design.md)
— the lead reason to adopt is "connect the agents you already have", and the first user is a solo
developer with two or more harnesses across one to three repos.

## Outcome

On a machine with two or more harnesses, one `musterd init` run connects every installed harness in
each repo the person picks, and those repos show up as seats on one roster. It takes three answers and
fits inside the 10-minute unassisted install test.

## Decisions (nick, 2026-10-11)

- **One seat per repo.** Each repo is one member, and every chosen harness is wired into it. Several
  harnesses share that seat (ADR 281). One seat per harness was considered and rejected.
- **One run reaches every repo.** `init` suggests the person's other repos from what the harnesses
  already recorded. Running `init` once per repo, or typing paths by hand, were the alternatives.
- **It lives inside `musterd init`.** It is the first option in the intent menu. A separate
  `musterd connect` command and a print-the-commands ending were the alternatives.

## What the person sees

After the team step, the intent menu gains a first option, and it is the default:

```
What would you like to do on revive?
● Connect the agents you already have
○ Add a new agent
○ Activate an existing member
○ Just me — watch the team live
```

Choosing it:

1. **Harnesses, once.** Detection shows as it does today. The multiselect starts with every installed
   harness selected. The answer applies to every repo.
2. **Repos.** A multiselect lists this folder first (selected), then up to 8 suggestions, most recent
   first:
   ```
   Which repos should be connected?
   ◼ ~/code/api      (this folder)
   ◻ ~/code/web      Claude Code, Cursor · 2h ago
   ◻ ~/code/infra    Codex · 3d ago
   ```
   If this folder is refused by `bindingRefusal` (`~`, a folder above a seat), it is left out of the
   list rather than ending the run.
3. **Per repo, without further prompts:** the seat is named after the folder (`web`; `web-2` if the
   name is taken), the member is declared, the Workspace is bound in place, every chosen harness is
   wired, and the musterd primer is added to `AGENTS.md` (appended to an existing file, never
   overwriting it). One result line per repo: `✓ web — Claude Code, Cursor`.
4. **Ending.** The roster with the new seats, then the command that starts each one
   (`cd ~/code/web && claude`). There is no 180-second wait for one agent to come online: with
   several repos there is no single agent to wait for.

Not asked on this path: role, toolkit, or join-on-launch. Seats get no toolkit and no role label;
`musterd agent` stays the detailed path. Join-on-launch is not a question because `provisionSeat`
always writes `autojoin: true` with a standing grant.

The existing menu options are unchanged.

## Structure

The per-repo work already exists: `provisionAgentSeat({ here: true, sourceDir })` (the path behind
`musterd agent --here`) declares the member, mints a credential scoped to that seat, issues a standing
grant, writes `binding.json`, `workspace.json` and `provisioned.json`, and runs the reconcile engine,
without creating a worktree. Every step is idempotent. The connect path calls it once per repo instead
of re-implementing init's inline steps.

New units:

- **`packages/cli/src/onboard/recents.ts`** — `recentRepos({ harnesses, home, now, limit })` returns
  `{ dir, harnesses, lastUsed }[]`. One reader per harness lives in the same file
  (`RECENT_READERS`, keyed by harness id), so the `Harness` interface does not change. Each is
  read-only and returns `[]` on any read or parse error:

  | Harness     | Source                                                                       |
  | ----------- | ---------------------------------------------------------------------------- |
  | Claude Code | the `cwd` field in `~/.claude/projects/*/*.jsonl`                             |
  | Codex       | the `cwd` field in `~/.codex/sessions/**/*.jsonl`                             |
  | Cursor      | `folder` in `~/Library/Application Support/Cursor/User/workspaceStorage/*/workspace.json` (and the Linux/Windows equivalents) |
  | Grok        | `~/.grok/trusted_folders.toml`                                                |
  | opencode    | `worktree` in `~/.local/share/opencode/storage/project/*.json`               |

  The shared part maps each folder to its git root, merges duplicates (keeping every harness and the
  latest time), and drops folders that are missing, under a temp directory, already bound to a seat,
  or refused by `bindingRefusal`. Claude Code, Codex, Cursor and Grok were checked on nick's laptop on
  2026-10-11; opencode's location is unconfirmed (not installed there) and its reader is tested only
  against a fixture.
- **`packages/cli/src/onboard/connect.ts`** — `runConnect(ctx)`: the repo multiselect,
  `seatNameFor(dir, roster)`, the per-repo loop (`provisionAgentSeat` then `upsertPrimer`), and the
  summary. It returns one result per repo. `init.ts` (1,299 lines) only gains the menu option and the
  call.

Unchanged: the other init paths, `provisionSeat`, the reconcile engine, the protocol, the server.

## Errors

- Reading recents never fails the run; with nothing found the picker shows only this folder.
- A repo that fails to provision gets a `✗ <name> — <reason>` line and the run continues. Exit code is
  1 if any repo failed.
- Partial wiring keeps the seat bound: `⚠ web — Cursor: <detail>; run musterd wire there`.
- Ctrl-C goes through the existing `guard`. Repos already done stay connected; a re-run skips them
  because bound folders are filtered out of the suggestions.

## Testing

- `recents.test.ts` — a fake `home` with one fixture per harness: merge across harnesses, git-root
  mapping, the four filters, ordering and the cap of 8, and a corrupt file yielding `[]`.
- `connect.test.ts` — `runConnect` with a fake HTTP client, prompter and reconcile: three repos give
  three seats, each bound to its own folder with the same desired set; a name clash gives `web-2`; one
  failing repo leaves the others connected with a `✗` line and exit 1; an existing `AGENTS.md` is
  appended to.
- `init.test.ts` — choosing "Connect…" hands off to `runConnect`. This is the first init test with two
  or more harnesses.
- The new screens (menu, repo picker, summary) are added to `docs/design/figma-brief-terminal.md` in
  the same PR (AGENTS.md hard rule 2).
- CI runs the suite; locally only the new test files and the fast gates.
- Live: nick runs `musterd init` on a machine with two or more harnesses and two repos, and both seats
  appear on `/live`.

## Docs

- A short ADR recording that init's default is connect-what-you-have, one seat per repo.
- `docs/architecture/04-cli.md`: the init flow, and file-tree lines for `recents.ts` and `connect.ts`.

## Coordination

The tour spec (lane `01M4FDBXPX`, alfie) adds a "Take the 5-minute tour?" offer at the end of
`musterd init`. The connect path ends at the same point, so the offer goes after the connect summary
too. stanley tells alfie when `runConnect` lands so the offer covers both endings.
