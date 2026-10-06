# Whiteboard, Squig only — implementation plan

> **For agentic workers:** implement in your own seat (AGENTS.md hard rule 8). There are no
> writing subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@musterd/whiteboard` runs Squig from a copy vendored into the package, and it contains no
tldraw, so the package can be published to npm.

**Architecture:** A script in the package builds Squig once at a pinned upstream commit. It bundles
the companion's entry (`scripts/agent/local.ts`) into one ESM file with Vite 8's Rolldown and commits
the output under `packages/whiteboard/vendor/squig/`. The Squig adapter prefers that vendored
companion over a local checkout. After nick's one real tldraw board is converted, the tldraw adapter,
its sync rooms, the web page and the provider choice are deleted.

**Tech Stack:** TypeScript, Node ≥22, Vite 8 (Rolldown) as a build-time bundler only, vitest,
`@resvg/resvg-js` and `sharp` as the only new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-whiteboard-squig-only-design.md`

## Increments

| #   | Lane                         | Tasks | Lands as                                                       |
| --- | ---------------------------- | ----- | -------------------------------------------------------------- |
| 1   | `01M49DRSSQXBH58SEWEMK2QP5M` | 1–6   | One PR: spec, this plan, ADR, vendor script, vendored output, adapter |
| 2   | `01M49DW741NDGNR1NCNYBWZJ5C` | 7     | Local only: board archive and conversion, no PR                |
| 3   | `01M49DWAA4DB6FJBPB1G98V0SP` | 8–11  | One PR: tldraw removed                                         |

## Global Constraints

- The pinned Squig upstream is `https://github.com/pablostanley/squig.git` at
  `85f92ab132f5e621754b19de24ff95e67e474602`. This is the commit that ADR 524 and ADR 527 were
  built against, and it is in `~/.squig/src` today.
- The vendored layout is fixed by Squig's own path lookups (spec §4):
  - `vendor/squig/lib/agent/companion.mjs`
  - `vendor/squig/lib/agent/fonts/`
  - `vendor/squig/out/`
  - `vendor/squig/LICENSE` and `vendor/squig/VENDORED.json`
- No Squig source file is patched.
- The only externals in the bundle are `@resvg/resvg-js` and `sharp`. Their versions in
  `packages/whiteboard/package.json` equal the versions recorded in `VENDORED.json`.
- The package imports nothing from `@musterd/*` (ADR 330).
- The test suite must never depend on what a laptop has installed: no test reads `~/.squig/src`.
- `pnpm typecheck && pnpm lint && pnpm format:check` pass before every push (AGENTS.md git
  workflow §3). Do not run the full suite locally (the memory note: measure in CI).
- Every commit ends with `Co-authored-by: stanley <stanley@revive.musterd>`.

## Deviation from the spec (recorded in the spec in Task 1's commit)

- **The vendor script lives at `packages/whiteboard/scripts/vendor-squig.mjs`, not at the repo
  root.** Vite is a dev dependency of `packages/whiteboard`, and pnpm does not let a root script
  resolve it. The script also leaves the monorepo with the package in lane `01M2PAMFW1`.
- **The bundle entry is `scripts/agent/local.ts`, not `scripts/squig.ts`.** `local.ts` runs itself
  when `argv[1]` equals its own module URL. In a single-file bundle that check is true for every
  module, so bundling `squig.ts` would start `local.ts` a second time. With `local.ts` as the
  entry, its own guard is the real entry point, and `companion.mjs mcp <file>` takes the same
  arguments that `squig.ts mcp <file>` takes.
- **The free `text` item on the converted board becomes a `label`.** The spec says a note, but
  `label` is the port's kind for free text, and it is what the tldraw adapter reports.

## Review Focus

1. **The native binary is missing on the host** (for example, `sharp` failed to install). Expected:
   `whiteboard_render` returns the load error, and the other tools work, because Squig loads the
   native packages lazily. Pinned in Task 5.
2. **The companion is started from an unexpected working directory** (an `npx` cache or a global
   install). Expected: the editor and fonts still resolve, because the paths come from
   `import.meta.url`. Pinned in Task 5: the integration test spawns with `cwd` set to an empty temp
   directory.
3. **`SQUIG_CHECKOUT` points at a missing directory.** Expected: the open fails and names that path.
   It does not fall back to the vendored copy, because an explicit override should not be ignored
   silently. Pinned in Task 3.
4. **The vendored output is edited by hand, or is out of sync with `VENDORED.json`.** Expected: a
   test fails. Pinned in Task 5 (the externals' versions) and in Task 2 (the file manifest
   checksum).
5. **A board name that has an old tldraw file but no Squig file.** After increment 3, expected: it
   opens as a new, empty Squig board, and the tldraw file is left untouched. Pinned in Task 9.

