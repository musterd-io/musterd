# ADR 574: Bundle the stdio MCP adapter to one file

- Status: proposed
- Date: 2026-10-12
- Deciders: TJ (lane owner), lazara (goal owner)
- Lane: `01M4S37QV76WG0DS3K92J18E0Y`, goal `mcp-fast-path`
- Builds on: lane `01M4S36E5DFFZW7NYM03XNME5G` (the cold-start bench, `scripts/mcp/bench.mjs`)

## Context

Every external harness (Claude Code, Cursor, Codex, OpenCode, Grok) launches the stdio adapter as
`node …/packages/mcp/dist/index.js`. That file is `tsc` output: 48 adapter files plus the ESM
graph of `@musterd/protocol`, `@modelcontextprotocol/server`, `zod`, `ws` and the rest, which Node
resolves and loads file by file through `node_modules` on every connect.

The bench lane measured the cost on one machine (cursor, 2026-10-12): import 170–328 ms,
spawn → `tools/list` 336–775 ms, with `tools/list` itself about 10 ms once the process is up.

A phase split of `main()` on a second machine (MacBook-Air-2, three runs) put the time here:

| Phase                                     | ms      |
| ----------------------------------------- | ------- |
| process start + module import → `main()`  | 470–610 |
| `loadMcpConfig()`                         | 130–250 |
| `bind()`                                  | 70–190  |
| transport start → `initialize` reply      | 100–200 |

Import is the largest phase. The other three are separate lanes (see Consequences).

Import CPU time, median of 15 interleaved runs, on the same machine. CPU time is reported because
the machine's load average was 65–105 on 8 cores during the runs, which made wall time swing
2–4× between runs:

| Variant                                    | import CPU (ms) |
| ------------------------------------------ | --------------- |
| `tsc` dist (today)                         | 609–665         |
| `tsc` dist + `NODE_COMPILE_CACHE`          | 631             |
| one-file esbuild bundle                    | 343–384         |
| esbuild bundle, OTel split into lazy chunks| 293             |

The compile cache does almost nothing for the `tsc` dist. Most of the cost there is resolving and
reading many files, not compiling them.

`@musterd/telemetry` already loads the OpenTelemetry SDK with dynamic `import()`, and only when an
OTLP endpoint is configured (off by default, ADR 015/089). A bundle without code splitting inlines
those modules (about 2.3 MB of the 4.9 MB bundle) and parses them on every start anyway.

The CLI also imports `@musterd/mcp` as a library: `buildMcpServer`, `MusterdClient`, `autojoin`
(the native bridge) and `withTraceContext`. It must not get a second bundled copy of
`@musterd/protocol` and `zod` in its own process.

## Problem

The adapter pays roughly 300 ms of CPU on every harness connect to load a module graph it could
load as one file. The fix needs a bundler, which is a new dependency (AGENTS.md hard rule 6). It
also needs a `dist` layout that changes neither the path every existing harness config launches
nor what the CLI imports.

## Decision

1. **The launched path stays `packages/mcp/dist/index.js`, and it becomes an esbuild bundle of
   `src/index.ts`** (ESM, `platform=node`, `target=node22`) with code splitting. Modules reached
   only through dynamic `import()` (the OTel SDK, `getMachineId`) are emitted as chunks beside it
   and load only when used. The startup path is `index.js` plus the two small chunks it shares with
   that lazy code (about 58 KB, all in `dist/`), and it resolves no package through `node_modules`.
   That is the property that matters: splitting measured faster than a literal single file
   (293 vs 343 ms import CPU), because the single file parses the 2.3 MB OTel SDK on every start. Because the path does not change, every
   harness config, `entryGuard` check and `doctor` hint already written keeps working with no rewire.
2. **The library stays `tsc` output, moved to `dist/lib/`.** `main` and `types` point at
   `dist/lib/index.js`, and `bin` stays on the bundle. No `exports` map is added. One would close the
   deep paths that `scripts/release/smoke.ts` and outside tooling resolve (`@musterd/mcp/dist/index.js`).
   `resolveMcpLaunch` (CLI) resolves that same deep path instead of the package's main, so it
   computes the same `dist/index.js` it computes today.
3. **esbuild is a devDependency of `@musterd/mcp`, pinned to the version already in the lockfile**
   (0.28.1, present through vite and vitest), so nothing new is downloaded. It runs from
   `packages/mcp/build.mjs` after `tsc`. Packages that stay external: `bufferutil` and
   `utf-8-validate`, which are optional native dependencies `ws` loads inside a try/catch.
   Alternatives considered:
   - `tsup` adds a config layer over the same esbuild.
   - rolldown or vite library mode needs more configuration for a Node bin, and its output is no
     smaller.
   - Node's compile cache alone was measured above and is not enough.
   - A Node single-executable app would replace `node <path>` in every harness config, which this
     decision exists to avoid.
4. **Code that finds a file by a fixed number of `..` from its own module walks up to the package
   root instead.** This covers `version.ts` (`../package.json`) and `tools/format.ts` (the checkout
   path). The same code then reads correctly from `dist/index.js`, `dist/lib/**` and `src/`.
5. **The build empties `dist/` first**, so no stale `tsc` files from an earlier layout sit beside
   the bundle.
6. **`dist-imports.test.ts` walks both graphs.** Neither the bin nor the library may reach a
   devDependency, as today. A new case walks the bin's static imports and fails on any bare package
   specifier or any file outside `dist/`, so a later change cannot put a module graph back on the
   connect path unnoticed.

## Consequences

- The import phase drops by roughly half (CPU 609 → 293 ms median above). The bench in
  `scripts/mcp/bench.mjs` remains the before/after measure, and the PR records it.
- Stack traces from the launched adapter point into the bundle. esbuild keeps names, and the
  bundle ships no source map, the same as the `tsc` dist today.
- `@musterd/mcp`'s published tarball gets a self-contained bin. Its `dependencies` stay, because the
  library entry still needs them.
- Left out, each on `mcp-fast-path`:
  - `loadMcpConfig()` spends 130–250 ms walking process ancestry with one blocking `ps` per
    generation. Follows-up: 01M4S9SCT5AZ1QADVAXB8S425A
  - `bind()` holds the stdio transport until a daemon round trip returns.
    Follows-up: 01M4S9SFDR6E94Y623V3MC3K2A
  - `module.enableCompileCache()` measured a further ~100 ms off the bundle, but it writes a cache
    directory and needs its own decision. Follows-up: 01M4S9SJJPTD1J6SM2RG8R5DH7
  - _(2026-10-12)_ Decided in ADR 577: enabled. Remeasured on a quiet machine the saving is about
    25 ms per launch, not ~100 ms.

## Observability & Evaluation

- **Traces:** none new. The adapter's `musterd.tool.call` spans are unchanged, and the OTel SDK still
  starts only when an OTLP endpoint is configured.
- **Eval:** `node scripts/mcp/bench.mjs --surface <harness>` before and after, on the same machine,
  against the import and spawn → `tools/list` numbers above. Pass: median `import_ms` at least 30%
  lower over 15 interleaved runs, with the same tool count and `tools/list` byte size (31 tools,
  19 664 bytes). `dist-imports.test.ts` holds the structural property in CI.
- **Experiment:** none.
