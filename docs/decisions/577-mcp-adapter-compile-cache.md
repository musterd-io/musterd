# ADR 577: Enable Node's compile cache for the launched MCP adapter

- Status: proposed
- Date: 2026-10-12
- Deciders: TJ (lane owner), lazara (goal owner)
- Lane: `01M4S9SJJPTD1J6SM2RG8R5DH7`, goal `mcp-fast-path`
- Builds on: ADR 574 (the bundled `dist/index.js`)

## Context

ADR 574 bundled the stdio adapter every external harness launches. It found that Node's module
compile cache did nothing for the old `tsc` dist, and measured a further ~100 ms of import CPU off
the bundle with `NODE_COMPILE_CACHE` set. That number was taken at a load average of 65–105 on 8
cores. It left the decision to this ADR because enabling the cache writes a directory.

Node 22.8 added `module.enableCompileCache()`. It stores V8 code cache for each module compiled
after the call and reuses it on the next run. It never throws: Node before 22.8 has no such
function, and `NODE_DISABLE_COMPILE_CACHE=1` or an unwritable directory turns it into a no-op.
`@musterd/mcp` requires Node 22 or later.

Remeasured on 2026-10-12 at a load average of 6–13 on 8 cores, with `NODE_DISABLE_COMPILE_CACHE=1`
as the off switch on the same bundle. Spawn to reply, median of 20–25 interleaved runs, plus the
child's CPU time from `/usr/bin/time`:

| Variant                         | `initialize` (ms) | `tools/list` (ms) | CPU (ms) |
| ------------------------------- | ----------------- | ----------------- | -------- |
| cache off                       | 244–261           | 249–265           | 290–310  |
| cache on, entries present (hit) | 220–235           | 225–240           | 280–290  |
| cache on, empty directory (miss)| 277               | 281               | 320      |

Importing the adapter chunk alone: 163 → 138 ms CPU median over 25 runs. The real saving is about
25 ms, or 10% of a launch, not ~100 ms. A miss costs about 16 ms more than running without the cache,
because the cache is written as well as compiled.

`NODE_DEBUG_NATIVE=COMPILE_CACHE` confirms that all three modules on the startup path (the adapter
chunk and its two shared chunks) are read from the cache on the second launch.

## Problem

Whether 25 ms on every launch pays for a cache directory on disk, and if it does, where the call
goes so that it actually covers the adapter.

## Decision

1. Enable the cache. `dist/index.js` gets a new entry, `src/launch.ts`. Its only static import is
   `node:module`. It calls `module.enableCompileCache()` and then loads the adapter with a dynamic
   `import()`. The call cannot live in `index.ts`: the cache covers only modules compiled after it
   is enabled, and a module's static imports load before its body runs. The bin path stays
   `dist/index.js`, so harness configs are unchanged.
2. Use Node's default directory, `os.tmpdir()/node-compile-cache`, by passing no argument.
   `NODE_COMPILE_CACHE` overrides it and `NODE_DISABLE_COMPILE_CACHE=1` turns it off, with no
   musterd setting. A directory inside the package would fail for a read-only install. The default
   directory is shared with other Node tools that already use it.
3. `index.ts` exports `runAdapter()`. The launcher calls it only when it is the main module, by the
   same test `index.ts` used before. `scripts/mcp/bench.mjs` imports the bin to time module load,
   and that import must not start a server on the importer's stdio.
4. At the end of startup, `main()` calls `module.flushCompileCache()`. Node otherwise writes the cache
   only at exit, so a host that kills the adapter with SIGKILL would leave the next launch to compile
   again. Both calls go through the default import of `node:module` with optional chaining. A named
   import of an export that Node before 22.10 lacks would fail at link time, and the adapter would
   never start.

## Consequences

- Each launch after the first on a given build starts about 25 ms sooner. The first launch after a
  rebuild pays about 16 ms extra. esbuild's chunk names carry content hashes, so every rebuild is a
  new set of cache entries.
- About 850 KB of cache per build is written to the user's temp directory. Old builds' entries are
  never removed by musterd. They are left to the OS's temp cleanup, the same as for the other Node
  tools that use the directory. On this machine that directory already held 275 MB before this
  change.
- Node checks each entry against the source file's checksum and its own version, so a stale entry
  is recompiled rather than used.
- `dist/index.js` is now a 10-line launcher. The adapter is the chunk it imports. `dist-imports.test.ts`
  still holds: the launcher's static closure is one builtin.
- The remaining startup cost is the daemon round trip `bind()` waits for before serving.
  Follows-up: 01M4S9SFDR6E94Y623V3MC3K2A

## Observability & Evaluation

- **Traces:** none new.
- **Eval:** spawn → `tools/list` median over 20 interleaved runs with the cache on (warm) and with
  `NODE_DISABLE_COMPILE_CACHE=1`, on the same bundle and machine. Pass: the warm cache is at least
  15 ms faster at the median, with the same 31 tools. `NODE_DEBUG_NATIVE=COMPILE_CACHE` on a second
  launch shows every startup chunk read from the cache.
- **Experiment:** none.
