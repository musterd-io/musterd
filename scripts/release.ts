/**
 * Lockstep release of @musterd/* (ADR 156), published from CI with provenance (ADR 782).
 *
 *   pnpm release --dry-run              # build → consumer smoke → pack, no registry write
 *   pnpm release --version 0.7.0        # bump → build → consumer smoke; the bump lands as a PR
 *   pnpm release --pack --tag v0.7.0 --out DIR          # CI job 1: build → pnpm pack → DIR + sums
 *   pnpm release --smoke --tag v0.7.0 --tarballs DIR    # CI job 2: consumer install + probes
 *   pnpm release --publish --tag v0.7.0 --tarballs DIR  # CI job 3 (OIDC): npm publish, provenance
 *   (.github/workflows/release.yml runs all three; --publish without --tarballs is break-glass)
 *
 * Publish order: protocol → telemetry → server → mcp → cli.
 *
 * Every run — dry, bump or publish — installs the packed tarballs into a clean directory outside the
 * workspace and runs them before anything is published (release/smoke.ts). That gate exists because
 * 0.4.0 reached npm unloadable: a workspace install has the dev deps, so the whole suite passes on
 * a package no consumer can import, and npm versions cannot be replaced.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PACKAGE_DIRS,
  PUBLISH_ORDER,
  assertPublishable,
  assertTagMatches,
  bumpPackageJson,
  bumpServerJson,
  nextStepsAfterBump,
  nextStepsAfterPublish,
  npmPublishArgs,
  parseReleaseArgs,
  tarballFileName,
  type PublishPackageName,
} from './release/helpers.ts';
import { packAll, smokeConsumerInstall, smokeTarballs } from './release/smoke.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): string {
  return `Usage: pnpm release --version X.Y.Z [--allow-dirty]
       pnpm release --dry-run
       pnpm release --pack --tag vX.Y.Z --out DIR
       pnpm release --smoke --tag vX.Y.Z --tarballs DIR
       pnpm release --publish --tag vX.Y.Z [--tarballs DIR] [--no-provenance]

Releases @musterd/* in lockstep (ADR 156), published from CI with provenance (ADR 782).

--version bumps every package to X.Y.Z, builds and smoke-tests. It publishes nothing: the bump
lands as a PR, and pushing tag vX.Y.Z on its merge commit starts the release workflow. --version
has no default — an npm version can never be unpublished, so the number is a decision — and it
must be higher than the one on disk, or npm would move \`latest\` backwards.
--dry-run builds, smoke-tests and packs at the versions already on disk; never bumps or publishes.
--pack, --smoke and --publish are the release workflow's three jobs; each refuses a tag that does
not name the version on disk. --pack builds and packs into DIR with SHA256SUMS. --smoke installs
those tarballs into a clean dir and runs them. --publish --tarballs DIR checks them against
DIR/SHA256SUMS (written from the pack job's outputs) and uploads exactly those files; packages
already on the registry at that version are skipped, so a re-run finishes a half-published release.
Without --tarballs, --publish builds and smokes itself. Outside GitHub Actions npm cannot sign provenance, so a
laptop publish (break-glass only) must pass --no-provenance.

Every run installs the packed tarballs into a clean directory outside the workspace and runs
them, BEFORE any registry write — the check that would have caught 0.4.0.
`;
}

function assertCleanTree(allowDirty: boolean): void {
  if (allowDirty) return;
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (status) {
    throw new Error(
      `working tree is dirty — commit or stash first, or pass --allow-dirty\n${status}`,
    );
  }
}

function packageJsonPath(name: PublishPackageName): string {
  return join(ROOT, 'packages', PACKAGE_DIRS[name], 'package.json');
}

function bumpAll(version: string): void {
  for (const name of PUBLISH_ORDER) {
    const path = packageJsonPath(name);
    const next = bumpPackageJson(readFileSync(path, 'utf8'), version);
    writeFileSync(path, next);
    console.log(`bumped ${name} → ${version}`);
  }
  const serverJson = join(ROOT, 'packages', 'mcp', 'server.json');
  writeFileSync(serverJson, bumpServerJson(readFileSync(serverJson, 'utf8'), version));
  console.log(`bumped packages/mcp/server.json → ${version}`);
}

/** The version the working tree currently carries — the CLI is the user-facing one. */
function currentVersion(): string {
  const raw = readFileSync(packageJsonPath('@musterd/cli'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

/** A patch bump, offered only as an EXAMPLE in the error — never applied. */
function suggestNext(current: string): string {
  const [x, y, z] = current.split('-')[0]!.split('.').map(Number);
  return `${x}.${y}.${(z ?? 0) + 1}`;
}

function buildAll(): void {
  console.log('pnpm -r build…');
  execFileSync('pnpm', ['-r', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

function packOne(name: PublishPackageName): void {
  const dir = join(ROOT, 'packages', PACKAGE_DIRS[name]);
  console.log(`npm pack ${name}…`);
  execFileSync('npm', ['pack', '--dry-run'], { cwd: dir, stdio: 'inherit' });
}

/** True when `name@version` is already on the registry — read, never assumed. */
function alreadyPublished(name: PublishPackageName, version: string): boolean {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() === version;
  } catch {
    // E404 for a package npm has never seen. Anything else (a network failure) also lands here, and
    // the publish that follows will then fail loudly on its own — never silently skip on doubt.
    return false;
  }
}

function publishTarball(name: PublishPackageName, tarball: string, provenance: boolean): void {
  console.log(`npm publish ${name}${provenance ? ' (with provenance)' : ' (NO provenance)'}…`);
  execFileSync('npm', npmPublishArgs(tarball, provenance), { cwd: ROOT, stdio: 'inherit' });
}

const SUMS = 'SHA256SUMS';

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

function fail(e: unknown): number {
  process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
  return 1;
}

/** Build and smoke at the on-disk version; the smoked tarballs are left in `dir`. */
function buildAndSmoke(dir: string): Record<PublishPackageName, string> {
  buildAll();
  // The gate, BEFORE any registry write: 0.4.0 shipped unloadable because its only consumer check
  // ran after publishing (release/smoke.ts).
  return smokeConsumerInstall(ROOT, undefined, dir);
}

/**
 * The workflow's first job (ADR 782): build and pack into `out`, and write SHA256SUMS there. No
 * unlocked install has run yet, so the workflow records these sums as job outputs and the publish
 * job checks against those — nothing the smoke job runs can change what gets published.
 */
function runPack(tag: string, out: string, allowDirty: boolean): number {
  const version = currentVersion();
  try {
    assertTagMatches(tag, version);
    assertCleanTree(allowDirty);
  } catch (e) {
    return fail(e);
  }
  console.log(`pack @ ${version} from ${tag} → ${out}`);
  mkdirSync(out, { recursive: true });
  buildAll();
  const tarballs = packAll(ROOT, out);
  const lines = PUBLISH_ORDER.map((n) => `${sha256(tarballs[n])}  ${basename(tarballs[n])}`);
  writeFileSync(join(out, SUMS), `${lines.join('\n')}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log(`\n✓ packed @musterd/*@${version} — nothing published`);
  return 0;
}

/** The tarballs for `version` in `dir`, by pnpm's file names. */
function tarballsIn(dir: string, version: string): Record<PublishPackageName, string> {
  const out = {} as Record<PublishPackageName, string>;
  for (const name of PUBLISH_ORDER) {
    const path = join(dir, tarballFileName(name, version));
    if (!existsSync(path)) {
      throw new Error(`${name}: ${basename(path)} is not in ${dir} — did the pack job run?`);
    }
    out[name] = path;
  }
  return out;
}

/** The workflow's second job: install the packed tarballs into a clean dir and run them. */
function runSmoke(tag: string, dir: string): number {
  const version = currentVersion();
  try {
    assertTagMatches(tag, version);
    smokeTarballs(tarballsIn(dir, version), version);
  } catch (e) {
    return fail(e);
  }
  return 0;
}

/** The tarballs the pack job left in `dir`, each checked against its SHA256SUMS line. */
function smokedTarballs(dir: string, version: string): Record<PublishPackageName, string> {
  const sums = new Map(
    readFileSync(join(dir, SUMS), 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        const [hash, file] = l.split(/\s+/);
        return [file!, hash!] as const;
      }),
  );
  const tarballs = tarballsIn(dir, version);
  for (const name of PUBLISH_ORDER) {
    const file = basename(tarballs[name]);
    if (sums.get(file) !== sha256(tarballs[name])) {
      throw new Error(`${name}: ${file} does not match ${SUMS} — refusing to publish it`);
    }
    console.log(`  ✓ ${file} ${sums.get(file)}`);
  }
  return tarballs;
}

/**
 * Publish what is on disk, from the tag that names it (ADR 782). In CI, `tarballsDir` holds what the
 * pack job smoked and this step builds and installs nothing; without it (break-glass), it builds and
 * smokes first.
 */
function runPublish(
  tag: string,
  noProvenance: boolean,
  allowDirty: boolean,
  tarballsDir: string | undefined,
): number {
  const version = currentVersion();
  try {
    assertTagMatches(tag, version);
    assertCleanTree(allowDirty);
  } catch (e) {
    return fail(e);
  }
  const provenance = !noProvenance;
  if (provenance && process.env.GITHUB_ACTIONS !== 'true') {
    return fail(
      `npm can sign provenance only inside a supported CI run. Releases publish from ` +
        `.github/workflows/release.yml (push tag ${tag}); a break-glass laptop publish must pass ` +
        `--no-provenance and say why in the release notes (ADR 782 §4).`,
    );
  }

  console.log(`publish @ ${version} from ${tag} (order: ${PUBLISH_ORDER.join(' → ')})`);
  let tarballs: Record<PublishPackageName, string>;
  try {
    tarballs = tarballsDir
      ? smokedTarballs(tarballsDir, version)
      : buildAndSmoke(mkdtempSync(join(tmpdir(), 'musterd-release-')));
  } catch (e) {
    return fail(e);
  }

  for (const name of PUBLISH_ORDER) {
    if (alreadyPublished(name, version)) {
      console.log(`${name}@${version} is already on the registry — skipped`);
      continue;
    }
    publishTarball(name, tarballs[name], provenance);
  }

  console.log(`\n✓ published @musterd/*@${version}`);
  console.log('\nNext:');
  for (const line of nextStepsAfterPublish(version)) console.log(`  ${line}`);
  return 0;
}

export function runRelease(argv: string[]): number {
  let args;
  try {
    args = parseReleaseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'HELP') {
      process.stdout.write(usage());
      return 0;
    }
    process.stderr.write(`${msg}\n${usage()}`);
    return 1;
  }

  if (args.pack) return runPack(args.tag!, args.out!, args.allowDirty);
  if (args.smoke) return runSmoke(args.tag!, args.tarballs!);
  if (args.publish) {
    return runPublish(args.tag!, args.noProvenance, args.allowDirty, args.tarballs);
  }

  const current = currentVersion();

  // A real bump must be told its version, and that version must be able to BE a release. Both
  // checks are here rather than in the parser because a dry run legitimately needs neither: it
  // never bumps and never writes, so it just reports the versions already on disk.
  if (!args.dryRun) {
    if (!args.version) {
      process.stderr.write(
        `a release version is required — there is no safe default for a number that can never be ` +
          `unpublished.\n  current: ${current}\n  e.g. pnpm release --version ${suggestNext(current)}\n`,
      );
      return 1;
    }
    try {
      assertPublishable(args.version, current);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
      return 1;
    }
  }

  try {
    assertCleanTree(args.allowDirty);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }

  console.log(
    args.dryRun
      ? `dry-run release @ ${current} (on disk; order: ${PUBLISH_ORDER.join(' → ')})`
      : `bump @ ${args.version} (order: ${PUBLISH_ORDER.join(' → ')})`,
  );

  if (!args.dryRun) {
    bumpAll(args.version!);
  } else {
    console.log('(dry-run) skipping version bump');
  }

  buildAll();

  // The gate, deliberately BEFORE the first registry write and on dry runs too.
  //
  // 0.4.0 shipped unloadable and burned two version numbers, because the only consumer check we had
  // was printed under "Next:" *after* publishing — where it can confirm damage and nothing else.
  // npm versions cannot be replaced, so the check has to be able to stop the release.
  try {
    smokeConsumerInstall(ROOT);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }

  if (args.dryRun) {
    for (const name of PUBLISH_ORDER) packOne(name);
    console.log('\n✓ dry-run complete — no registry writes');
  } else {
    // A bump cannot reach here without a version: the `!args.dryRun` precondition block returns 1
    // on a missing one, before anything is bumped. Same fact `bumpAll(args.version!)` relies on.
    const version = args.version!;
    console.log(`\n✓ bumped and smoke-tested @musterd/*@${version} — nothing published`);
    console.log('\nNext (ADR 782 — the publish runs in CI, from the tag):');
    for (const line of nextStepsAfterBump(version)) console.log(`  ${line}`);
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isMain) {
  process.exit(runRelease(process.argv.slice(2)));
}
