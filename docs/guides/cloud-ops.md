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
| Serving app | Fly `musterd-cloud`, org `personal` | Holds the **app** and **operator** database URLs only. It can never change the schema. |
| Migrate app | Fly `musterd-cloud-migrate` | No machines between deploys. Holds the **owner** URLs; the deploy runs the migrate step there before the rollout (spec §6). |
| Database | Neon project `musterd-staging`, aws-us-east-1, Postgres 17, **free tier** | Databases `musterd` and `musterd_trace`. Login users `musterd_app_login` / `musterd_operator_login`, made in SQL so they are not in `neon_superuser`. Free tier suspends compute after 5 idle minutes, so the first request after a pause is slow. nick's call (2026-10-02): free tier for staging, and ask again before the increment-4 cutover. |
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
node scripts/cloud/provision-neon.mjs      # from a checkout with `pnpm install` done
```

It finds or creates the Neon project, the two databases and the two login users, then stages the
URLs as Fly secrets on both apps. It prints names, never values. **Rerunning it rotates both login
passwords** and stages the new URLs. The next deploy picks them up.

## Create a team on staging

```sh
node scripts/cloud/staging-issuer.mjs create-team <slug> --creator <name>
```

This mints one 60-second console token, posts it to `https://<slug>.musterd.dev/teams`, and saves what
comes back to `~/.musterd/cloud/teams/<slug>.json`.

## Check it

- Certificate: `fly certs check '*.musterd.dev' --app musterd-cloud`. It should say `Issued`.
- JWKS: `curl -s https://musterd-staging-jwks.nick-sanders-a.workers.dev/jwks`. It should return
  one ES256 key with no `d` field.
- Health (once deployed): `curl -s https://<any-slug>.musterd.dev/health` → `{"ok":true}`, or
  `503` with one of the stable sentences (`docs/architecture/03-server.md` §Cloud mode).
