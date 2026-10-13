// Bundle the stdio adapter every external harness launches (ADR 574).
//
// Runs after `tsc` has written the library to dist/lib/. The launched path stays dist/index.js, so
// every harness config already written keeps working; it becomes one file instead of a module graph
// Node resolves file by file through node_modules on every connect. Modules reached only through a
// dynamic import() (the OTel SDK, which is off by default) split into chunks beside it and load only
// when used.
import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Optional native addons `ws` loads inside a try/catch; absent is the normal case.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies bundled into ESM still call require() for Node builtins.
  banner: { js: "import { createRequire as __musterdRequire } from 'node:module';\nconst require = __musterdRequire(import.meta.url);" },
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
});