---

### Task 1: ADR, and record the deviations in the spec

**Files:**

- Create: `docs/decisions/<NNN>-whiteboard-squig-only.md`
- Modify: `docs/decisions/524-whiteboard-squig-default-canvas.md` (Consequences only)
- Modify: `docs/decisions/330-*.md` (Consequences only)
- Modify: `docs/superpowers/specs/2026-10-06-whiteboard-squig-only-design.md` (§5.1, §7)

- [ ] **Step 1: Rename the branch and get the ADR number.**

```bash
git branch -m feat/whiteboard-squig-only
pnpm adr:next
```

- [ ] **Step 2: Push a draft PR now, before writing the ADR** (ADR 223: an unpushed number is
      invisible to other seats).

```bash
git add docs/superpowers/plans/2026-10-06-whiteboard-squig-only.md
git commit -m "docs(plan): whiteboard Squig only (lane 01M49DRSSQ)

Co-authored-by: stanley <stanley@revive.musterd>"
git push -u origin feat/whiteboard-squig-only
gh pr create --draft --title "ADR <NNN>: whiteboard is Squig only — tldraw dropped, Squig vendored (lane 01M49DRSSQ)" --body "Spec and plan in docs/superpowers. Implementation follows on this branch."
```

- [ ] **Step 3: Write the ADR** with the skeleton from `07-conventions.md`:
  - **Context:** the 2026-10-02 park; ADR 524's fallback is what a stranger gets.
  - **Problem:** the package cannot be published while it bundles tldraw.
  - **Decision:**
    1. tldraw is removed from `@musterd/whiteboard`. This supersedes ADR 524 decision 2.
    2. Squig is vendored at a pinned commit by `packages/whiteboard/scripts/vendor-squig.mjs`, and
       the output is committed. A Squig upgrade is a re-vendor PR.
    3. The adapter prefers the vendored companion. `SQUIG_CHECKOUT` overrides it.
    4. New runtime dependencies: `@resvg/resvg-js` and `sharp` (hard rule 6). The alternative
       considered was optional dependencies; it was rejected per spec §5.3.
  - **Consequences:** package size (spec §10); credit to Pablo Stanley.

- [ ] **Step 4: Add dated notes** to the Consequences sections of ADR 524 and ADR 330, each pointing
      at the new ADR. Do not touch their Decision sections.

- [ ] **Step 5: Update the spec.**
  - §5.1: the script path, and the bundle entry `scripts/agent/local.ts` with the reason.
  - §7: the `text` item becomes a `label`.
  - The Status line: the ADR number.

- [ ] **Step 6: Check and commit.**

```bash
pnpm -s format:check && pnpm -s vocab:check && pnpm -s change-adr:check
git add docs/
git commit -m "docs(ADR <NNN>): whiteboard is Squig only — tldraw dropped, Squig vendored

Refs ADR-<NNN>
Co-authored-by: stanley <stanley@revive.musterd>"
git push
```

### Task 2: The vendor script, and the vendored output

**Files:**

- Create: `packages/whiteboard/scripts/vendor-squig.mjs`
- Create (generated): `packages/whiteboard/vendor/squig/**`
- Modify: `packages/whiteboard/package.json` (`"vendor:squig"` script)
- Modify: `.prettierignore` and `eslint.config.js` (ignore `packages/whiteboard/vendor/**`)

**Interfaces:**

- Produces:
  - `vendor/squig/lib/agent/companion.mjs`, run as `node companion.mjs mcp <file> [--port N]`.
  - `vendor/squig/VENDORED.json`, shaped as
    `{ upstream: string, commit: string, vendoredAt: string, externals: Record<string,string>, files: Record<string,string> }`.
    `files` maps each path relative to `vendor/squig` to its sha256.

- [ ] **Step 1: Write the script.**

