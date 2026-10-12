import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliError } from '../../errors.js';
import { githubSource, githubToken, repoFromRemote } from './github.js';
import type { TrackerHttp } from './http.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Route = (path: string, auth: string | undefined) => { status: number; body: string; link?: string };

async function fakeGitHub(route: Route): Promise<string> {
  server = createServer((req, res) => {
    const r = route(req.url ?? '', req.headers.authorization);
    res.writeHead(r.status, {
      'content-type': 'application/json',
      ...(r.link ? { link: r.link.replace('BASE', base) } : {}),
    });
    res.end(r.body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return base;
}

const http: TrackerHttp = { fetch, sleep: async () => {} };
const src = (apiBase: string) => githubSource({ repo: 'acme/app', token: 'tok', http, apiBase });

describe('githubSource.open', () => {
  it('follows Link rel="next", skips pull requests, maps milestone and priority labels', async () => {
    const base = await fakeGitHub((path, auth) => {
      expect(auth).toBe('Bearer tok');
      if (path.startsWith('/repos/acme/app/issues?state=open&per_page=100&page=1'))
        return {
          status: 200,
          body: fixture('github-issues-p1.json'),
          link: '<BASE/repos/acme/app/issues?state=open&per_page=100&page=2>; rel="next", <BASE/x>; rel="last"',
        };
      if (path.endsWith('page=2')) return { status: 200, body: fixture('github-issues-p2.json') };
      return { status: 500, body: '{}' };
    });
    const issues = await src(base).open();
    expect(issues.map((i) => i.ref)).toEqual(['acme/app#12', 'acme/app#15', 'acme/app#16']);
    expect(issues[0]).toEqual({
      ref: 'acme/app#12',
      title: 'Login fails on Safari',
      url: 'https://github.com/acme/app/issues/12',
      body: 'Steps: open the login page in Safari 18.',
      group: { key: '3', title: 'v1.0 — First release' },
      stakes: 'high',
    });
    expect(issues[1]!.stakes).toBe('low');
    expect(issues[2]).not.toHaveProperty('group');
  });

  it('stops at the limit', async () => {
    const base = await fakeGitHub(() => ({
      status: 200,
      body: fixture('github-issues-p1.json'),
      link: '<BASE/repos/acme/app/issues?page=2>; rel="next"',
    }));
    expect((await src(base).open(1)).map((i) => i.ref)).toEqual(['acme/app#12']);
  });

  it('never follows a next link to another host (the token would go with it)', async () => {
    const base = await fakeGitHub(() => ({
      status: 200,
      body: fixture('github-issues-p1.json'),
      link: '<https://evil.example/steal?page=2>; rel="next"',
    }));
    await expect(src(base).open()).rejects.toThrow(/GitHub pointed the next page at another host/);
  });

  it('an empty open set is an empty list, not an error', async () => {
    const base = await fakeGitHub(() => ({ status: 200, body: '[]' }));
    expect(await src(base).open()).toEqual([]);
  });

  it('a missing repo says which one', async () => {
    const base = await fakeGitHub(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    await expect(src(base).open()).rejects.toThrow(
      /GitHub has no repo acme\/app, or this token cannot see it/,
    );
  });
});

describe('githubSource.state', () => {
  it('closed, open, not_found, and a transferred issue reads as not_found', async () => {
    const base = await fakeGitHub((path) => {
      const one = (state: string, repo = 'acme/app') => ({
        status: 200,
        body: JSON.stringify({
          state,
          repository_url: `https://api.github.com/repos/${repo}`,
        }),
      });
      if (path === '/repos/acme/app/issues/1') return one('closed');
      if (path === '/repos/acme/app/issues/2') return one('open');
      if (path === '/repos/acme/app/issues/3') return { status: 404, body: '{}' };
      if (path === '/repos/acme/app/issues/4') return one('open', 'acme/other');
      return { status: 410, body: '{}' };
    });
    const s = src(base);
    expect(await s.state('acme/app#1')).toBe('closed');
    expect(await s.state('acme/app#2')).toBe('open');
    expect(await s.state('acme/app#3')).toBe('not_found');
    expect(await s.state('acme/app#4')).toBe('not_found');
    expect(await s.state('acme/app#5')).toBe('not_found');
  });

  it('owns only this repo’s refs', () => {
    const s = githubSource({ repo: 'acme/app', token: 't' });
    expect(s.ownsRef('acme/app#9')).toBe(true);
    expect(s.ownsRef('acme/app-two#9')).toBe(false);
    expect(s.ownsRef('ENG-9')).toBe(false);
  });
});

describe('githubToken', () => {
  it('prefers gh, falls back to GITHUB_TOKEN, else exit 2 with the fix', () => {
    expect(githubToken({}, () => 'gho_abc\n')).toBe('gho_abc');
    const fail = () => {
      throw new Error('gh: not logged in');
    };
    expect(githubToken({ GITHUB_TOKEN: 'env_tok' }, fail)).toBe('env_tok');
    expect(githubToken({ GITHUB_TOKEN: 'env_tok' }, () => '  \n')).toBe('env_tok');
    let err: CliError | undefined;
    try {
      githubToken({}, fail);
    } catch (e) {
      err = e as CliError;
    }
    expect(err?.exitCode).toBe(2);
    expect(err?.message).toBe('no GitHub token — run `gh auth login`, or set GITHUB_TOKEN');
  });
});

describe('repoFromRemote', () => {
  it('reads owner/repo from an ssh or https origin', () => {
    expect(repoFromRemote(() => 'git@github.com:acme/app.git\n')).toBe('acme/app');
    expect(repoFromRemote(() => 'https://github.com/acme/app\n')).toBe('acme/app');
    expect(repoFromRemote(() => 'ssh://git@github.com/acme/app.git')).toBe('acme/app');
  });
  it('anything else asks for owner/repo', () => {
    expect(() => repoFromRemote(() => 'https://gitlab.com/acme/app.git')).toThrow(
      /no GitHub repo — pass owner\/repo/,
    );
    expect(() =>
      repoFromRemote(() => {
        throw new Error('not a git repository');
      }),
    ).toThrow(/no GitHub repo/);
  });
});
