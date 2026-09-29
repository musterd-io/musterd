# PGlite spike — increment 0 of ADR 475

- Date started: 2026-09-29 · Lane `01M3QDPWJV85DFYS6M1DJPNBPP` · Plan:
  [`2026-09-29-cloud-increment-0-pglite-spike.md`](../superpowers/plans/2026-09-29-cloud-increment-0-pglite-spike.md)
- PGlite version: 0.5.8 · bundled Postgres: `PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, 32-bit`
  · Node: v22.23.1
- Machine: Apple M3, 8 GB

Why the spike is reshaped from the spec's wording ([spec §3.3](../superpowers/specs/2026-09-29-musterd-cloud-design.md)):
62 synchronous better-sqlite3 store files; PGlite is Promise-only; the spec's "boot the daemon on
PGlite" is the async conversion itself (see the plan). The four questions below are what two days
can answer; the conversion is sized, not done.

| Question | Pass bar | Result |
| --- | --- | --- |
| Q1 schema loads | every table/index; hand-fixes ≤ 10 | _pending_ |
| Q2 hook path | file-backed p95 ≤ 10 ms/query; boot ≤ 2 s | _pending_ |
| Q3 one SQL text, two drivers | cursor tests green on both | _pending_ |
| Q4 conversion size | counted | _pending_ |

## Q4 — dialect and call-site inventory

_pending (Task 2)_

## Q1 — schema on PGlite

_pending (Task 3)_

## Q2 — hook path latency

_pending (Task 4)_

## Q3 — two-driver slice

_pending (Task 5)_

## Decision

_pending (Task 6)_
