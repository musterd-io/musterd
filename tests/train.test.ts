import { describe, expect, it } from 'vitest';
import {
  groupByGoal,
  isInvisiblePath,
  parseSubject,
  renderNotes,
  userVisible,
} from '../scripts/train/notes.ts';
import {
  type FetchJson,
  type FetchText,
  type Git,
  PACKAGES,
  checkBrew,
  checkGithubRelease,
  checkNpm,
  checkRegistry,
  checkSite,
  checkTag,
  renderStatus,
} from '../scripts/train/status.ts';

const json =
  (routes: Record<string, { status: number; json: unknown } | null>): FetchJson =>
  async (url) =>
    Object.entries(routes).find(([k]) => url.includes(k))?.[1] ?? { status: 404, json: null };

describe('train status (ADR 669 §3.1)', () => {
  it('npm is green only when every lockstep package is at the version', async () => {
    const at = (v: string) => ({ status: 200, json: { 'dist-tags': { latest: v } } });
    const all = Object.fromEntries(PACKAGES.map((p) => [p.replace('/', '%2F'), at('0.6.0')]));
    expect((await checkNpm(json(all), '0.6.0')).verdict).toBe('ok');
    const oneBehind = { ...all, '%40musterd%2Fmcp': at('0.5.0'), '@musterd%2Fmcp': at('0.5.0') };
    const r = await checkNpm(json(oneBehind), '0.6.0');
    expect(r.verdict).toBe('missing');
    expect(r.detail).toContain('@musterd/mcp@0.5.0');
  });

  it('a surface it cannot reach is unknown — never folded into missing or ok', async () => {
    const down: FetchJson = async () => null;
    expect((await checkNpm(down, '0.6.0')).verdict).toBe('unknown');
    expect((await checkRegistry(down, '0.6.0')).verdict).toBe('unknown');
    expect((await checkGithubRelease(down, '0.6.0')).verdict).toBe('unknown');
    expect(checkTag(() => null, '0.6.0').verdict).toBe('unknown');
  });

  it('a GitHub Release with an empty body is not done — the notes are the point (D5)', async () => {
    const r = await checkGithubRelease(
      json({ 'releases/tags': { status: 200, json: { body: '' } } }),
      '0.6.0',
    );
    expect(r.verdict).toBe('missing');
  });

  it('the registry entry must be ours and at the version', async () => {
    const listed = (version: string) =>
      json({
        'v0/servers': {
          status: 200,
          json: { servers: [{ server: { name: 'io.musterd/musterd', version } }] },
        },
      });
    expect((await checkRegistry(listed('0.6.0'), '0.6.0')).verdict).toBe('ok');
    expect((await checkRegistry(listed('0.5.1'), '0.6.0')).verdict).toBe('missing');
  });

  it('brew reads the version from the formula tarball url', async () => {
    const formula =
      (v: string): FetchText =>
      async () => ({
        status: 200,
        text: `url "https://registry.npmjs.org/@musterd/cli/-/cli-${v}.tgz"`,
      });
    expect((await checkBrew(formula('0.6.0'), '0.6.0')).verdict).toBe('ok');
    expect((await checkBrew(formula('0.5.0'), '0.6.0')).detail).toBe('tap formula at 0.5.0');
  });

  it('the site carries the version when the tag commit is an ancestor of its -dirty build ref', async () => {
    const stamp = json({ 'build.json': { status: 200, json: { ref: 'abc123-dirty' } } });
    const git =
      (ancestor: boolean): Git =>
      (...args) =>
        args[0] === 'rev-list' ? 'tagsha\n' : args[0] === 'cat-file' ? '' : ancestor ? '' : null;
    expect((await checkSite(stamp, git(true), '0.6.0')).verdict).toBe('ok');
    expect((await checkSite(stamp, git(false), '0.6.0')).verdict).toBe('missing');
    const unfetched: Git = (...args) => (args[0] === 'rev-list' ? 'tagsha\n' : null);
    expect((await checkSite(stamp, unfetched, '0.6.0')).verdict).toBe('unknown');
  });

  it('renders one line per car and a summary', () => {
    const out = renderStatus('0.6.0', [
      { car: 'npm', verdict: 'ok', detail: 'all 5 packages at 0.6.0' },
      { car: 'MCP Registry', verdict: 'missing', detail: 'not listed' },
      { car: 'site', verdict: 'unknown', detail: 'no build stamp' },
    ]);
    expect(out.split('\n')[0]).toBe('train v0.6.0 — 1 car not there yet');
    expect(out).toContain('✓ npm');
    expect(out).toContain('✗ MCP Registry');
    expect(out).toContain('? site');
  });
});

describe('train notes (ADR 669 D5)', () => {
  it('parses the squash subject into title, PR and lane', () => {
    expect(parseSubject('One install block (lane 01M5AXB5NZ, ADR 669) (#2939)')).toEqual({
      title: 'One install block (lane 01M5AXB5NZ, ADR 669)',
      pr: 2939,
      lane: '01M5AXB5NZ',
    });
    expect(parseSubject('office: nameplates lift (lane 01M5AVZA7C) (#2935)')).toEqual({
      title: 'office: nameplates lift',
      pr: 2935,
      lane: '01M5AVZA7C',
    });
  });

  it('leaves out commits a user cannot notice: docs, tests, CI', () => {
    expect(isInvisiblePath('docs/decisions/669-the-release-train.md')).toBe(true);
    expect(isInvisiblePath('packages/web/src/live/modelBadge.test.ts')).toBe(true);
    expect(isInvisiblePath('packages/web/src/live/modelBadge.ts')).toBe(false);
    expect(userVisible({ sha: 'a', subject: 's', files: ['docs/x.md', 'README.md'] })).toBe(false);
    expect(
      userVisible({ sha: 'b', subject: 's', files: ['docs/x.md', 'packages/cli/src/a.ts'] }),
    ).toBe(true);
  });

  it('groups by goal, with the unknown ones last under "other"', () => {
    const groups = groupByGoal(
      [
        { title: 'a', pr: 1, lane: 'L1' },
        { title: 'b', pr: 2, lane: null },
        { title: 'c', pr: 3, lane: 'L2' },
      ],
      (lane) => (lane === 'L1' ? 'live-delight' : null),
    );
    const md = renderNotes('0.6.0', 'v0.5.0..HEAD', groups, 4);
    expect(md.indexOf('### live-delight')).toBeLessThan(md.indexOf('### other'));
    expect(md).toContain('- a ([#1](https://github.com/musterd-io/musterd/pull/1))');
    expect(md).toContain('4 docs/test/CI-only commits left out');
    expect(md).toContain('npm install -g @musterd/cli@0.6.0');
  });
});
