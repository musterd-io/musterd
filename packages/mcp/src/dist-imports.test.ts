import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { isBuiltin } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published runtime graph may only touch declared `dependencies`.
 *
 * This exists because 0.4.0 shipped unloadable. `index.ts` re-exported `measureToolSurface`, whose
 * module imports `@modelcontextprotocol/client` — a devDependency — so every consumer hit
 * `ERR_MODULE_NOT_FOUND` on import, while the workspace stayed green because a pnpm install has the
 * dev deps present. Nothing in the unit suite, the typecheck or `npm pack` can see that: the defect
 * is only visible from *outside* the workspace, which is exactly where we never looked.
 *
 * So this walks the real graph from the bin entry and asserts every bare specifier it can reach is
 * something a consumer will actually be given. It is a cheap standing check for a class of bug whose
 * only other detector is a user reporting that the package does not import.
 */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module specifier a file imports, bare and relative alike.
 *
 * Anchored at statement start and forbidden from crossing a quote (`[^'"]*?`) on purpose: a loose
 * `/from ['"]/` also matches prose inside a runtime string — `'…status is derived from ' + x` in
 * `tools/goals.js` was the first thing this caught, and a guard that cries wolf gets muted.
 */
function importsOf(js: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm, // import/export … from '…'
    /^\s*import\s*['"]([^'"]+)['"]/gm, // side-effect import '…'
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('…')
  ];
  for (const re of patterns) for (const m of js.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Static `import`/`export … from` specifiers only — what loads before the module body runs. */
function staticImportsOf(js: string): string[] {
  return [
    ...js.matchAll(/^\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...js.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]!);
}

/** Bare specifiers only — relative paths resolve inside the tarball, builtins always exist. */
function bareImportsOf(js: string): string[] {
  return importsOf(js).filter((s) => !s.startsWith('.') && !s.startsWith('/'));
}

/** The package a bare specifier belongs to: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Every `.js` under a dist dir, recursively. */
function distFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...distFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('the published runtime graph', () => {
  const dist = join(PKG_DIR, 'dist');
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files?: string[];
  };
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}).filter((d) => !declared.has(d)));

  it('imports nothing undeclared anywhere in the tarball', () => {
    // Needs a build. Skipping silently would make this guard a no-op exactly when it matters, so it
    // fails loudly instead — `pnpm gates` builds before it tests.
    expect(existsSync(dist), 'dist/ missing — build before running this guard').toBe(true);

    // Undeclared is always wrong: nothing declares it, so no install of any shape resolves it.
    // dev-only is judged separately, by reachability — see the next test for why that split is real.
    const offenders: string[] = [];
    for (const file of distFiles(dist)) {
      for (const spec of bareImportsOf(readFileSync(file, 'utf8'))) {
        const owner = packageOf(spec);
        if (isBuiltin(spec) || isBuiltin(owner)) continue;
        if (!declared.has(owner) && !devOnly.has(owner)) {
          offenders.push(`${file.slice(PKG_DIR.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, `declared in no dependency list:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  // Two entries since ADR 574: the bin (`dist/index.js`, the bundle every harness launches) and the
  // library (`main`, `dist/lib/index.js`, which the CLI imports). Each is a published runtime graph.
  it.each([
    ['bin', 'index.js'],
    ['library', 'lib/index.js'],
  ])('loads the %s entry without reaching a devDependency', (_name, entryPath) => {
    // THE guard — the exact thing 0.4.0 got wrong. Reachability from the entry is the property that
    // matters, not mere presence in the tarball: `surfaceMeasure.js` legitimately ships (the
    // standing-context budget gate imports it straight out of `dist/lib`) and legitimately pulls a
    // dev dep, and that is harmless precisely as long as nothing the entry loads touches it.
    const entry = join(dist, entryPath);
    expect(existsSync(entry)).toBe(true);

    const seen = new Set<string>();
    const queue = [entry];
    const reachedDev: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const spec of importsOf(src)) {
        if (!spec.startsWith('.')) continue;
        const rel = resolve(dirname(file), spec);
        if (existsSync(rel)) queue.push(rel);
      }
      for (const spec of bareImportsOf(src)) {
        if (devOnly.has(packageOf(spec)))
          reachedDev.push(`${file.slice(PKG_DIR.length + 1)} → ${spec}`);
      }
    }
    expect(
      reachedDev,
      `dist/${entryPath} reaches dev-only packages:\n  ${reachedDev.join('\n  ')}`,
    ).toEqual([]);
  });

  it('starts the launched adapter without resolving a package', () => {
    // ADR 574's point: what a harness launches never walks node_modules on the connect path. The
    // static closure of dist/index.js may hold only Node builtins and the bundle's own chunks beside
    // it (code it shares with the lazily loaded OTel SDK); a bare package specifier anywhere in it
    // puts the module graph back on every connect.
    const seen = new Set<string>();
    const queue = [join(dist, 'index.js')];
    const packages: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of staticImportsOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('./')) queue.push(resolve(dirname(file), spec));
        else if (!isBuiltin(spec)) packages.push(`${file.slice(PKG_DIR.length + 1)} → ${spec}`);
      }
    }
    expect(packages, `the launched adapter resolves:\n  ${packages.join('\n  ')}`).toEqual([]);
    for (const file of seen) expect(dirname(file)).toBe(dist);
  });

  it('boots the OTel SDK from the bundle when an OTLP endpoint is set', () => {
    // The static checks above read import lines; they cannot see what a chunk *exports*. esbuild
    // splits each lazily imported CommonJS OTel package into a chunk that exports only `default`,
    // and on 2026-10-13 a named destructure of one closed every adapter on a machine with an
    // endpoint configured. So run the real bundle with one set. Nothing listens on the daemon URL:
    // startup gets past telemetry, then stops at the reachability probe — `fetch failed` is the
    // proof it got that far, and the telemetry warning must not appear (a degraded boot is a
    // silent loss of every adapter span).
    const home = mkdtempSync(join(tmpdir(), 'musterd-mcp-bundle-'));
    try {
      const run = spawnSync(process.execPath, [join(dist, 'index.js')], {
        cwd: home,
        input: '',
        timeout: 20_000,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          MUSTERD_CONFIG: join(home, 'config.json'),
          MUSTERD_TEAM: 't',
          MUSTERD_SERVER: 'http://127.0.0.1:9',
          MUSTERD_LAUNCH_SURFACE: 'claude-code',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
        },
      });
      expect(run.stderr).not.toMatch(/musterd telemetry:|is not a function/);
      expect(run.stderr).toMatch(/failed to start: fetch failed/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('answers initialize while the daemon reachability check is still in flight (lane 01M4S9SFDR)', async () => {
    // main() used to await bind() — one GET /health — before the transport started, so every
    // harness's `initialize` waited 70–190 ms on the network. A daemon that never answers /health
    // makes the old order hang outright; the new one must answer anyway.
    const held: import('node:http').ServerResponse[] = [];
    const daemon = createServer((_req, res) => void held.push(res));
    await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
    const port = (daemon.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'musterd-mcp-bind-'));
    const child = spawn(process.execPath, [join(dist, 'index.js')], {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        MUSTERD_CONFIG: join(home, 'config.json'),
        MUSTERD_TEAM: 't',
        MUSTERD_SERVER: `http://127.0.0.1:${port}`,
        MUSTERD_LAUNCH_SURFACE: 'claude-code',
      },
    });
    try {
      const reply = new Promise<string>((resolveReply, reject) => {
        let out = '';
        child.stdout.on('data', (b: Buffer) => {
          out += b.toString();
          if (out.includes('\n')) resolveReply(out);
        });
        child.on('exit', (code) => reject(new Error(`adapter exited ${code} before replying`)));
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'bind-test', version: '0' },
          },
        }) + '\n',
      );
      const line = JSON.parse((await reply).split('\n')[0]!) as { id: number; result?: unknown };
      expect(line.id).toBe(1);
      // The daemon never answered /health (the client sets no timeout on it), so bind was pending.
      expect(line.result).toBeDefined();
    } finally {
      child.kill();
      for (const res of held) res.destroy();
      await new Promise<void>((r) => daemon.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