```js
#!/usr/bin/env node
// Builds Squig (MIT, Pablo Stanley) at a pinned commit and vendors the local companion into this
// package (ADR <NNN>). Run: pnpm --filter @musterd/whiteboard vendor:squig [<commit>]
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const UPSTREAM = 'https://github.com/pablostanley/squig.git';
const COMMIT = process.argv[2] ?? '85f92ab132f5e621754b19de24ff95e67e474602';
const EXTERNALS = ['@resvg/resvg-js', 'sharp'];
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const dest = join(pkgRoot, 'vendor', 'squig');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'vendor-squig-'));
try {
  const src = join(work, 'squig');
  run('git', ['init', '-q', src]);
  run('git', ['remote', 'add', 'origin', UPSTREAM], src);
  run('git', ['fetch', '-q', '--depth', '1', 'origin', COMMIT], src);
  run('git', ['checkout', '-q', 'FETCH_HEAD'], src);
  run('pnpm', ['install', '--frozen-lockfile'], src);
  run('pnpm', ['build:local'], src);

  const out = join(work, 'bundle');
  await build({
    configFile: false,
    logLevel: 'warn',
    root: src,
    resolve: { alias: [{ find: /^@\//, replacement: `${src}/` }] },
    ssr: { noExternal: true, external: EXTERNALS },
    build: {
      ssr: join(src, 'scripts', 'agent', 'local.ts'),
      outDir: out,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      rollupOptions: {
        external: (id) => EXTERNALS.some((e) => id === e || id.startsWith(`${e}/`)),
        output: { format: 'es', entryFileNames: 'companion.mjs', inlineDynamicImports: true },
      },
    },
  });

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'lib', 'agent'), { recursive: true });
  cpSync(join(out, 'companion.mjs'), join(dest, 'lib', 'agent', 'companion.mjs'));
  cpSync(join(src, 'lib', 'agent', 'fonts'), join(dest, 'lib', 'agent', 'fonts'), { recursive: true });
  cpSync(join(src, 'out'), join(dest, 'out'), { recursive: true });
  cpSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));

  const externals = Object.fromEntries(
    EXTERNALS.map((e) => [e, JSON.parse(readFileSync(join(src, 'node_modules', e, 'package.json'), 'utf8')).version]),
  );
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dest, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dest);
  writeFileSync(
    join(dest, 'VENDORED.json'),
    `${JSON.stringify({ upstream: UPSTREAM, commit: COMMIT, vendoredAt: new Date().toISOString().slice(0, 10), externals, files }, null, 2)}\n`,
  );

  await smoke(join(dest, 'lib', 'agent', 'companion.mjs'), work);
  console.log(`vendored Squig ${COMMIT.slice(0, 7)} → ${relative(process.cwd(), dest)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Start the vendored companion on a scratch board and read one document back. */
async function smoke(companion, work) {
  const file = join(work, 'smoke.squig.json');
  const child = spawn(process.execPath, [companion, 'mcp', file], {
    cwd: work,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const editor = await new Promise((ok, fail) => {
    let err = '';
    const t = setTimeout(() => fail(new Error(`smoke: no editor line\n${err}`)), 30_000);
    child.stderr.on('data', (c) => {
      err += c;
      const m = err.match(/Open canvas: (\S+)/);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    child.on('exit', (code) => fail(new Error(`smoke: companion exited ${code}\n${err}`)));
  });
  const res = await fetch(editor.split('#')[0]);
  child.kill('SIGTERM');
  if (!res.ok || !(await res.text()).includes('<html')) throw new Error(`smoke: editor did not serve HTML (${res.status})`);
}
```

If Rolldown cannot bundle one of the pure-JavaScript packages (a dynamic `require`, for example),
add that package to `EXTERNALS` and to the package's dependencies, and record it in the ADR's
Consequences. Do not patch Squig.

- [ ] **Step 2: Add the package script, and ignore the vendored output in lint and format.**

In `packages/whiteboard/package.json`, under `scripts`, add
`"vendor:squig": "node scripts/vendor-squig.mjs"`. Add `packages/whiteboard/vendor/` to
`.prettierignore`, and to the `ignores` of `eslint.config.js`.

- [ ] **Step 3: Run it.**

```bash
pnpm --filter @musterd/whiteboard vendor:squig
du -sh packages/whiteboard/vendor/squig
```

Expected: the line `vendored Squig 85f92ab → …`, and roughly 9–10 MB.

- [ ] **Step 4: Commit.**

```bash
git add packages/whiteboard/scripts packages/whiteboard/vendor packages/whiteboard/package.json .prettierignore eslint.config.js
git commit -m "feat(whiteboard): vendor Squig 85f92ab — build-once script and committed companion (lane 01M49DRSSQ)

Refs ADR-<NNN>
Co-authored-by: stanley <stanley@revive.musterd>"
```

### Task 3: The adapter prefers the vendored companion

**Files:**

- Modify: `packages/whiteboard/src/squig/checkout.ts`
- Create: `packages/whiteboard/src/squig/checkout.test.ts`

**Interfaces:**

- Produces:
  - `SquigCheckout` becomes `{ kind: 'vendored' | 'checkout'; root: string; entry: string; loader: string | null; node: string }`.
  - `probeSquigCheckout(env, home, exists, node, vendoredRoot = VENDORED_ROOT): CheckoutProbe`.
  - `VENDORED_ROOT: string`, which is `<package>/vendor/squig`, resolved from the module URL.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from 'vitest';
import { probeSquigCheckout } from './checkout.js';

const NODE = { execPath: '/bin/node', version: '22.12.0' };
const VENDOR = '/pkg/vendor/squig';
const vendoredFiles = new Set([
  `${VENDOR}/lib/agent/companion.mjs`,
  `${VENDOR}/out/.squig-local-editor.json`,
]);

describe('probeSquigCheckout (ADR <NNN>)', () => {
  it('uses the vendored companion when nothing overrides it, with no loader', () => {
    const p = probeSquigCheckout({}, '/h', (f) => vendoredFiles.has(f), NODE, VENDOR);
    expect(p).toEqual({
      ok: true,
      checkout: { kind: 'vendored', root: VENDOR, entry: `${VENDOR}/lib/agent/companion.mjs`, loader: null, node: '/bin/node' },
    });
  });

  it('never looks at ~/.squig/src', () => {
    const seen: string[] = [];
    probeSquigCheckout({}, '/h', (f) => (seen.push(f), vendoredFiles.has(f)), NODE, VENDOR);
    expect(seen.some((f) => f.startsWith('/h/.squig'))).toBe(false);
  });

  it('SQUIG_CHECKOUT wins over the vendored copy', () => {
    const files = new Set([...vendoredFiles, '/c/scripts/squig.ts', '/c/scripts/register-loader.mjs', '/c/out/.squig-local-editor.json']);
    const p = probeSquigCheckout({ SQUIG_CHECKOUT: '/c' }, '/h', (f) => files.has(f), NODE, VENDOR);
    expect(p.ok && p.checkout.kind).toBe('checkout');
  });

  it('a SQUIG_CHECKOUT that does not exist fails and names it — no silent vendored fallback', () => {
    const p = probeSquigCheckout({ SQUIG_CHECKOUT: '/missing' }, '/h', (f) => vendoredFiles.has(f), NODE, VENDOR);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining('/missing') });
  });

  it('a package without its vendored copy says so', () => {
    const p = probeSquigCheckout({}, '/h', () => false, NODE, VENDOR);
    expect(p).toEqual({ ok: false, reason: expect.stringContaining(VENDOR) });
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**
      Run `pnpm --filter @musterd/whiteboard exec vitest run src/squig/checkout.test.ts`. Expected:
      FAIL. The probe has no fifth argument and returns no `kind`.

- [ ] **Step 3: Implement.** Replace the body of `checkout.ts`, keeping `nodeSupportsSquig`:

```ts
export const VENDORED_ROOT = fileURLToPath(new URL('../../vendor/squig', import.meta.url));

export function probeSquigCheckout(
  env: NodeJS.ProcessEnv = process.env,
  _home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
  node: { execPath: string; version: string } = { execPath: process.execPath, version: process.versions.node },
  vendoredRoot: string = VENDORED_ROOT,
): CheckoutProbe {
  const override = env['SQUIG_CHECKOUT'];
  if (override) {
    const root = resolve(override);
    const entry = join(root, 'scripts', 'squig.ts');
    const loader = join(root, 'scripts', 'register-loader.mjs');
    if (!exists(entry) || !exists(loader)) return { ok: false, reason: `SQUIG_CHECKOUT=${root} is not a Squig checkout` };
    if (!exists(join(root, 'out', '.squig-local-editor.json')))
      return { ok: false, reason: `Squig checkout at ${root} has no local editor build — run \`pnpm build:local\` there` };
    if (!nodeSupportsSquig(node.version))
      return { ok: false, reason: `Squig needs Node 22.6 or newer; the whiteboard service runs Node ${node.version}` };
    return { ok: true, checkout: { kind: 'checkout', root, entry, loader, node: node.execPath } };
  }
  const entry = join(vendoredRoot, 'lib', 'agent', 'companion.mjs');
  if (!exists(entry) || !exists(join(vendoredRoot, 'out', '.squig-local-editor.json')))
    return { ok: false, reason: `this package's vendored Squig is missing at ${vendoredRoot} — reinstall @musterd/whiteboard` };
  return { ok: true, checkout: { kind: 'vendored', root: vendoredRoot, entry, loader: null, node: node.execPath } };
}
```

Update the header comment: Squig is vendored (ADR <NNN>), and `SQUIG_CHECKOUT` overrides it for
testing a newer upstream. The `_home` parameter stays for one increment, so callers do not change.
Increment 3 removes it.

- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with the message
      `feat(whiteboard): the Squig adapter prefers the vendored companion (lane 01M49DRSSQ)`.

### Task 4: The spawn arguments follow the checkout's kind

**Files:**

- Modify: `packages/whiteboard/src/squig/session.ts:114-129`
- Modify: `packages/whiteboard/src/squig/provider.test.ts` (add one `describe`)

**Interfaces:**

- Consumes: `SquigCheckout` from Task 3.
- Produces: `export function companionArgs(checkout: SquigCheckout, file: string): string[]`.

- [ ] **Step 1: Write the failing test.**

```ts
import { companionArgs } from './session.js';

describe('companionArgs (ADR <NNN>)', () => {
  it('runs the vendored companion as plain JavaScript', () => {
    expect(companionArgs({ kind: 'vendored', root: '/v', entry: '/v/lib/agent/companion.mjs', loader: null, node: '/n' }, '/b.squig.json'))
      .toEqual(['/v/lib/agent/companion.mjs', 'mcp', '/b.squig.json']);
  });
  it('runs a checkout through strip-types and its loader, as before', () => {
    expect(companionArgs({ kind: 'checkout', root: '/c', entry: '/c/scripts/squig.ts', loader: '/c/scripts/register-loader.mjs', node: '/n' }, '/b.squig.json'))
      .toEqual(['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', '/c/scripts/register-loader.mjs', '/c/scripts/squig.ts', 'mcp', '/b.squig.json']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail.** Expected: `companionArgs` is not exported.

- [ ] **Step 3: Implement.** Add the function, and use it in `start`:

```ts
export function companionArgs(checkout: SquigCheckout, file: string): string[] {
  if (checkout.kind === 'vendored') return [checkout.entry, 'mcp', file];
  return ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', checkout.loader!, checkout.entry, 'mcp', file];
}
// in start():
const child = spawn(checkout.node, companionArgs(checkout, file), {
  cwd: checkout.root,
  stdio: ['pipe', 'ignore', 'pipe'],
});
```

- [ ] **Step 4: Run the tests and see them pass.** Run
      `pnpm --filter @musterd/whiteboard exec vitest run src/squig`.

- [ ] **Step 5: Commit** with the message
      `feat(whiteboard): spawn the vendored companion without strip-types (lane 01M49DRSSQ)`.

### Task 5: Dependencies, package contents, and the live test with no checkout

**Files:**

- Modify: `packages/whiteboard/package.json` (`dependencies`, `files`, `description`)
- Modify: `pnpm-lock.yaml` (via `pnpm install`)
- Modify: `packages/whiteboard/src/squig/squig.integration.test.ts`
- Create: `packages/whiteboard/src/squig/vendored.test.ts`

- [ ] **Step 1: Write the failing manifest test.**

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENDORED_ROOT } from './checkout.js';

const vendored = JSON.parse(readFileSync(join(VENDORED_ROOT, 'VENDORED.json'), 'utf8')) as {
  externals: Record<string, string>;
  files: Record<string, string>;
};
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
  files: string[];
};

describe('the vendored Squig (ADR <NNN>)', () => {
  it("declares exactly the bundle's externals, at the vendored versions", () => {
    for (const [name, version] of Object.entries(vendored.externals)) expect(pkg.dependencies[name]).toBe(version);
  });
  it('ships the vendor directory', () => {
    expect(pkg.files).toContain('vendor');
  });
  it('matches its manifest — nobody hand-edited the vendored output', () => {
    for (const [rel, sha] of Object.entries(vendored.files)) {
      expect(createHash('sha256').update(readFileSync(join(VENDORED_ROOT, rel))).digest('hex'), rel).toBe(sha);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: the dependencies are missing, and `files`
      lacks `vendor`.

- [ ] **Step 3: Update `package.json`.**
  - Add `@resvg/resvg-js` and `sharp` to `dependencies`, at the exact versions in `VENDORED.json`.
  - Add `vendor` to `files`.
  - Change the description's adapter clause to: "Squig adapter (vendored, ADR <NNN>)". Leave
    "tldraw adapter (fallback)" in until increment 3.
  - Run `pnpm install`.

- [ ] **Step 4: Make the live test always run, with no checkout and from a foreign working
      directory.** In `squig.integration.test.ts`:
  - Delete `describe.skipIf(!probe.ok)`.
  - Rewrite the header comment: the test runs everywhere, CI included, against the vendored
    companion.
  - Add the setup and the two tests below.

```ts
const realHome = process.env['HOME'];
const realCwd = process.cwd();
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-squig-live-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  process.env['HOME'] = mkdtempSync(join(tmpdir(), 'wb-empty-home-')); // no ~/.squig/src
  delete process.env['SQUIG_CHECKOUT'];
  process.chdir(mkdtempSync(join(tmpdir(), 'wb-foreign-cwd-')));
  const p = probeSquigCheckout();
  if (!p.ok || p.checkout.kind !== 'vendored') throw new Error(`expected the vendored companion: ${JSON.stringify(p)}`);
  provider = new SquigProvider(p.checkout);
});
afterAll(async () => {
  await provider?.closeAll();
  process.chdir(realCwd);
  process.env['HOME'] = realHome;
  delete process.env['WHITEBOARD_DATA_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

it('serves the editor page from the vendored build', async () => {
  await provider.open('page');
  const res = await fetch((await provider.editorUrl('page')).split('#')[0]!);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<html');
});

it('renders a PNG through the vendored native packages', async () => {
  await provider.open('render');
  await provider.add('render', ADA, [{ kind: 'note', text: 'pixels' }]);
  const out = await provider.squigTool('render', 'render_document', { format: 'png' }, 'seat:ada');
  expect(JSON.stringify(out)).toMatch(/image\/png|"png"/);
});
```

Check the `render_document` argument names against `lib/agent/schema.ts` in the vendored source
before running. `squigTool` passes them through verbatim (ADR 527).

- [ ] **Step 5: Run the Squig tests.**
      `pnpm --filter @musterd/whiteboard exec vitest run src/squig`. Expected: PASS, with the
      integration test no longer skipped.

- [ ] **Step 6: Commit** with the message
      `feat(whiteboard): resvg and sharp declared; the live Squig test runs everywhere (lane 01M49DRSSQ)`.

### Task 6: Land increment 1

- [ ] **Step 1: Run the fast gates.**
      `pnpm typecheck && pnpm lint && pnpm format:check`. Also run `pnpm arch-trees:check` if
      `docs/architecture` lists the whiteboard tree.
- [ ] **Step 2: Mark the PR ready and arm auto-merge.**
      `gh pr ready <n> && gh pr merge <n> --squash --auto --delete-branch`. Arm a waiter that exits
      on a red `gates` as well as on the merge (`docs/wiki/shipping-a-pr.md`).
- [ ] **Step 3: After the merge,** run
      `lane_submit {id: '01M49DRSSQXBH58SEWEMK2QP5M', pr, sha, authorized_by: 'nick'}`, follow its
      reply, and clear the local branch (AGENTS.md git workflow §6).

### Task 7: Convert and archive nick's tldraw boards (increment 2, local only)

**Files:** none in the repo. The script lives at `<scratchpad>/convert-board.mts`.

**Interfaces:**

- Consumes:
  - `TldrawProvider`, `RoomManager` and `SquigProvider` from `packages/whiteboard/dist/index.js`,
    as built on `main` after increment 1.
  - `probeSquigCheckout` from `dist/squig/checkout.js`.

- [ ] **Step 1: Archive all three boards.**

```bash
cp -Rp ~/.whiteboard/boards ~/.whiteboard/boards-tldraw-archive-2026-10-06
ls ~/.whiteboard/boards-tldraw-archive-2026-10-06
```

Expected: `demo.json`, `miley-accept-1144-probe.json` and `musterd-user-agent-flow.json`.

- [ ] **Step 2: Write the conversion.**

```ts
import { RoomManager, SquigProvider, TldrawProvider } from '<repo>/packages/whiteboard/dist/index.js';
import { probeSquigCheckout } from '<repo>/packages/whiteboard/dist/squig/checkout.js';
import type { CreatedBy, ItemInput, OutlineItem } from '<repo>/packages/whiteboard/dist/port.js';

const BOARD = 'musterd-user-agent-flow';
const src = await new TldrawProvider(new RoomManager({ idleTimeoutMs: 60_000, persistIntervalMs: 60_000 })).read(BOARD);
const p = probeSquigCheckout();
if (!p.ok) throw new Error(p.reason);
const dst = new SquigProvider(p.checkout);
await dst.open(BOARD);

const idMap = new Map<string, string>();
const byActor = (kind: OutlineItem['kind']) => {
  const groups = new Map<CreatedBy, OutlineItem[]>();
  for (const i of src.items.filter((x) => x.kind === kind)) groups.set(i.createdBy, [...(groups.get(i.createdBy) ?? []), i]);
  return groups;
};
const place = async (kind: OutlineItem['kind'], toInput: (i: OutlineItem) => ItemInput) => {
  for (const [actor, items] of byActor(kind)) {
    const { ids } = await dst.add(BOARD, actor, items.map(toInput));
    items.forEach((it, n) => idMap.set(it.id, ids[n]!));
  }
};
await place('cluster', (i) => ({ kind: 'cluster', title: i.text, x: i.x, y: i.y }));
await place('note', (i) => ({ kind: 'note', text: i.text, ...(i.detail ? { detail: i.detail } : {}), ...(i.cluster ? { cluster: idMap.get(i.cluster)! } : { x: i.x, y: i.y }) }));
await place('label', (i) => ({ kind: 'label', text: i.text, x: i.x, y: i.y }));
await place('link', (i) => ({ kind: 'link', from: idMap.get(i.from!)!, to: idMap.get(i.to!)!, ...(i.text ? { label: i.text } : {}) }));

const out = await dst.close(BOARD);
const count = (items: OutlineItem[]) => Object.fromEntries(['note', 'cluster', 'link', 'label', 'other'].map((k) => [k, items.filter((i) => i.kind === k).length]));
console.log('source', count(src.items), 'squig', count(out.items));
await dst.closeAll();
```

- [ ] **Step 3: Build `main` and run the conversion.**

```bash
git switch --detach origin/main && pnpm --filter @musterd/whiteboard build
npx tsx <scratchpad>/convert-board.mts
```

Expected: the `source` and `squig` counts match for note, cluster, link and label. `other` is 0
on both sides.

- [ ] **Step 4: Spot-check.** Open the board's editor URL (`whiteboard_open`) and confirm that the
      clusters hold their notes. Then show nick the URL.
- [ ] **Step 5: Resolve the lane.**
      `lane_resolve {id: '01M49DW741NDGNR1NCNYBWZJ5C'}`. The lane is low stakes and exempt from
      acceptance. Note the counts in the resolve.

### Task 8: Move `dataDir` out of `src/sync`, and inject the provider for tests

**Files:**

- Create: `packages/whiteboard/src/data-dir.ts`
- Create: `packages/whiteboard/src/squig/fake.ts` (moved `FakeSquig` out of `provider.test.ts`)
- Modify: `src/auth.ts:17`, `src/squig/provider.ts:20`, `src/squig/provider.test.ts`,
  `src/service.ts:86` and `tsconfig.json` (exclude `src/squig/fake.ts` from the build)

**Interfaces:**

- Produces:
  - `export function dataDir(): string` in `src/data-dir.ts`.
  - `startService(port?: number, deps?: { squig?: SquigProvider }): Promise<RunningService>`.
  - `export class FakeSquig implements SquigConnection` in `src/squig/fake.ts`.

- [ ] **Step 1: Move the code.**
  - Move `dataDir()` verbatim from `src/sync/persistence.ts` to `src/data-dir.ts`, and repoint
    `auth.ts` and `squig/provider.ts` at it.
  - Move the `FakeSquig` class out of `provider.test.ts` into `src/squig/fake.ts`, unchanged, and
    import it back in the test.
  - Add `"exclude": ["src/**/*.test.ts", "src/squig/fake.ts"]` to `tsconfig.json`, merged with
    whatever exclude it already has.
- [ ] **Step 2: Run the whole package suite,** with
      `pnpm --filter @musterd/whiteboard exec vitest run`. Expected: PASS. Nothing has changed in
      behavior yet.
- [ ] **Step 3: Add the `deps` parameter to `startService`.** In the body:
      `const squig = deps?.squig ?? (choice.probe?.ok ? new SquigProvider(choice.probe.checkout) : null);`.
      Run the suite again.
- [ ] **Step 4: Commit** with the message
      `refactor(whiteboard): dataDir leaves src/sync; the service takes an injected Squig provider (lane 01M49DWAA4)`.

### Task 9: The service is Squig only

**Files:**

- Modify: `src/service.ts`, `src/service.test.ts`, `src/mcp/mcp.test.ts`, `src/mcp/index.ts:49`,
  `src/index.ts` and `vitest.config.ts`

- [ ] **Step 1: Rewrite the tests that assumed tldraw.**
  - In `service.test.ts` and `mcp.test.ts`, start the service with
    `startService(0, { squig: new SquigProvider(FAKE_CHECKOUT, async () => new FakeSquig()) })`,
    where
    `FAKE_CHECKOUT = { kind: 'vendored', root: '/v', entry: '/v/c.mjs', loader: null, node: process.execPath }`.
  - Change the assertions on `/b/<name>` URLs to expect the fake's
    `http://127.0.0.1:1/?local=1#token=t`.
  - Delete the tldraw sync test (`service.test.ts:149-180`).
  - Replace the `chooseProvider` describe block with:

```ts
describe('no fallback (ADR <NNN>)', () => {
  it('opening a board when Squig cannot start fails with the reason; listing still works', async () => {
    await service.close();
    service = await startService(0, {
      squig: new SquigProvider(FAKE_CHECKOUT, async () => {
        throw new Error('vendored Squig is missing at /v');
      }),
    });
    base = `http://127.0.0.1:${service.port}`;
    const open = await authFetch(`${base}/api/boards/x/open`, { method: 'POST' });
    expect(open.status).toBeGreaterThanOrEqual(500);
    expect(await open.text()).toContain('vendored Squig is missing at /v');
    expect((await authFetch(`${base}/api/boards`)).status).toBe(200);
  });

  it('a board name with only an old tldraw file opens as a new Squig board and leaves the file alone', async () => {
    const legacy = join(dir, 'boards', 'legacy.json');
    await mkdir(join(dir, 'boards'), { recursive: true });
    await writeFile(legacy, '{"records":[]}');
    const open = await authFetch(`${base}/api/boards/legacy/open`, { method: 'POST' });
    expect(((await open.json()) as { created: boolean }).created).toBe(true);
    expect(await readFile(legacy, 'utf8')).toBe('{"records":[]}');
  });
});
```

  Add `mkdir`, `writeFile` and `readFile` to the `node:fs/promises` import. The shared
  `beforeEach` must start the service with the injected fake (step 1's first bullet), and
  `afterEach` closes whichever `service` is current. If the open's status is a 4xx rather than a
  5xx, keep the reason assertion and match the status that `service.ts` uses for provider errors.

- [ ] **Step 2: Run the tests and watch them fail.** Expected: the service still builds a
      `TldrawProvider`, so the URLs differ.

- [ ] **Step 3: Implement.** In `service.ts`:
  - Delete `ProviderName`, `chooseProvider`, `boardUrl`, `WEB_DIST`, `MIME`, `serveStatic`, the
    `/b/` route, the WebSocket server and the `/ws/` upgrade, `RoomManager` and `TldrawProvider`.
  - Build the provider as `const probe = probeSquigCheckout();` and
    `const squig = deps?.squig ?? (probe.ok ? new SquigProvider(probe.checkout) : new SquigProvider(UNAVAILABLE, async () => { throw new Error(probe.reason); }));`,
    where `UNAVAILABLE` is a constant `SquigCheckout`.
  - Use `squig` as the provider everywhere. `/healthz` reports `provider: 'squig'`, and the
    `rooms` count goes.
  - The `squig/<tool>` route loses its "this service runs tldraw" branch.
  - Rewrite the header comment to list the three surfaces that remain.

  Elsewhere:
  - In `index.ts`, drop the `TldrawProvider` and `RoomManager` exports.
  - In `mcp/index.ts:49`, describe `color` as "color name, default yellow".
  - In `vitest.config.ts`, drop the `env` block and its comment.

- [ ] **Step 4: Run the tests and see them pass.** Run the whole package suite.
- [ ] **Step 5: Commit** with the message
      `feat(whiteboard)!: Squig only — no tldraw fallback, page or sync route (lane 01M49DWAA4)`.

### Task 10: Delete tldraw

**Files:**

- Delete: `src/tldraw/`, `src/sync/`, `web/`, `vite.config.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `src/squig/checkout.ts` (drop `_home`) and
  `.gitignore` (`dist-web`)
- Create: `packages/whiteboard/src/no-tldraw.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkgDir = new URL('..', import.meta.url).pathname;

describe('no tldraw ships (ADR <NNN>)', () => {
  it('no tldraw package in the manifest', () => {
    const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(names.filter((n) => /tldraw/.test(n))).toEqual([]);
  });
  it('nothing tldraw in the packed tarball', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' });
    const files = (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    expect(files.filter((f) => /tldraw|dist-web/.test(f))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail.** Expected: `@tldraw/*` is listed.
- [ ] **Step 3: Delete and clean up.**
  - Remove the four `@tldraw/*` packages and `ws` from `dependencies`, if nothing else imports
    `ws`.
  - Remove `tldraw`, `react`, `react-dom`, `@types/react*`, `@types/ws` and `@vitejs/plugin-react`
    from `devDependencies`. Keep `vite`, which the vendor script uses.
  - Remove `dist-web` from `files`. Change `build` to `tsc -p tsconfig.json`.
  - Fix the description so it says "Squig (vendored, ADR <NNN>)".
  - Drop `_home` from `probeSquigCheckout` and its callers.
  - Run `pnpm install`.
- [ ] **Step 4: Run the package suite and the fast gates,** with
      `pnpm --filter @musterd/whiteboard exec vitest run && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** with the message
      `feat(whiteboard)!: delete tldraw — adapter, sync rooms, web page and dependencies (lane 01M49DWAA4)`.

### Task 11: Docs, and land increment 3

**Files:**

- Modify: `packages/whiteboard/SKILL.md`, `content/roadmap.data.ts` and `ROADMAP.md`
  (regenerated)

- [ ] **Step 1: Update the docs.**
  - Remove every tldraw line from `SKILL.md`. Its board URLs are Squig editor URLs now.
  - In `content/roadmap.data.ts`, edit the whiteboard entry: Squig is vendored and tldraw is
    dropped.
  - Run `pnpm roadmap:gen`.
- [ ] **Step 2: Run the fast gates,** including `pnpm roadmap:check` and `pnpm vocab:check`.
- [ ] **Step 3: Open the PR and arm auto-merge,** waiting on both outcomes, as in Task 6.
- [ ] **Step 4: After the merge,** run `lane_submit` for `01M49DWAA4DB6FJBPB1G98V0SP` and follow
      its reply. Then tell nick that lane `01M2PAMFW1` (extraction and publish) is unblocked.
