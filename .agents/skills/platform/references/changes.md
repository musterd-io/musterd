# Changes: restarts, refreshes, deploys, migrations

Open before you change anything that is running.

## 1. Before any change

Write the five lines from SKILL.md (target, affects, success, abort, way back). Then:

- **Confirm the target is real and current.** Resolve the path, branch, database or host now, and
  read it back. An empty variable in a delete or a deploy target is the most common way automation
  and agents have destroyed data.
- **Dry-run when the tool has one**, and read what it would do.
- **One change in flight per service.** Two changes at once make the cause of any failure
  impossible to tell apart.
- **Review by a second member only where it pays.** DORA's research found that heavy external
  approval slows delivery without lowering the change failure rate; peer review plus automated
  checks does better ([DORA](https://dora.dev/capabilities/streamlining-change-approval/), CC BY).
  So: irreversible or destructive changes get a second member; announced, checked restarts do not.

## 2. Restarts and refreshes

A service manager (launchd on macOS, systemd on Linux) restarts a process when it exits. Neither
knows whether your application is healthy. So a restart is not done when the command returns:

1. Announce it to the members attached, and check none is mid-operation.
2. Restart with the team's own verb when it has one (see `references/team.md`), never raw
   service-manager commands that skip its guards.
3. Wait for the old process to be fully gone before the new one opens shared files. With SQLite,
   two processes writing one database file through a restart is how it corrupts.
4. Poll the health check until it answers, confirm the process ID changed, and confirm the build
   it reports is the one you meant.
5. If it fails twice, stop and roll back. A loop of restarts hides the error and, on systemd, hits
   the start limit and stops trying until reset.

launchd details worth knowing: it throttles restarts to one per 10 seconds by default, and
`launchctl print` output is documented as not an API, so parse it only for a human's eyes
([launchd.plist](https://keith.github.io/xcode-man-pages/launchd.plist.5.html), cited).

## 3. Deploys

- **Know what is running before and after**: the build or image each instance reports.
- **Roll out in stages** where the platform allows (one instance, check, then the rest), and decide
  the rollback triggers before the deploy starts.
- **A migration step that runs before the new code must work with the old code still serving.**
  On Fly.io, `release_command` runs once in a temporary machine before any machine updates, with no
  volumes and a 5-minute default timeout; a non-zero exit stops the deploy
  ([Fly.io deploy docs](https://fly.io/docs/reference/configuration/#run-one-off-commands-before-releasing-a-deploy), cited).
- **Health checks on Fly.io stop traffic to a machine; they do not restart it.** A wedged single
  machine stays wedged until something restarts it.

## 4. Migrations

**Expand, then contract** ([ParallelChange](https://martinfowler.com/bliki/ParallelChange.html), cited):

1. **Expand**: add the new column, table or index; the old code keeps working.
2. **Migrate**: deploy code that writes both and reads the new; backfill in batches.
3. **Contract**: once nothing reads the old shape, remove it, in a later release.

**Before running one:**

- Back up first. For SQLite use `VACUUM INTO` or the backup API; a file copy taken during a write
  can be corrupt, and the `-wal` and `-journal` files belong with the database
  ([SQLite backup](https://www.sqlite.org/backup.html), cited).
- Rehearse on a copy with real data (a Postgres branch such as Neon's, or a copied SQLite file),
  not on an empty schema.
- Number migrations so they only step upward, and check two branches did not take the same number.
- After it runs, check the schema that landed. A version row says the migration was recorded, not
  that every statement in it took effect.

**SQLite.** `ALTER TABLE` can rename, add a column and drop a column; anything else is the
documented 12-step rebuild, in its exact order. Renaming the old table first can break triggers,
views and foreign keys ([SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html), cited).

**Postgres.** Most `ALTER TABLE` forms take an ACCESS EXCLUSIVE lock, which blocks even reads, and
a waiting lock blocks everything queued behind it. So:

- Set `lock_timeout` for the migration's session so it fails fast instead of stalling the service.
- Add a column with a constant default (no table rewrite since Postgres 11).
- Add constraints as `NOT VALID`, then `VALIDATE CONSTRAINT` separately.
- To make a column `NOT NULL`, add a `CHECK (col IS NOT NULL) NOT VALID`, validate it, then
  `SET NOT NULL`, which then skips the full scan.
- Build indexes `CONCURRENTLY`, outside a transaction; if it fails it leaves an INVALID index to
  drop and retry.
- Changing a column's type usually rewrites the table and can need twice the disk.

Source: [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html), cited.

## 5. After any change

Check the running build, the process and the user-facing path; watch for the stated window; tell
the members it is done; record what was done and what was seen.
