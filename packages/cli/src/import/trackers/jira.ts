import type { LaneStakes } from '@musterd/protocol';
import { CliError } from '../../errors.js';
import { defaultHttp, getJson, type TrackerHttp } from './http.js';
import type { TrackerIssue, TrackerSource, UpstreamState } from './types.js';

/**
 * `musterd import jira <site> <PROJECT>` (spec 2026-10-11 §2): the project's issues not in the Done
 * status category over Jira's REST API. Cloud (`*.atlassian.net`) answers v3 `/search/jql`, paged by
 * `nextPageToken`; Server and Data Center answer v2 `/search`, paged by `startAt`. An Epic `parent`
 * is the group (Cloud), else the first fix version — Data Center's epic link is a site-specific
 * custom field, so there the fix version is what groups. Highest → high, Low/Lowest → low. Reads only.
 */
export type JiraAuth =
  | { kind: 'basic'; email: string; token: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'anonymous' };

const AUTH_FIX = 'set JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_PAT (Server/Data Center)';

/**
 * Which credentials this site may receive. The site is typed on the command line — a typo, or a
 * command someone else suggested, must never hand a token to the wrong host — so a credential goes
 * only where it can be meant: over https (loopback excepted), the Cloud email + token only to
 * `*.atlassian.net`, and a PAT only to the host `JIRA_SITE` names. Anywhere else the request is
 * anonymous, and `withheld` says why, for the 401 that may follow.
 */
export function jiraAuth(
  site: string,
  env: NodeJS.ProcessEnv = process.env,
): { auth: JiraAuth; withheld?: string } {
  const url = new URL(site);
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  const secure = url.protocol === 'https:' || loopback;
  const email = env['JIRA_EMAIL']?.trim();
  const token = env['JIRA_API_TOKEN']?.trim();
  const pat = env['JIRA_PAT']?.trim();
  const anonymous: JiraAuth = { kind: 'anonymous' };
  if (email && token) {
    if (secure && (host.endsWith('.atlassian.net') || loopback))
      return { auth: { kind: 'basic', email, token } };
    if (!pat)
      return {
        auth: anonymous,
        withheld: `JIRA_API_TOKEN is an Atlassian Cloud token — sent only to *.atlassian.net over https, so not to ${host}`,
      };
  }
  if (pat) {
    const named = siteHost(env['JIRA_SITE']);
    if (!named)
      return {
        auth: anonymous,
        withheld: `JIRA_PAT is sent only to the host in JIRA_SITE — set JIRA_SITE=${host} if ${host} is yours`,
      };
    if (named !== host || !secure)
      return {
        auth: anonymous,
        withheld: `JIRA_PAT is sent only to the host in JIRA_SITE (${named}) over https, so not to ${host}`,
      };
    return { auth: { kind: 'bearer', token: pat } };
  }
  return { auth: anonymous };
}

function siteHost(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    return new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

interface ApiIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    priority?: { name?: string } | null;
    fixVersions?: { id: string; name: string }[];
    parent?: { key: string; fields?: { summary?: string; issuetype?: { name?: string } } } | null;
  };
}

