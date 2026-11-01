import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_DIRS,
  assertPublishable,
  assertTagMatches,
  PUBLISH_ORDER,
  bumpPackageJson,
  bumpServerJson,
  nextStepsAfterBump,
  nextStepsAfterPublish,
  npmPublishArgs,
  parseReleaseArgs,
  tarballFileName,
} from '../scripts/release/helpers.ts';

describe('release helpers (ADR 156)', () => {
  it('publishes in protocol → telemetry → server → mcp → cli order', () => {
    expect([...PUBLISH_ORDER]).toEqual([
      '@musterd/protocol',
      '@musterd/telemetry',
      '@musterd/server',
      '@musterd/mcp',
      '@musterd/cli',
    ]);
    for (const name of PUBLISH_ORDER) {
      expect(PACKAGE_DIRS[name]).toBeTruthy();
    }
  });

  it('parseReleaseArgs has NO default version — a published number is never a default', () => {
    // It used to default to '0.3.0', frozen in source. That number went stale the moment 0.3.0
    // shipped, and a default here is wrong in principle regardless: the version is the one
    // irreversible decision in a release, so it has to be typed by whoever is making it.
    expect(parseReleaseArgs([]).version).toBeUndefined();
    expect(parseReleaseArgs(['--dry-run']).version).toBeUndefined();
  });

  it('parseReleaseArgs flags', () => {
    expect(parseReleaseArgs(['--dry-run', '--allow-dirty', '--version', '0.3.1'])).toEqual({
      dryRun: true,
      allowDirty: true,
      publish: false,
      pack: false,
      noProvenance: false,
      version: '0.3.1',
    });
    expect(parseReleaseArgs(['--version=1.0.0']).version).toBe('1.0.0');
  });

  it('rejects bad version and unknown args', () => {
    expect(() => parseReleaseArgs(['--version', 'v0.3'])).toThrow(/invalid/);
    expect(() => parseReleaseArgs(['--nope'])).toThrow(/unknown/);
  });

  describe('assertPublishable — the offline guard on which number gets burned', () => {
    it('accepts a genuine bump', () => {
      expect(() => assertPublishable('0.4.2', '0.4.1')).not.toThrow();
      expect(() => assertPublishable('0.5.0', '0.4.1')).not.toThrow();
      expect(() => assertPublishable('1.0.0', '0.9.9')).not.toThrow();
    });

    it('refuses re-publishing the version already in package.json', () => {
      // The "forgot to bump" mistake. npm would reject it too, but only AFTER the earlier packages
      // in the lockstep order have already published — leaving a half-released version.
      expect(() => assertPublishable('0.4.1', '0.4.1')).toThrow(/already/i);
    });

    it('refuses going backwards, which npm would happily accept', () => {
      // This one the registry does NOT protect against: 0.3.2 is unpublished, so npm takes it and
      // `latest` moves BACKWARDS onto older code. Offline check or nothing.
      expect(() => assertPublishable('0.3.2', '0.4.1')).toThrow(/lower/i);
    });

    it('compares numerically, not as strings', () => {
      // '0.10.0' < '0.9.0' lexically. A string compare here would block a legitimate release.
      expect(() => assertPublishable('0.10.0', '0.9.0')).not.toThrow();
      expect(() => assertPublishable('0.9.0', '0.10.0')).toThrow(/lower/i);
    });

    it('lets a prerelease through rather than guessing at its ordering', () => {
      // Full semver precedence is a rabbit hole this guard does not need to enter; the core-number
      // comparison is what catches the mistakes we actually make.
      expect(() => assertPublishable('0.5.0-rc.1', '0.4.1')).not.toThrow();
    });
  });

  describe('the CI publish (ADR 782)', () => {
    it('--publish needs the tag, and takes no version of its own', () => {
      expect(parseReleaseArgs(['--publish', '--tag', 'v0.7.0'])).toMatchObject({
        publish: true,
        tag: 'v0.7.0',
        noProvenance: false,
      });
      expect(parseReleaseArgs(['--publish', '--tag=v0.7.0', '--no-provenance']).noProvenance).toBe(
        true,
      );
      expect(() => parseReleaseArgs(['--publish'])).toThrow(/--tag/);
      // The number comes from the tag and the merged tree; a second one could only disagree.
      expect(() =>
        parseReleaseArgs(['--publish', '--tag', 'v0.7.0', '--version', '0.7.0']),
      ).toThrow(/no --version/);
      expect(() => parseReleaseArgs(['--publish', '--tag', 'v0.7.0', '--dry-run'])).toThrow();
      expect(() => parseReleaseArgs(['--tag', 'v0.7.0'])).toThrow(/only applies with/);
      expect(() => parseReleaseArgs(['--no-provenance'])).toThrow(/only apply with --publish/);
      expect(parseReleaseArgs(['--publish', '--tag', 'v0.7.0', '--tarballs', '/t']).tarballs).toBe(
        '/t',
      );
    });

    it('--pack needs --tag and --out, and is never the same run as --publish', () => {
      expect(parseReleaseArgs(['--pack', '--tag', 'v0.7.0', '--out', '/t'])).toMatchObject({
        pack: true,
        out: '/t',
        tag: 'v0.7.0',
      });
      expect(() => parseReleaseArgs(['--pack', '--tag', 'v0.7.0'])).toThrow(/--out/);
      expect(() => parseReleaseArgs(['--pack', '--out', '/t'])).toThrow(/--tag/);
      expect(() =>
        parseReleaseArgs(['--pack', '--publish', '--tag', 'v0.7.0', '--out', '/t']),
      ).toThrow(/separate jobs/);
      expect(() =>
        parseReleaseArgs(['--pack', '--tag', 'v0.7.0', '--out', '/t', '--tarballs', '/x']),
      ).toThrow();
    });

    it('names tarballs as pnpm pack does', () => {
      expect(tarballFileName('@musterd/cli', '0.7.0')).toBe('musterd-cli-0.7.0.tgz');
    });

    it('refuses a tag that does not name the version on disk', () => {
      expect(() => assertTagMatches('v0.7.0', '0.7.0')).not.toThrow();
      // Tagged the commit before the bump merged.
      expect(() => assertTagMatches('v0.7.0', '0.6.0')).toThrow(/does not match/);
      expect(() => assertTagMatches('0.7.0', '0.7.0')).toThrow(/does not match/);
    });

    it('publishes the packed tarball with npm, provenance on unless said otherwise', () => {
      expect(npmPublishArgs('/t/cli.tgz', true)).toEqual([
        'publish',
        '/t/cli.tgz',
        '--access',
        'public',
        '--provenance',
      ]);
      expect(npmPublishArgs('/t/cli.tgz', false)).toContain('--no-provenance');
    });

    it('after a bump, the next steps land it as a PR and the tag starts the publish', () => {
      const steps = nextStepsAfterBump('0.7.0').join('\n');
      expect(steps).toContain('git push origin v0.7.0');
      expect(steps).toContain('npm-release');
      expect(steps).not.toMatch(/pnpm publish|npm publish/);
    });

    it('the release workflow: only the publish job can mint a token, and it installs nothing', () => {
      const wf = readFileSync('.github/workflows/release.yml', 'utf8');
      const pack = wf.slice(wf.indexOf('\n  pack:'), wf.indexOf('\n  publish:'));
      const publish = wf.slice(wf.indexOf('\n  publish:'));
      // The smoke runs third-party install scripts; nothing in that job may ask for OIDC.
      expect(pack).not.toContain('id-token');
      expect(pack).toContain('--pack --tag "$GITHUB_REF_NAME"');
      expect(publish).toContain('id-token: write');
      expect(publish).toContain('environment: npm-release');
      expect(publish).toContain('--publish --tag "$GITHUB_REF_NAME" --tarballs');
      expect(publish).not.toMatch(/pnpm install|\.\/\.github\/actions\/setup/);
      // No long-lived npm token anywhere in the release path.
      expect(wf).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    });
  });

  it('bumpPackageJson rewrites version only', () => {
    const next = bumpPackageJson(
      JSON.stringify({ name: '@musterd/cli', version: '0.2.0', private: false }, null, 2),
      '0.3.0',
    );
    expect(JSON.parse(next)).toMatchObject({ name: '@musterd/cli', version: '0.3.0' });
  });

  it('nextStepsAfterPublish mentions the MCP Registry and brew', () => {
    const steps = nextStepsAfterPublish('0.3.0').join('\n');
    expect(steps).toContain('mcp-publisher publish');
    expect(steps).toContain('bump-brew-formula');
    expect(steps).toContain('SandRiseStudio/musterd');
  });

  it('bumpServerJson moves the descriptor and every package it lists to the new version', () => {
    const raw = JSON.stringify({ name: 'x/y', version: '0.1.0', packages: [{ version: '0.1.0' }] });
    const out = JSON.parse(bumpServerJson(raw, '0.6.0'));
    expect(out.version).toBe('0.6.0');
    expect(out.packages[0].version).toBe('0.6.0');
  });

  // The registry verifies a listing against the npm package's `mcpName` (lane 01M5AQGV8Y): the
  // descriptor's name, package and version must be the package's own, or the publish is refused.
  it('server.json describes @musterd/mcp exactly as its package.json does', () => {
    const pkg = JSON.parse(readFileSync('packages/mcp/package.json', 'utf8'));
    const server = JSON.parse(readFileSync('packages/mcp/server.json', 'utf8'));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: pkg.version }),
    ]);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
