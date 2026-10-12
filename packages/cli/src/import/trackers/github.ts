import { execFileSync } from 'node:child_process';
import type { LaneStakes } from '@musterd/protocol';
import { CliError } from '../../errors.js';
import { defaultHttp, getJson, TrackerAuthError, type TrackerHttp } from './http.js';
import type { TrackerIssue, TrackerSource, UpstreamState } from './types.js';

/**
 * `musterd import github` (spec 2026-10-11 §2): the repo's open issues over the REST API, with the
 * token `gh` already holds (else `GITHUB_TOKEN`). Pull requests are left out; a `milestone` is the
 * group; `priority:high` / `priority:low` labels set stakes. Reads only.
 */
type Run = (cmd: string, args: string[]) => string;
const run: Run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const AUTH_FIX = 'run `gh auth login`, or set GITHUB_TOKEN';

export function githubToken(env: NodeJS.ProcessEnv = process.env, exec: Run = run): string {
  try {
    const t = exec('gh', ['auth', 'token']).trim();
    if (t) return t;
  } catch {
    // no gh, or not logged in — the env is the fallback
  }
  const t = env['GITHUB_TOKEN']?.trim();
  if (t) return t;
  throw new TrackerAuthError(`no GitHub token — ${AUTH_FIX}`);
}

export function repoFromRemote(exec: Run = run): string {
  let remote = '';
  try {
    remote = exec('git', ['remote', 'get-url', 'origin']).trim();
  } catch {
    // not a repo, or no origin
  }
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  if (!m) throw new CliError('no GitHub repo — pass owner/repo', 2);
  return `${m[1]!}/${m[2]!}`;
}

interface ApiIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  labels?: ({ name?: string } | string)[];
  milestone?: { number: number; title: string } | null;
  pull_request?: unknown;
}

export function githubSource(opts: {
  repo: string;
  token: string;
  http?: TrackerHttp;
  apiBase?: string;
}): TrackerSource {
  const http = opts.http ?? defaultHttp;
  const api = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const ctx = { tracker: 'GitHub', authFix: AUTH_FIX };
  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'musterd',
  };
  const prefix = `${opts.repo}#`;

  return {
    tracker: 'github',
    label: 'GitHub',
    scope: opts.repo,
    ownsRef: (ref) => ref.startsWith(prefix) && /^\d+$/.test(ref.slice(prefix.length)),
    async open(limit = Infinity) {
      const out: TrackerIssue[] = [];
      let url: string | null = `${api}/repos/${opts.repo}/issues?state=open&per_page=100&page=1`;
      while (url && out.length < limit) {
        const res = await getJson(http, url, { headers }, ctx);
        if (res.json === null)
          throw new CliError(`GitHub has no repo ${opts.repo}, or this token cannot see it`, 1);
        if (!Array.isArray(res.json))
          throw new CliError('GitHub sent an issues page that is not a list', 1);
        for (const i of res.json as ApiIssue[]) {
          if (i.pull_request !== undefined) continue;
          out.push(toIssue(opts.repo, i));
          if (out.length >= limit) break;
        }
        url = nextLink(res.headers.get('link'));
        if (url && new URL(url).origin !== new URL(api).origin)
          throw new CliError('GitHub pointed the next page at another host — stopped', 1);
      }
      return out;
    },
    async state(ref): Promise<UpstreamState> {
      const n = ref.slice(prefix.length);
      const res = await getJson(http, `${api}/repos/${opts.repo}/issues/${n}`, { headers }, ctx);
      if (res.json === null) return 'not_found';
      const j = res.json as { state?: string; repository_url?: string };
      // A transferred issue redirects to its new repo — not this repo's issue any more, so it is
      // gone from here, not closed (review focus 3).
      if (!j.repository_url?.endsWith(`/repos/${opts.repo}`)) return 'not_found';
      return j.state === 'closed' ? 'closed' : 'open';
    },
  };
}

function toIssue(repo: string, i: ApiIssue): TrackerIssue {
  const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')).toLowerCase());
  const stakes: LaneStakes | undefined = labels.includes('priority:high')
    ? 'high'
    : labels.includes('priority:low')
      ? 'low'
      : undefined;
  return {
    ref: `${repo}#${String(i.number)}`,
    title: i.title,
    url: i.html_url,
    ...(i.body ? { body: i.body } : {}),
    ...(i.milestone
      ? { group: { key: String(i.milestone.number), title: i.milestone.title } }
      : {}),
    ...(stakes ? { stakes } : {}),
  };
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}
