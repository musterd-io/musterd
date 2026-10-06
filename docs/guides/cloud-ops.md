# Operating musterd Cloud

> **Audience:** the infra seat and the human who holds the accounts. **What it covers:** what
> exists for musterd Cloud, where every credential lives, and the commands that create, deploy and
> check it. Design: [`musterd-cloud-design.md`](../superpowers/specs/2026-09-29-musterd-cloud-design.md)
> (the spec). This page tracks what is **running**. Lanes under goal `cloud`; this page starts with
> increment 1D's provisioning lane `01M3Z42764`.

## What exists (2026-10-02)

| Piece | Where | Notes |
| --- | --- | --- |
| Team endpoints | `*.musterd.dev` → Cloudflare (proxied) → Fly app `musterd-cloud` | Wildcard CNAME to `musterd-cloud.fly.dev`; Fly holds a Let's Encrypt `*.musterd.dev` certificate issued by DNS-01 (`_acme-challenge` CNAME, DNS only). IPs: shared v4, dedicated v6. |
| Serving app | Fly `musterd-cloud`, org `personal` | **One machine** (nick, 2026-10-02) in iad, blue-green deploys, `performance-1x` with 2 GB: a dedicated core for the load-test week (nick, 2026-10-02; revisit by 2026-10-09). Before that it was `shared-cpu-1x` with 512 MB. Holds the **app** and **operator** database URLs only. It can never change the schema. A second machine waits on cross-server fan-out (lane `01M3Z4EMH3`). Under sustained load a shared CPU is throttled to its baseline share once its burst balance runs out: the 2026-10-02 load test hit that after seven minutes (`docs/perf/daemon-load-baseline.md`). |
| Migrate app | Fly `musterd-cloud-migrate` | No machines between deploys. Holds the **owner** URLs; the deploy runs the migrate step there before the rollout (spec §6). |
| Database | Neon project `musterd-cloud` (`long-thunder-03987236`), aws-us-east-1, Postgres 17, **Launch plan** (nick, 2026-10-02), 7 days of point-in-time restore | Databases `musterd` and `musterd_trace`. Login users `musterd_app_login` / `musterd_operator_login`, made in SQL so they are not in `neon_superuser`. URLs use `sslmode=verify-full`. Fly's 15-second `/health` check keeps the compute awake. |
| Staging console issuer | Key: `~/.musterd/cloud/staging-issuer.jwk` (mode 600, nick's laptop). JWKS: `https://musterd-staging-jwks.nick-sanders-a.workers.dev/jwks` (worker `workers/staging-jwks`) | Stands in for increment 2's console. It signs the tokens that create teams on staging. Retired by lane `01M3Z43V58`. |

`musterd.io`, `musterd.ai` and `musterd.build` are on the same Cloudflare account and are not used
by Cloud yet.

## Where credentials live, and the rule

No database URL, password, console token or team credential is ever printed, pasted into a chat,
or committed (hard rule 5). Each one has exactly one home:

- **Database URLs:** Fly secrets on `musterd-cloud` (app, operator) and `musterd-cloud-migrate`
  (owner), written by `scripts/cloud/provision-neon.mjs` straight from Neon, through stdin.
- **Neon API key:** `NEON_API_KEY` in the shell of the human who runs provisioning, or
  `~/.musterd/cloud/neon-api.key` (mode 600).
- **The staging issuer key:** `~/.musterd/cloud/staging-issuer.jwk` (mode 600). Only its public half is
  in the repo, in `workers/staging-jwks/wrangler.toml`.
- **A staging team's credentials** (shown once at creation): `~/.musterd/cloud/teams/<slug>.json`
  (mode 600).

## Provision the database (a human runs this)

Copy a Neon API key (Neon console → Account settings → API keys) and save it without it ever
appearing on a command line:

```sh
(umask 077; mkdir -p ~/.musterd/cloud && pbpaste > ~/.musterd/cloud/neon-api.key)
chmod 600 ~/.musterd/cloud/neon-api.key   # the script refuses a key file others can read
cd <a musterd checkout with `pnpm install` done>
node scripts/cloud/provision-neon.mjs
```

It finds or creates the Neon project, the two databases and the two login users, then stages the
URLs as Fly secrets on both apps. It prints names, never values. **Rerunning it rotates both login
passwords** and stages the new URLs. The next deploy picks them up. Deploy straight after a rerun:
the running app still holds the old passwords and cannot open new connections until it rolls.

The migrate app's owner URLs log in as the Neon project's database owner, `neondb_owner`. The
script reads that name and its password back from Neon at run time, so the name appears nowhere in
this repo. **If you reset `neondb_owner`'s password, rerun this script and then deploy.** Until you
do, every deploy stops at the migrate step with `password authentication failed for user
'neondb_owner'`, and nothing is rolled (staging, 2026-10-06).

## Create a team on staging

```sh
node scripts/cloud/staging-issuer.mjs create-team <slug> --creator <name>
```

This mints one 60-second console token, posts it to `https://<slug>.musterd.dev/teams`, and saves what
comes back to `~/.musterd/cloud/teams/<slug>.json`.

## Deploy

```sh
node scripts/cloud/deploy.mjs      # from a clean checkout of the commit to ship
```

One image per commit (`registry.fly.io/musterd-cloud:git-<sha>`):

1. It is built on Fly's remote builder. The script then waits for the tag to appear in the registry: the push lands after `fly deploy --build-only --push` returns.
2. The migrate app runs `scripts/cloud/migrate.mjs` on that image as a one-shot machine, created through the Machines API because `fly machine run` looks images up inside its own app. The script reads the machine's exit event. Fly leaves out a zero `exit_code`, so a missing code means 0.
3. Only on exit 0 is the serving app moved, blue-green, onto the same image. The new machine must pass `/health` before the old one is destroyed.
4. It checks `https://health.musterd.dev/health` through Cloudflare.

Fly's health checker calls the machine by its internal IP. Cloud mode's Host allow-list (ADR 040) refuses that, so the check sends `Host: health.musterd.dev` (`deploy/cloud/fly.toml`). The web UI is served from the web build's `dist/client`.

**Teams on staging (2026-10-02):** `revive-staging` (nick is admin). It was created through the staging issuer, which exercised the console token, the JWKS, the single-use `jti` and the Neon writes end to end.

The §8.1 load test (lane `01M3Z44C56`) makes a fresh team per run, so every run starts from the same board: `lb-smoke1` and `lb-run1` (2026-10-02) are throwaway bench teams, admin `owner`, credentials in `~/.musterd/cloud/teams/`. The harness takes the admin credential from the environment of the bench machine, and nothing it seeds is printed.

## Check it

- Certificate: `fly certs check '*.musterd.dev' --app musterd-cloud`. It should say `Issued`.
- JWKS: `curl -s https://musterd-staging-jwks.nick-sanders-a.workers.dev/jwks`. It should return
  one ES256 key with no `d` field.
- Health (once deployed): `curl -s https://<any-slug>.musterd.dev/health` → `{"ok":true}`, or
  `503` with one of the stable sentences (`docs/architecture/03-server.md` §Cloud mode).
