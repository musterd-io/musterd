#!/usr/bin/env node
// The launched adapter's entry (ADR 577): dist/index.js, the file every harness config names.
//
// It turns on Node's module compile cache before anything else loads, then loads the adapter. The
// order is the point: the cache covers only modules compiled after it is enabled, and the static
// imports of a module run before its body, so the call cannot live in index.ts itself. Hence this
// file imports nothing at load time but node:module, and reaches the adapter by dynamic import.
//
// enableCompileCache() never throws; a missing API (Node before 22.8), NODE_DISABLE_COMPILE_CACHE,
// or an unwritable cache directory leaves the adapter starting exactly as it did without it.
import nodeModule from 'node:module';

nodeModule.enableCompileCache?.();
const { runAdapter, isMainModule } = await import('./index.js');
// Run only when launched, as index.ts did before this file existed: `scripts/mcp/bench.mjs` imports
// the bin to time module load, and an import must not start a server on the importer's stdio. The
// check resolves symlinks, so a package-manager bin (npm i -g, npx) still counts as launched.
if (isMainModule(import.meta.url)) runAdapter();
