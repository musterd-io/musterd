import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliError } from '../../errors.js';
import type { TrackerHttp } from './http.js';
import { jiraAuth, jiraSource, type JiraAuth } from './jira.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Answer = { status?: number; body: string };
async function fakeJira(
  answer: (url: URL, headers: IncomingHttpHeaders) => Answer,
): Promise<string> {
  server = createServer((req, res) => {
    const a = answer(new URL(req.url ?? '/', 'http://x'), req.headers);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
    res.end(a.body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/jira`;
}

const http: TrackerHttp = { fetch, sleep: async () => {} };
const anon: JiraAuth = { kind: 'anonymous' };
const JQL = 'project = "CLI" AND statusCategory != Done ORDER BY key';

describe('jiraSource.open', () => {
  it('v2 (Server/Data Center) pages by startAt; Epic parent, else fix version, is the group', async () => {
    const seen: string[] = [];
    const site = await fakeJira((url, headers) => {
      expect(headers.authorization).toBeUndefined();
      expect(url.pathname).toBe('/jira/rest/api/2/search');
      expect(url.searchParams.get('jql')).toBe(JQL);
      seen.push(url.searchParams.get('startAt')!);
      return {
        body: fixture(
          url.searchParams.get('startAt') === '0' ? 'jira-v2-p1.json' : 'jira-v2-p2.json',
        ),
      };
    });
    const issues = await jiraSource({ site, project: 'CLI', auth: anon, http }).open();
    expect(seen).toEqual(['0', '2']);
    expect(issues.map((i) => [i.ref, i.group?.title ?? null, i.stakes ?? null])).toEqual([
      ['CLI-77', '1.10.0', 'high'],
      ['CLI-81', 'Help formatter rework', 'low'],
      ['CLI-82', null, null],
    ]);
    expect(issues[0]).toMatchObject({
      url: `${site}/browse/CLI-77`,
      group: { key: 'fv-12345', title: '1.10.0' },
    });
    expect(issues[0]!.body).toMatch(/^If the same group/);
    expect(issues[1]!.group).toEqual({ key: 'CLI-300', title: 'Help formatter rework' });
  });

  it('v3 (Cloud) pages by nextPageToken and leaves the ADF body out', async () => {
    const seen: (string | null)[] = [];
    const site = await fakeJira((url) => {
      expect(url.pathname).toBe('/jira/rest/api/3/search/jql');
      seen.push(url.searchParams.get('nextPageToken'));
      return {
        body: fixture(
          url.searchParams.get('nextPageToken') ? 'jira-v3-p2.json' : 'jira-v3-p1.json',
        ),
      };
    });
    const issues = await jiraSource({
      site,
      project: 'CLI',
      auth: anon,
      http,
      apiVersion: 3,
    }).open();
    expect(seen).toEqual([null, 'tok-2']);
    expect(issues.map((i) => i.ref)).toEqual(['CLI-77', 'CLI-81', 'CLI-82']);
    expect(issues.every((i) => i.body === undefined)).toBe(true);
  });

  it('picks v3 for an atlassian.net site and v2 elsewhere', () => {
    expect(
      jiraSource({ site: 'https://acme.atlassian.net', project: 'P', auth: anon }).apiVersion,
    ).toBe(3);
    expect(
      jiraSource({ site: 'https://issues.apache.org/jira', project: 'P', auth: anon }).apiVersion,
    ).toBe(2);
  });

  it('sends basic or bearer auth; a 401 exits 2 naming the variables, never the secret', async () => {
    const got: (string | undefined)[] = [];
    const site = await fakeJira((_url, headers) => {
      got.push(headers.authorization);
      return { status: 401, body: '{}' };
    });
    const basic: JiraAuth = { kind: 'basic', email: 'a@b.c', token: 'SECRET1' };
    const err = (await jiraSource({ site, project: 'CLI', auth: basic, http })
      .open()
      .catch((e: unknown) => e)) as CliError;
    await jiraSource({ site, project: 'CLI', auth: { kind: 'bearer', token: 'SECRET2' }, http })
      .open()
      .catch(() => undefined);
    expect(got).toEqual([
      `Basic ${Buffer.from('a@b.c:SECRET1').toString('base64')}`,
      'Bearer SECRET2',
    ]);
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_PAT/);
    expect(err.message).not.toContain('SECRET');
  });

  it('a project the site does not show is a plain error, not an empty board', async () => {
    const site = await fakeJira(() => ({
      status: 400,
      body: JSON.stringify({
        errorMessages: ["The value 'NOPE' does not exist for the field 'project'."],
      }),
    }));
    await expect(jiraSource({ site, project: 'NOPE', auth: anon, http }).open()).rejects.toThrow(
      /Jira: The value 'NOPE' does not exist/,
    );
  });
});

describe('jiraSource.state', () => {
  it('done is closed, 404 is not_found, a moved issue is not_found', async () => {
    const site = await fakeJira((url) => {
      const key = url.pathname.split('/').pop();
      const one = (k: string, cat: string) =>
        JSON.stringify({ key: k, fields: { status: { statusCategory: { key: cat } } } });
      if (key === 'CLI-1') return { body: one('CLI-1', 'done') };
      if (key === 'CLI-2') return { body: one('CLI-2', 'indeterminate') };
      if (key === 'CLI-3') return { body: one('OTHER-9', 'new') };
      return { status: 404, body: '{"errorMessages":["Issue Does Not Exist"]}' };
    });
    const s = jiraSource({ site, project: 'CLI', auth: anon, http });
    expect(await s.state('CLI-1')).toBe('closed');
    expect(await s.state('CLI-2')).toBe('open');
    expect(await s.state('CLI-3')).toBe('not_found');
    expect(await s.state('CLI-4')).toBe('not_found');
    expect(s.ownsRef('CLI-4')).toBe(true);
    expect(s.ownsRef('CLIX-4')).toBe(false);
  });
});

describe('jiraAuth — credentials go only where they belong', () => {
  const cloud = 'https://acme.atlassian.net';
  it('a Cloud token goes to *.atlassian.net over https, and nowhere else', () => {
    const env = { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' };
    expect(jiraAuth(cloud, env)).toEqual({ auth: { kind: 'basic', email: 'a@b.c', token: 't' } });
    const elsewhere = jiraAuth('https://evil.example/jira', env);
    expect(elsewhere.auth).toEqual({ kind: 'anonymous' });
    expect(elsewhere.withheld).toMatch(
      /JIRA_API_TOKEN is an Atlassian Cloud token — sent only to \*\.atlassian\.net/,
    );
    expect(jiraAuth('http://acme.atlassian.net', env).auth).toEqual({ kind: 'anonymous' });
  });

  it('a PAT goes only to the host JIRA_SITE names', () => {
    expect(jiraAuth('https://jira.acme.io', { JIRA_PAT: 'p', JIRA_SITE: 'jira.acme.io' })).toEqual({
      auth: { kind: 'bearer', token: 'p' },
    });
    expect(
      jiraAuth('https://jira.acme.io/', { JIRA_PAT: 'p', JIRA_SITE: 'https://jira.acme.io/jira' })
        .auth.kind,
    ).toBe('bearer');
    const other = jiraAuth('https://evil.example', { JIRA_PAT: 'p', JIRA_SITE: 'jira.acme.io' });
    expect(other.auth).toEqual({ kind: 'anonymous' });
    expect(other.withheld).toMatch(
      /JIRA_PAT is sent only to the host in JIRA_SITE \(jira\.acme\.io\)/,
    );
    expect(jiraAuth('https://jira.acme.io', { JIRA_PAT: 'p' }).withheld).toMatch(
      /set JIRA_SITE=jira\.acme\.io/,
    );
  });

  it('loopback may be plain http (tests, a local Jira); nothing set is anonymous', () => {
    expect(
      jiraAuth('http://127.0.0.1:9/jira', { JIRA_PAT: 'p', JIRA_SITE: '127.0.0.1' }).auth.kind,
    ).toBe('bearer');
    expect(jiraAuth(cloud, {})).toEqual({ auth: { kind: 'anonymous' } });
  });

  it('a 401 after credentials were withheld says why', async () => {
    const site = await fakeJira(() => ({ status: 401, body: '{}' }));
    const err = (await jiraSource({
      site,
      project: 'CLI',
      auth: anon,
      withheld: 'JIRA_PAT is sent only to the host in JIRA_SITE (jira.acme.io)',
      http,
    })
      .open()
      .catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/JIRA_PAT is sent only to the host in JIRA_SITE/);
  });
});

describe('issue keys are checked', () => {
  it('a key that is not <PROJECT>-<n> stops the fetch', async () => {
    const site = await fakeJira(() => ({
      body: JSON.stringify({
        startAt: 0,
        total: 1,
        issues: [{ key: 'CLI-1\u001b]0;x\u0007', fields: { summary: 's' } }],
      }),
    }));
    await expect(jiraSource({ site, project: 'CLI', auth: anon, http }).open()).rejects.toThrow(
      /Jira sent an issue key that is not CLI-<number>/,
    );
  });
});
