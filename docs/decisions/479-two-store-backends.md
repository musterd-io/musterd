# 479 — Two store backends: better-sqlite3 stays local, `pg` serves Cloud, one async driver, the store suite on both

- Status: accepted — 2026-09-29 (nick, in session, after the spike's numbers and trade-offs were put to him)
- Date: 2026-09-29
- Lane: `01M3QDPWJV85DFYS6M1DJPNBPP` (goal `cloud`) — the PGlite spike, whose acceptance was declined
  until this reversal had its own ADR
- Deciders: nick; fifty (ran the spike and put the choice)
- Supersedes: the spike clause of [ADR 475](475-cloud-hosted-teams-postgres.md) Decision 3 ("pass →
  one SQL dialect and one store layer") and the matching sentence of its Experiment bar. Everything
  else in ADR 475 — the self-hosted daemon in-process and never phoning home, the spike running
  first, the two-backend interface as the fail branch — stands.
- Relates to: [`docs/perf/pglite-spike.md`](../perf/pglite-spike.md) (the measurements and the
  trade-off table this was decided from), [ADR 478](478-local-store-retention.md) (the footprint
  work that followed the same concern), [ADR 002](002-better-sqlite3.md) (why the local engine is
  better-sqlite3)

## Context

ADR 475 Decision 3 made the store shape conditional on a spike: if the current schema loads on
PGlite, one SQL text serves both engines, and hook-path latency stays inside the bar, then musterd
runs one dialect — PGlite on the laptop, Postgres in Cloud — and one store layer. The spike ran on
2026-09-29 and **passed every question** it was given: 106/106 schema statements, every gate-path
query ≤ 1.2 ms p95 on file-backed PGlite, reopen 93 ms. By the rule, the answer was one dialect.

The rule was written before the numbers existed, and the numbers came with costs the rule had not
weighed (recorded on the result page): 310 MB resident against 109 MB with the `revive` database
open, 4× the disk, ~17× slower row-at-a-time bulk writes, ~14 out-of-process readers of
`musterd.db` that would each need a dump path, PGlite at 0.5.x, and FTS5 → `tsvector` as the only
search. The spike put both sides to nick with the numbers, as its Decision section said it would.

## Problem

nick's development laptop is memory- and disk-constrained, and every self-hosted user's machine
would carry the same overhead. He also wants the laptop to run exactly what self-hosted users run,
so dogfooding keeps testing the real thing. One dialect optimises the codebase (one store layer,
no native module); two backends optimise the machine the daemon actually runs on. ADR 475's rule
chose the former by construction. A rule's Decision text is frozen; overruling it in a
Consequences note left ADR 475 saying one thing in Decision 3 and another below it — the reading
that declined the spike lane.

## Decision

1. **Two backends.** `better-sqlite3` remains the self-hosted daemon's engine; `pg` serves Cloud.
   PGlite is not a runtime dependency; it stays a root devDependency as the Cloud driver's test
   double.
2. **One async driver interface**, the spike's Q3 shape (`get / all / run / exec / tx / close`,
   `?` placeholders, the driver owns the dialect). The store conversion is one pass, ~730 call
   sites in ~70 files, the same work either choice would have cost. The SQLite driver needs a
   transaction queue or synchronous transaction bodies (Q3's finding); the spike's
   BEGIN/COMMIT-around-`await` is not safe.
3. **The store suite runs on both drivers** — better-sqlite3 and PGlite in-memory, cloned from a
   template instance (~0.5 s per file) — in CI with no Postgres service, so the two dialects cannot
   drift silently. Before a Cloud release, one pass runs against a real Neon branch for what PGlite
   does not model.
4. **The falsifier that now applies** is the spike's two-backend one: a dialect-translation layer
   that stays under ~300 lines with the nested-`json_extract`-path and typed-comparison sites
   covered by tests. If it grows past that, this decision is revisited — with the measurements,
   not the rule, as the reason.

## Consequences

- ADR 475 Decision 3 carries a dated amendment marker pointing here; its text is otherwise
  unchanged. The Experiment bar's "then decision 3 is one dialect" sentence is likewise marked.
- The cloud design spec (`docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §3.3) and the
  spike result page already record the choice; they now cite this ADR rather than a note.
- Costs accepted: two dialects to keep portable, FTS5 locally and `tsvector` in Cloud
  (`store/insights.ts` has two search implementations), and a Cloud-only bug that a single-driver
  test would hide — which is why decision 3 makes both-driver runs the rule, not the option.
- Gained: no change to any self-hosted install's footprint, the ~14 out-of-process `musterd.db`
  readers keep working, no PGlite maturity bet carried by every user, and the ADR 002 engine
  choice stands.
- Increment 1 of the Cloud goal is planned against this shape.

## Observability & Evaluation

- **Traces:** n/a — a store-shape decision; the driver interface emits nothing new. The existing
  `traceparent` on every request continues to cover Cloud requests.
- **Eval:** dataset = the store test suite run on both drivers in CI, plus the spike's bench
  (`scripts/perf/pglite-hookpath.mjs`) on the Cloud driver against a Neon branch; baseline = the
  spike's 2026-09-29 numbers on the result page. Pass = the suite green on both drivers on every
  `main` commit, and the translation layer under ~300 lines (decision 4) at increment 1's end.
- **Experiment:** none planned — the spike was the experiment, and it ran. Revisit if PGlite's
  resident footprint with a `revive`-scale database drops under ~150 MB in a later release, or if
  the two-dialect layer breaches decision 4's line.
