# This team: musterd's own infrastructure

Read before the first infrastructure action of a session. This file is the team's own layer: a
team that installs the platform role writes its own (`building-a-role-skill` has the method).
Paths below are relative to the musterd repository; ADRs are in `docs/decisions/`.

## What runs, and where its state lives

| Thing | Where | Check it with |
| --- | --- | --- |
| The shared daemon (LaunchAgent `studio.sandrise.musterd`) | `~/.musterd/musterd.db`, `daemon.log`, `daemon.err.log`, `config.json` | `curl -s localhost:4849/health` (fields `build`, `booted_at`, `schema`, `db`); `musterd service status` |
| The daemon's checkout | `~/.musterd/runtime`; each package's `dist/build.json` is its build stamp (ADR 135) | `/health.build` against `git rev-parse origin/main` |
| The auto-refresher (ADR 152, 201) | `~/.musterd/autorefresh/` (`refresh.log`, `.attempted-sha`, `.outage`, `.blocked`, `handover.json`) | `tail ~/.musterd/autorefresh/refresh.log` |
| The guardian (ADR 263, 274) | `~/.musterd/guardian/` (`stamp.json`, `guardian.log`) | `docs/wiki/platform-guardian.md` |
| `/live`'s served bundle | `~/.musterd/live/` (`build.log`, `web/`, `site-gap.json`) | `tail ~/.musterd/live/build.log` |
| The hosted hub (Fly.io app, Neon Postgres) | `deploy/cloud/fly.toml`, `scripts/cloud/` | `docs/guides/cloud-ops.md` |

Logs are size-capped at two 8 MB generations (ADR 224).

## The commands that change it

The service verbs, never raw `launchctl` (ADR 045): `musterd service
install|uninstall|start|stop|restart|refresh|status|logs`, with `--live`, `--auto`, `--guardian`
and `--wake` (`docs/architecture/04-cli.md`). `musterd reset` (ADR 022) wipes; treat it as
irreversible. Migrations run inside the server (`packages/server/src/db/migrations.ts`,
`ladder.ts`, `db/pg/migrate.ts`) and `pnpm migrations:check` holds the ladder (ADR 245). The cloud
deploy is `scripts/cloud/deploy.mjs`: build, then migrate, then roll out.

## The decisions that govern it, newest first where they replace an older one

| ADR | Says |
| --- | --- |
| 513 | Role-gated routes: a seat without the role is warned (infra stays warn-only, §5) and told who holds it |
| 496 (proposed) | Migrate verifies the landed Postgres schema; a version row is a claim |
| 479, 486, 507, 510 | Two store backends (SQLite locally, `pg` in the cloud); PRs run the SQLite leg |
| 472 | A failed refresh build rolls the checkout back |
| 389 (proposed) | A wedged daemon: a stack sample proves it, the restart ships dark |
| 274 (proposed), 263 | The guardian confirms an outage before alerting; it is pure code on call |
| 245 | The migration ladder steps strictly upward |
| 227 | Roles as the aptitude layer; the warn-only infra gate; this role's charter |
| 201, 205, 207, 152 | The auto-refresher owns the bounce; never ask a human to refresh |
| 135, 130 | Every runtime stamps its build; `/health.build` shows skew |
| 118 | `service refresh` syncs main, builds, then bounces, guarded |
| 047 | `stop` and `restart` refuse while sessions are live, unless `--force` |
| 045 | The daemon is a launchd LaunchAgent |

AGENTS.md's "Getting your change onto /live" table says what each kind of change needs, and that a
web change never needs a daemon bounce.

## Local rules, each from an incident

| Date | What happened | The rule |
| --- | --- | --- |
| 2026-06-24 | An agent restarted the shared daemon three times while a teammate held a live session | Roster guard (ADR 047); announce first |
| 2026-07-11 | `git pull` on a detached HEAD did nothing; a refresh ran a stale branch | `service refresh` plus `/health.build` (ADR 118, 130) |
| 2026-07-12 | `service install` from a Node 20 shell crashlooped the daemon | Install from Node 22; `refresh` never rewrites the plist (`docs/wiki/shared-daemon.md`) |
| During the ADR 152 work | A probe read the tail of a 9.5 MB error log and reported a live crashloop; the errors were eight days old | Freshest evidence first (`docs/design/roles-and-stewardship.md`, the guardian seed) |
| 2026-08-06 | Two branches took migration v32 | The ladder gate (ADR 245) |
| 2026-08-12 | `team create` repointed every CLI on the machine | Probe on a temporary daemon, never :4849 (`docs/wiki/temp-daemon-probe.md`) |
| 2026-08-19 | False `daemon_down` alarms; a deliberate bounce read as a crash | Adjudicate before alerting (ADR 274; `docs/wiki/platform-guardian.md`) |
| 2026-09-04 | The daemon wedged alive inside SQLite | ADR 389 |
| 2026-09-14 | A whole-workspace test run starved the daemon | Run package suites only on the shared machine (`docs/wiki/running-the-gates.md`) |
| to 2026-09-17 | A dirty checkout produced 16 alarm notices in 3 hours | Debounce on the cause, then escalate (`docs/wiki/when-the-daemon-stops-refreshing.md`) |
| 2026-09-19 | A site change landed but was not live | Build stamp plus the gap report (`docs/wiki/landed-is-not-live.md`) |
| 2026-09-28 | A failed build left the checkout split across commits | ADR 472 |
| 2026-10-02 | A renumbered branch skipped Neon's v81 | ADR 496 |

Also: an adapter that differs from the daemon is fixed by rebuilding and reloading the adapter,
never by bouncing the daemon (`docs/wiki/mcp-adapter-daemon-skew.md`); the laptop's memory floor
is in `docs/wiki/nicks-laptop.md`; the cloud seat's view is `docs/wiki/cloud-seat-from-inside.md`.

## Practice skills to route to

| When | Skill |
| --- | --- |
| Before trusting a guard as protection | `controls-in-force` |
| Before writing an incident finding, or believing a green check | `dated-and-falsifiable` |
| A multi-day read of a signal | `pre-registered-watch` |
| A fix merged but not yet live | `definition-of-done` |
| Correcting a wrong outage claim | `claims-ledger` |
| Changing `/health` or a stamp other readers use | `two-consumers` |
| An infra decision or its amendment | `decision-records` |
| A wiki or CLI doc that disagrees with the machine | `docs-that-catch-drift` |
| Credentials on cloud work | `security` |
