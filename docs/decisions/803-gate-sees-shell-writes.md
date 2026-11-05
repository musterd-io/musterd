# 803 — The path gate sees files a shell command writes

- Status: accepted (nick, 2026-11-04, opaque writes caught after the call as proposed)
- Date: 2026-11-04

## Context

ADR 150's Gate A checks an edit to a declared contended surface against the editing seat's lanes.
It matches the path a file tool names (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`). A `Bash` call
is matched only as a command, against command classes (`matchEnforcement` in
`packages/protocol/src/enforcement.ts`). So a shell command that writes a file is never checked
against a path class.

That gap is no longer theoretical. Since 2026-11-04, revive declares Gate A `block` on
`packages/protocol/src/**` and `packages/server/src/transport/http.ts`. The same day, a seat edited
`http.ts` through a Python script run with Bash, and the gate printed nothing
([prompted vs structural approval](../wiki/prompted-vs-structural-approval.md), "Files written by a
shell command"). The edit had the holders' OK, so nothing went wrong, but the gate would have been
silent either way.

The gate already reads a lot about shell commands. `isWriteShaped` tells a write from a read
(`BASH_WRITE_PATTERNS`: redirects, `tee`, `sed -i`, `rm`/`mv`/`cp`/`touch`/…, writing `git`
subcommands), and ADR 801's withholds use it. A PostToolUse `Bash` hook already runs after every
shell call (ADR 730's push report).

## Problem

A seat can change a `block`-class file without the gate ever weighing the change, just by writing
it through the shell, and seats write through the shell routinely: formatters, codemods, `sed -i`,
scripts. The gate's strongest class is the one most easily bypassed by accident.

## Decision

1. **The gate reads the write targets out of a shell command.** A new protocol function,
   `bashWriteTargets(command)`, returns the paths a command writes when the command says them
   plainly:
   - the file of a redirect (`> f`, `>> f`, `&> f`);
   - the file operands of `tee`, `sed -i`, `perl -i`, `truncate`, `touch`, `rm`;
   - the last operand of `cp`, `mv`, `install` and `ln`;
   - the path operands of `git checkout -- …`, `git restore …` and `git rm …`.

   It uses the same command-word anchoring and quote handling as `isWriteShaped`. Paths are made
   repo-relative the way file-tool paths already are.
2. **Each target goes through Gate A as if a file tool wrote it.** The hook matches every target
   against the path classes. Each match is adjudicated as today (owned → allow; `warn` → advisory;
   `block` → deny with the repair string). The strictest result decides the call. One audit row is
   written per call, for the strictest target.
3. **A write the gate cannot read gets an advisory before it and a check after it.** An inline
   interpreter (`python -c`, `node -e`, `ruby -e`), a heredoc fed to an interpreter, running a script
   file, `eval`, and a command `bashWriteTargets` cannot parse are opaque: write-shaped, but with
   unknown targets.
   - Before the call, when any `block` path class is declared, the gate allows it with an advisory
     naming those classes. It never denies on a guess.
   - After the call, the PostToolUse `Bash` hook compares the work tree's changed paths with a
     snapshot the PreToolUse hook took (`git status --porcelain`, kept per tool call in `.musterd/`).
     A newly changed path in a `block` class the seat's lanes do not cover is reported to the seat
     at once, saying to revert it or claim a lane. It is audited as `lane.gate` with outcome
     `written_unowned`. The snapshot is taken only for opaque calls, so ordinary commands pay
     nothing.
4. **Scope.** This is Gate A only; Gate B already matches commands. ADR 801's path withholds use the
   same targets, so a seat's own blocking ask holds a `sed -i` on a withheld path too. Command
   classes are unchanged.
5. **Strength.** As with the rest of ADR 150, this induces a cooperating seat and is not a boundary
   against a seat that sets out to evade it (ADR 658). The after-call check detects; it cannot undo.

## Consequences

- A shell write to a plainly named `block` path is refused before it runs, the same as a file-tool
  write. Formatters and codemods (`prettier --write f`, `eslint --fix`) are not in decision 1's
  list, so they are opaque and fall under decision 3: an advisory before, a check after.
- An opaque write is caught after the fact rather than prevented. That is weaker than a deny, but a
  guessed deny on every `python -c` would make the gate a tax on ordinary work.
- `written_unowned` is a new audit outcome. It is additive: readers that classify by `result` and
  `hold` are unchanged (lazara's CooperBench readers, 2026-11-04).
- One `git status` per opaque write-shaped call, in the seat's own workspace.
- Built 2026-11-04 (lane 01M6M9K8B6). How the build reads the Decision:
  - `bashWriteTargets` lives in `packages/protocol/src/bashWrites.ts` and returns `{paths, opaque}`.
    It also names the sources of `mv` and the operands of `git mv`: moving a file away writes it as
    surely as `rm` does.
  - Decision 2's "one audit row per call" is the `also` field on `POST /gate`: the hook sends the
    call's matched paths in one request, `block` first, and the daemon stops at the first deny. A
    `Bash` call that also matches a command class still has that class's own row, as before.
  - The after-call check counts a path as written when `git status` shows it newly changed, or showed
    it before and its mtime moved. It is the `after: true` request, which reads ownership only, never
    a hold or a hand-over. When the daemon is unreachable after the call, it says nothing: it cannot
    tell whose lane covers the path.
  - Any command with a heredoc is opaque, not only one fed to an interpreter. Four automated security
    reviews on 2026-11-04 each found another way a heredoc's body could be misplaced: quotes across
    lines, arithmetic, substitutions, continuations. So the gate stops guessing where a body ends.
    The named targets on its command lines are still weighed before the call.

## Observability & Evaluation

- **Traces:** Gate A's existing `lane.gate` rows, now also for `Bash` calls, plus the new
  `written_unowned` outcome. Rows stay shapes-only: the class name and fingerprint, never the
  command (ADR 051).
- **Eval:** before the build, measure from the transcript tap (ADR 445) how many `Bash` calls in a
  week wrote a path under a declared path class. Two weeks after it ships, count the same calls'
  `lane.gate` rows by outcome. The expected result is that every plainly named write has a row, and
  opaque writes into `block` paths show up as `written_unowned` rather than as nothing.
- **Experiment:** none; the change is uniform. Falsifier: in the after read, a `Bash` call that wrote
  a `block`-class path the seat did not own and left no `lane.gate` row.
