# 486 — `pg` (node-postgres) is the Cloud Postgres driver

- Status: accepted — 2026-09-30 (nick approved the 1B plan, which names this dependency, in session)
- Date: 2026-09-30
- Lane: `01M3SQHCJNSWM340JFV5FW89YM` (goal `cloud`) — Cloud increment 1B
- Deciders: nick; fifty
- Relates to: [ADR 479](479-two-store-backends.md) (two backends, one async driver), cloud design
  §12.4 (`docs/superpowers/specs/2026-09-29-musterd-cloud-design.md`), hard rule 6 (no new
  runtime dependency without an ADR)

## Context

ADR 479 decided that Cloud runs on Postgres behind the async `Driver` and named `pg` as the client
in passing. It did not weigh alternatives, and hard rule 6 wants the reason for a new runtime
dependency on record. Increment 1B is the change that actually adds it.

## Problem

Three Node Postgres clients fit the async `Driver`. Which one does `@musterd/server` depend on, and
what does it cost to change that later?

## Decision

`pg` (node-postgres) with its `Pool`, one pool per database role (app, operator). Weighed:

- **`postgres` (porsager).** A `tagged-template` API we would not use — the `Driver` takes SQL text and
  positional parameters — its own wire implementation with known quirks behind PgBouncer-style
  poolers, and prepared-statement caching we would have to disable per statement.
- **`@neondatabase/serverless`.** An HTTP/WebSocket transport with a `pg`-compatible API, but it ties
  the server to one vendor's edge; Neon's pooled endpoint already speaks plain Postgres.

`pg` is the reference client. It works against Neon, Fly Postgres, RDS and a laptop Postgres alike,
and the `Driver` hides its API behind one file (`packages/server/src/db/pgDriver.ts`), so replacing
it later touches that file only. `@types/pg` is a devDependency. PGlite stays dev-only (ADR 479 §1).

## Consequences

- `pg` in `@musterd/server` `dependencies`; `@types/pg` in `devDependencies`. It is pure JavaScript
  (no native build), so the self-hosted install gains no compile step.
- Each role's pool is sized in `pgDriver.ts`; a connection failure or a bounded checkout wait maps to
  `DriverError('unavailable')` with the stable sentence "database unreachable".

## Observability & Evaluation

n/a — a dependency choice, not agent-facing behaviour.

- **Traces:** the OTel spans the server already emits wrap each request; the driver adds none in 1B.
- **Eval:** n/a — nothing an agent does changes.
- **Experiment:** the dated Neon pass (`docs/perf/neon-pass.md`) runs the store suite and the tenancy
  test through `pg` against a real Neon project.
- **Falsifier:** a `pg` release note or a Neon incident showing the reference client misbehaving
  behind Neon's pooler in a way `postgres` or `@neondatabase/serverless` would not — then reopen.
