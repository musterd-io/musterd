import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findStaleDists,
  findStaleInstall,
  renderStaleBanner,
  renderStaleInstallBanner,
} from './check-dist-freshness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

type Pkg = {
  /** src files, name → mtime (ms since epoch) */
  src?: Record<string, number>;
  /** dist/build.json contents; omit for a package that was never built */
  stamp?: { ref: string | null; builtAt: string };
  /** false = a package whose build script does not stamp (web/vite) */
  stamps?: boolean;
};

/** A miniature workspace: packages/<name>/{package.json, src/*.ts, dist/build.json}. */
function workspace(pkgs: Record<string, Pkg>): string {
  const root = mkdtempSync(join(tmpdir(), 'dist-freshness-'));
  dirs.push(root);
  for (const [name, p] of Object.entries(pkgs)) {
    const dir = join(root, 'packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const build =
      p.stamps === false
        ? 'vite build'
        : 'tsc -p tsconfig.json && node ../../scripts/stamp-build.mjs';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts: { build } }));
    for (const [file, mtimeMs] of Object.entries(p.src ?? { 'index.ts': 1000 })) {
      const f = join(dir, 'src', file);
      writeFileSync(f, 'export const x = 1;\n');
      utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
    }
    if (p.stamp) {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'build.json'), JSON.stringify(p.stamp) + '\n');
    }
  }
  return root;
}

const fresh = { ref: HEAD, builtAt: new Date(5000).toISOString() };
/** No src changed between the dist's ref and HEAD. */
const noSrcChanged = () => [];

describe('findStaleDists', () => {
  it('says nothing about a tree whose dist is newer than its src and built from HEAD', () => {
    const root = workspace({ protocol: { src: { 'index.ts': 1000 }, stamp: fresh } });
    expect(findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged })).toEqual([]);
  });

  it('reports a package that was never built', () => {
    const root = workspace({ protocol: { src: { 'index.ts': 1000 } } });
    const stale = findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ pkg: 'protocol', reason: 'never-built' });
  });

  it('reports a src file edited after the dist was built, and names that file', () => {
    const root = workspace({
      protocol: { src: { 'index.ts': 1000, 'credentials.ts': 9000 }, stamp: fresh },
    });
    const stale = findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ pkg: 'protocol', reason: 'src-newer' });
    expect(stale[0]?.evidence).toContain('credentials.ts');
  });

  it('reports a dist built from an older ref when src changed since — the ref-switch case', () => {
    const root = workspace({
      protocol: { src: { 'index.ts': 1000 }, stamp: { ref: OLDER, builtAt: fresh.builtAt } },
    });
    const stale = findStaleDists(root, {
      head: HEAD,
      changedSrc: () => ['packages/protocol/src/credentials.ts'],
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ pkg: 'protocol', reason: 'ref-behind' });
    expect(stale[0]?.evidence).toContain('credentials.ts');
  });

  it('stays quiet when the dist is behind HEAD but nothing under that src changed', () => {
    const root = workspace({
      protocol: { src: { 'index.ts': 1000 }, stamp: { ref: OLDER, builtAt: fresh.builtAt } },
    });
    expect(findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged })).toEqual([]);
  });

  it('ignores a package whose build script does not stamp (vite-built web)', () => {
    const root = workspace({ web: { src: { 'main.ts': 9000 }, stamps: false } });
    expect(findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged })).toEqual([]);
  });

  it('treats a -dirty stamp as its underlying ref rather than a mismatch', () => {
    const root = workspace({
      protocol: {
        src: { 'index.ts': 1000 },
        stamp: { ref: `${HEAD}-dirty`, builtAt: fresh.builtAt },
      },
    });
    expect(findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged })).toEqual([]);
  });

  it('says nothing when the stamp has no ref at all (published tarball, no git)', () => {
    const root = workspace({
      protocol: { src: { 'index.ts': 1000 }, stamp: { ref: null, builtAt: fresh.builtAt } },
    });
    expect(findStaleDists(root, { head: HEAD, changedSrc: noSrcChanged })).toEqual([]);
  });
});

describe('renderStaleBanner', () => {
  it('names the package, the rebuild, and warns off blaming a file nobody touched', () => {
    const out = renderStaleBanner([
      {
        pkg: 'protocol',
        reason: 'src-newer',
        builtFrom: OLDER,
        builtAt: fresh.builtAt,
        evidence: 'src/credentials.ts',
      },
    ]);
    expect(out).toContain('@musterd/protocol');
    expect(out).toContain('src/credentials.ts');
    expect(out).toContain('pnpm -r build');
    expect(out).toContain('running-the-gates.md');
    expect(out.toLowerCase()).toContain('a file you never touched');
  });
});

describe('findStaleInstall: node_modules older than pnpm-lock.yaml', () => {
  const lock = (...pkgs: string[]) =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  packages/mobile:\n    dependencies: {}\n\npackages:\n\n${pkgs.map((p) => `  ${p}:\n    resolution: {integrity: x}\n`).join('\n')}`;
  function root(wanted: string, installed?: string): string {
    const r = mkdtempSync(join(tmpdir(), 'install-freshness-'));
    dirs.push(r);
    writeFileSync(join(r, 'pnpm-lock.yaml'), wanted);
    if (installed !== undefined) {
      mkdirSync(join(r, 'node_modules', '.pnpm'), { recursive: true });
      writeFileSync(join(r, 'node_modules', '.pnpm', 'lock.yaml'), installed);
    }
    return r;
  }

  it('is quiet when the install resolved the same packages, formatting aside', () => {
    const wanted = lock('expo@58.0.23', "'@expo/cli@58.1.19'");
    expect(findStaleInstall(root(wanted, wanted.replace(/\n\n/g, '\n')))).toBeNull();
  });

  it('names what a dependency bump added and dropped (the 2026-11-05 Expo case)', () => {
    const r = root(
      lock('expo@58.0.23', 'react-native@0.88.1'),
      lock('expo@58.0.17', 'react-native@0.88.1'),
    );
    expect(findStaleInstall(r)).toEqual({ missing: ['expo@58.0.23'], extra: ['expo@58.0.17'] });
    expect(renderStaleInstallBanner(findStaleInstall(r)!)).toContain('pnpm install');
  });

  it('degrades to silence with no install at all', () => {
    expect(findStaleInstall(root(lock('expo@58.0.23')))).toBeNull();
  });
});
