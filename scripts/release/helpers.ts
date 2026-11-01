/**
 * Lockstep npm release helpers for @musterd/* (ADR 156; the publish moved to CI in ADR 782).
 * Pure functions — the CLI driver is scripts/release.ts.
 */
export const PUBLISH_ORDER = [
  '@musterd/protocol',
  '@musterd/telemetry',
  '@musterd/server',
  '@musterd/mcp',
  '@musterd/cli',
] as const;

export type PublishPackageName = (typeof PUBLISH_ORDER)[number];

/** Map npm name → packages/<dir>. */
export const PACKAGE_DIRS: Record<PublishPackageName, string> = {
  '@musterd/protocol': 'protocol',
  '@musterd/telemetry': 'telemetry',
  '@musterd/server': 'server',
  '@musterd/mcp': 'mcp',
  '@musterd/cli': 'cli',
};

export interface ReleaseArgs {
  dryRun: boolean;
  allowDirty: boolean;
  /**
   * `--publish` — the CI half (ADR 782): publish the versions already on disk, from the tag the
   * release workflow was pushed with. Never bumps. Exclusive with `--version` and `--dry-run`.
   */
  publish: boolean;
  /**
   * `--pack --out DIR` — the workflow's first job (ADR 782): build, smoke, and leave the smoked
   * tarballs in DIR. Runs with no OIDC token, because the smoke executes third-party install scripts.
   */
  pack: boolean;
  out?: string;
  /**
   * `--publish --tarballs DIR` — the workflow's second job: publish the tarballs the pack job
   * smoked, building nothing and installing nothing. Without it, `--publish` builds and smokes
   * itself (the break-glass laptop path).
   */
  tarballs?: string;
  /** `--tag vX.Y.Z` — the git tag that triggered the run; must name the on-disk version. */
  tag?: string;
  /**
   * `--no-provenance` — publish without a provenance attestation. Outside GitHub Actions npm cannot
   * sign one, so a laptop publish (the break-glass path, ADR 782 §4) has to say so out loud.
   */
  noProvenance: boolean;
  /**
   * Target version for all public packages. **No default, deliberately.**
   *
   * It used to default to `'0.3.0'`, a literal frozen in source — stale from the moment 0.3.0
   * shipped, and wrong in principle whatever number it held: the version is the one irreversible
   * decision in a release (npm never lets a version be replaced), so it belongs to whoever is
   * making it, not to a constant. Undefined on a dry run is fine; `runRelease` demands it before
   * anything is published.
   */
  version?: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseArgs(argv: string[]): ReleaseArgs {
  let dryRun = false;
  let allowDirty = false;
  let publish = false;
  let pack = false;
  let noProvenance = false;
  let version: string | undefined;
  let tag: string | undefined;
  let out: string | undefined;
  let tarballs: string | undefined;
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (!v || v.startsWith('-')) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--allow-dirty') allowDirty = true;
    else if (a === '--publish') publish = true;
    else if (a === '--pack') pack = true;
    else if (a === '--out') out = value(a, ++i);
    else if (a === '--tarballs') tarballs = value(a, ++i);
    else if (a === '--no-provenance') noProvenance = true;
    else if (a === '--tag') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--tag requires a value (vX.Y.Z)');
      tag = v;
    } else if (a.startsWith('--tag=')) tag = a.slice('--tag='.length);
    else if (a === '--version') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--version requires a semver value');
      version = v;
    } else if (a.startsWith('--version=')) {
      version = a.slice('--version='.length);
    } else if (a === '--help' || a === '-h') {
      throw new Error('HELP');
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (version !== undefined && !SEMVER.test(version)) {
    throw new Error(`invalid --version ${JSON.stringify(version)} (want X.Y.Z)`);
  }
  if (publish && pack) throw new Error('--pack and --publish are separate jobs: pass one');
  const mode = publish ? '--publish' : pack ? '--pack' : null;
  if (mode && (version !== undefined || dryRun)) {
    // The number comes from the tag and the tree, both already reviewed and merged; a second number
    // on the command line could only disagree with them.
    throw new Error(`${mode} takes no --version and no --dry-run: it releases what is on disk`);
  }
  if (mode && tag === undefined) {
    throw new Error(`${mode} requires --tag vX.Y.Z (the tag the release workflow runs for)`);
  }
  if (!mode && tag !== undefined) throw new Error('--tag only applies with --pack or --publish');
  if (pack !== (out !== undefined)) throw new Error('--pack and --out DIR go together');
  if (!publish && (noProvenance || tarballs !== undefined)) {
    throw new Error('--no-provenance and --tarballs only apply with --publish');
  }
  // `version` is optional-and-absent, not optional-and-undefined: under exactOptionalPropertyTypes
  // those are different types, and the whole point of having no default (above) is that "nobody
  // said" stays distinguishable from a value.
  return {
    dryRun,
    allowDirty,
    publish,
    pack,
    noProvenance,
    ...(version !== undefined ? { version } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(tarballs !== undefined ? { tarballs } : {}),
  };
}

/** The file `pnpm pack` writes for a package: `@musterd/cli` at 0.7.0 → `musterd-cli-0.7.0.tgz`. */
export function tarballFileName(name: PublishPackageName, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/**
 * Refuse a publish whose tag does not name the version on disk (ADR 782).
 *
 * The workflow runs for whatever tag was pushed. A tag on the wrong commit — one before the version
 * bump merged — would otherwise publish the previous version's number again (npm refuses) or, on a
 * tree bumped twice, a number nobody tagged. The tag is the human's statement of what ships; the
 * tree has to agree with it before anything is written.
 */
export function assertTagMatches(tag: string, onDisk: string): void {
  if (tag !== `v${onDisk}`) {
    throw new Error(
      `tag ${tag} does not match the version on disk (${onDisk}) — tag the commit that bumped to ` +
        `${tag.replace(/^v/, '')}, or bump in a PR first (pnpm release --version X)`,
    );
  }
}

/**
 * The `npm publish` argv for one packed tarball (ADR 782).
 *
 * We publish the tarball `pnpm pack` produced, not the package directory: pnpm is what rewrites
 * `workspace:*` (raw npm leaves it in and ships broken installs, ADR 156), and it is the same file
 * the consumer smoke just installed and ran. npm, not pnpm, does the upload because npm's CLI is the
 * one that speaks trusted publishing (OIDC) and signs the provenance statement.
 */
export function npmPublishArgs(tarball: string, provenance: boolean): string[] {
  return [
    'publish',
    tarball,
    '--access',
    'public',
    provenance ? '--provenance' : '--no-provenance',
  ];
}

/** The `X.Y.Z` core of a version, prerelease suffix discarded. */
function core(version: string): [number, number, number] {
  const [x, y, z] = version.split('-')[0]!.split('.').map(Number);
  return [x!, y!, z!];
}

/**
 * Refuse a target version that cannot be a real release, offline and before anything publishes.
 *
 * Two mistakes, and npm only protects against one of them:
 *
 * - **Same version** — the "forgot to bump" case. npm does reject it, but only when that package's
 *   turn comes; in a five-package lockstep the earlier ones have already published by then, leaving
 *   a half-released version that cannot be completed OR undone.
 * - **Lower version** — npm accepts this happily, because the number is genuinely unpublished. The
 *   result is `latest` moving BACKWARDS onto older code. Nothing but a local check catches it.
 *
 * Prereleases are compared on their core numbers only. Full semver precedence is a rabbit hole this
 * guard does not need: it exists to catch the slips we actually make, not to reimplement the spec.
 */
export function assertPublishable(target: string, current: string): void {
  if (target === current) {
    throw new Error(
      `--version ${target} is already the version in package.json — bump it, or npm will reject ` +
        `this partway through the lockstep and leave a half-published release`,
    );
  }
  const [tx, ty, tz] = core(target);
  const [cx, cy, cz] = core(current);
  const lower = tx < cx || (tx === cx && (ty < cy || (ty === cy && tz < cz)));
  if (lower) {
    throw new Error(
      `--version ${target} is lower than the current ${current}. npm would accept it and move ` +
        `\`latest\` backwards onto older code — nothing but this check refuses it`,
    );
  }
}

export function bumpPackageJson(raw: string, version: string): string {
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * The MCP Registry descriptor (packages/mcp/server.json) names the npm version it describes, twice:
 * the server's own `version` and each package's. The registry verifies the listing against the
 * published package's `mcpName`, so a descriptor left at the previous version lists a release that
 * is not the latest — bumped in lockstep with the package.json files for that reason.
 */
export function bumpServerJson(raw: string, version: string): string {
  const server = JSON.parse(raw) as { version?: string; packages?: { version?: string }[] };
  server.version = version;
  for (const pkg of server.packages ?? []) pkg.version = version;
  return `${JSON.stringify(server, null, 2)}\n`;
}

/**
 * What a human does after `pnpm release --version X` bumped the tree (ADR 782): the bump lands as
 * an ordinary PR, and pushing the tag on its merge commit is what starts the publish.
 */
export function nextStepsAfterBump(version: string): string[] {
  return [
    `git switch -c release/v${version} && git commit -am "release: v${version}"   # + docs/releases/v${version}.md`,
    `gh pr create … && gh pr merge --squash --auto   # the bump lands like any change`,
    `git fetch origin main && git tag v${version} origin/main && git push origin v${version}`,
    `approve the npm-release run in GitHub Actions — it builds, smokes and publishes with provenance`,
  ];
}

export function nextStepsAfterPublish(version: string): string[] {
  return [
    // The official MCP Registry holds metadata only, so it can list a version only once npm has it.
    // The io.musterd/ namespace is verified by a DNS TXT record on musterd.io: a one-time
    // `mcp-publisher login dns --domain musterd.io --private-key <hex>` by whoever holds the key.
    `cd packages/mcp && mcp-publisher publish   # MCP Registry listing of @musterd/mcp ${version}`,
    `pnpm bump-brew-formula --version ${version}   # then push SandRiseStudio/homebrew-musterd`,
    // The npm-install smoke that used to live here now runs BEFORE publishing (release/smoke.ts):
    // as a suggestion it could only ever confirm damage, and 0.4.0 is what that cost. What is left
    // here is the one path the pre-publish gate genuinely cannot exercise — brew resolves a formula
    // and a tap, neither of which exists until the steps above are done.
    `smoke: brew tap SandRiseStudio/musterd && brew install musterd   # after the formula push`,
  ];
}