export function jiraSource(opts: {
  site: string;
  project: string;
  auth: JiraAuth;
  http?: TrackerHttp;
  apiVersion?: 2 | 3;
  /** Why `jiraAuth` sent no credentials to this site — named in the error if the site refuses. */
  withheld?: string;
}): TrackerSource & { apiVersion: 2 | 3 } {
  const http = opts.http ?? defaultHttp;
  const site = opts.site.replace(/\/+$/, '');
  const apiVersion = opts.apiVersion ?? (new URL(site).hostname.endsWith('.atlassian.net') ? 3 : 2);
  const api = `${site}/rest/api/${String(apiVersion)}`;
  const ctx = {
    tracker: 'Jira',
    authFix: opts.withheld ? `credentials not sent: ${opts.withheld}` : AUTH_FIX,
  };
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'musterd' };
  if (opts.auth.kind === 'basic')
    headers['authorization'] =
      `Basic ${Buffer.from(`${opts.auth.email}:${opts.auth.token}`).toString('base64')}`;
  else if (opts.auth.kind === 'bearer') headers['authorization'] = `Bearer ${opts.auth.token}`;
  const owns = new RegExp(`^${opts.project.replace(/[^A-Za-z0-9_]/g, '')}-\\d+$`);
  const jql = `project = "${opts.project.replace(/"/g, '')}" AND statusCategory != Done ORDER BY key`;
  const fields = `summary,${apiVersion === 2 ? 'description,' : ''}priority,fixVersions,parent`;

  const search = async (page: Record<string, string>) => {
    const q = new URLSearchParams({ jql, fields, maxResults: '100', ...page });
    const path = apiVersion === 3 ? '/search/jql' : '/search';
    const res = await getJson(
      http,
      `${api}${path}?${q.toString()}`,
      { headers, okStatuses: [400] },
      ctx,
    );
    const j = (res.json ?? {}) as {
      issues?: ApiIssue[];
      errorMessages?: string[];
      total?: number;
      nextPageToken?: string;
      isLast?: boolean;
    };
    if (res.status === 400 || res.json === null)
      throw new CliError(
        `Jira: ${j.errorMessages?.[0] ?? `no project ${opts.project} on ${site}, or it is not visible`}`,
        1,
      );
    if (!Array.isArray(j.issues)) throw new CliError('Jira sent a search page without issues', 1);
    return j;
  };

  return {
    tracker: 'jira',
    label: 'Jira',
    scope: opts.project,
    apiVersion,
    ownsRef: (ref) => owns.test(ref),
    async open(limit = Infinity) {
      const out: TrackerIssue[] = [];
      let startAt = 0;
      let token: string | undefined;
      for (;;) {
        const page =
          apiVersion === 3
            ? await search(token ? { nextPageToken: token } : {})
            : await search({ startAt: String(startAt) });
        for (const i of page.issues!) {
          // The key becomes a lane's source_ref and a URL path: it must be this project's.
          if (typeof i.key !== 'string' || !owns.test(i.key))
            throw new CliError(
              `Jira sent an issue key that is not ${opts.project}-<number> — stopped`,
              1,
            );
          out.push(toIssue(site, i));
          if (out.length >= limit) return out;
        }
        if (apiVersion === 3) {
          if (page.isLast !== false || !page.nextPageToken) return out;
          token = page.nextPageToken;
        } else {
          startAt += page.issues!.length;
          if (page.issues!.length === 0 || startAt >= (page.total ?? 0)) return out;
        }
      }
    },
    async state(ref): Promise<UpstreamState> {
      const res = await getJson(
        http,
        `${api}/issue/${encodeURIComponent(ref)}?fields=status`,
        { headers },
        ctx,
      );
      if (res.json === null) return 'not_found';
      const j = res.json as {
        key?: string;
        fields?: { status?: { statusCategory?: { key?: string } } };
      };
      // Moved to another project: Jira answers with the issue's new key.
      if (j.key !== ref) return 'not_found';
      return j.fields?.status?.statusCategory?.key === 'done' ? 'closed' : 'open';
    },
  };
}

function toIssue(site: string, i: ApiIssue): TrackerIssue {
  const f = i.fields;
  const p = f.priority?.name?.toLowerCase();
  const stakes: LaneStakes | undefined =
    p === 'highest' ? 'high' : p === 'low' || p === 'lowest' ? 'low' : undefined;
  const epic = f.parent?.fields?.issuetype?.name === 'Epic' ? f.parent : undefined;
  const version = f.fixVersions?.[0];
  const group = epic
    ? { key: epic.key, title: epic.fields?.summary ?? epic.key }
    : version
      ? { key: `fv-${version.id}`, title: version.name }
      : undefined;
  // v2 bodies are wiki-markup strings; v3's are ADF documents, left out (the URL leads the detail).
  const body =
    typeof f.description === 'string' && f.description.trim() ? f.description : undefined;
  return {
    ref: i.key,
    title: f.summary,
    url: `${site}/browse/${i.key}`,
    ...(body ? { body } : {}),
    ...(group ? { group } : {}),
    ...(stakes ? { stakes } : {}),
  };
}
