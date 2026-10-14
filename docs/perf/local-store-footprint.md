# Local store footprint — where the laptop's memory and disk go

- Date: 2026-09-29 · machine: nick's dev laptop · lane 01M3QQ5BHY (goal `cloud`)
- Asked by nick after the PGlite spike ([`pglite-spike.md`](pglite-spike.md)) chose two backends
  on footprint: is there a lighter local engine?
- Method: the live daemon (pid read-only via `vmmap --summary`, build `02a0e0a0`, 9 connections,
  12 min up), and a `.backup` copy of `~/.musterd/musterd.db` + `trace.db` (sizes, `dbstat`, row
  ages). Nothing was written to the live database. One machine, one reading each.

## Answer

**The engine is not where the footprint is.** Memory is mostly the daemon's JavaScript heap;
disk is mostly two append-only tables that are never pruned. A lighter SQLite driver would move
neither much.

## Memory

| region (live daemon) | dirty size | what it is |
| --- | --- | --- |
| physical footprint | 225 MB (peak 335 MB; 89 MB resident at read time) | whole process |
| V8 heap (`Memory Tag 255`) | ~155 MB | the daemon's JS objects |
| malloc zone | ~85 MB | SQLite + Node native buffers |
| SQLite page cache | ~~`cache_size = -2000` → ~2 MB per connection~~ `cache_size = -16000` → up to ~16 MB per connection (corrected 2026-10-13, lane 01M3ZGSXFS: `better-sqlite3` is compiled with that default, not SQLite's -2000; falsify: `pragma cache_size` on a fresh `new Database(':memory:')`) | already the default |

A copy of the daemon on the same database, **idle with no connections**, has a 118 MB footprint
(81 MB V8, 23 MB malloc). So roughly 100 MB of the live footprint is load- and uptime-driven
heap, not the store. Not yet attributed: `--heapsnapshot-signal` produced no snapshot on the copy
(the daemon appears to take the signal itself), so which objects fill the heap is open.

## Disk

`musterd.db` is **300 MB** (0 free pages — `VACUUM` reclaims nothing), plus `trace.db` at
**122 MB**.

| object | MB | rows | oldest | notes |
| --- | --- | --- | --- | --- |
| `audit` + 3 indexes + pk | ~137 | 333,596 | 2026-07-02 | 64% older than 7 days |
| `sync_log` + 3 indexes | ~108 | 138,866 | 2026-09-04 | 78% older than 7 days; avg payload 502 B |
| `messages` | 16 | | | |
| `trace_events` (trace.db) | ~110 | | | |

`audit` is dominated by lifecycle churn: `bootstrap_credential.used` 77,665 ·
`presence.attached`/`detached` 97,452 · `agent_session_lease.renewed`/`minted` 50,306 ·
`claim.occupied`/`superseded` 42,656. No code in `packages/server/src` deletes from `audit` or
`sync_log`.

Compressed, the same rows are small: `audit` gzips to **14 MB**, `sync_log` to **13 MB** — an
archive-then-prune policy would cut ~245 MB to ~27 MB without losing the data the research corpus
(goal `research-corpus`, ADR 056) depends on.

## What this changes

1. **Disk: retention, not engine.** A retention policy for `audit` (archive lifecycle churn past
   N days), `sync_log` (prune below every peer's acknowledged cursor — ADR 325/331 semantics decide
   what is safe), and `trace.db` is where the disk goes. It deletes data, touches federation
   correctness and the research corpus, so it needs its own ADR and lane.
2. **Memory: the heap, not the engine.** Attribute the ~100 MB load-driven heap (inspector heap
   snapshot on a copy under replayed load) before changing drivers.
3. **`node:sqlite`** stays worth a trial only for removing the native-module / Node-ABI trap: FTS5
   is present on Node 22.23 (SQLite 3.53.3); published benchmarks put it 1.1–1.7× slower than
   better-sqlite3. Not measured here.

Falsifier: if a heap snapshot shows SQLite-owned objects (statements, result rows) above ~50 MB,
point 2 is wrong and the driver matters for memory after all.
