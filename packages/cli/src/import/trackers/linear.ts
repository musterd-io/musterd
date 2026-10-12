import type { LaneStakes } from '@musterd/protocol';
import { CliError } from '../../errors.js';
import { defaultHttp, getJson, TrackerAuthError, type TrackerHttp } from './http.js';
import type { TrackerIssue, TrackerSource, UpstreamState } from './types.js';

/**
 * `musterd import linear --team <KEY>` (spec 2026-10-11 §2): the team's open issues (state type not
 * completed or canceled) over Linear's GraphQL API, with the key in `LINEAR_API_KEY`. A project is
 * the group, else the cycle; priority 1 (Urgent) → high, 4 (Low) → low. Reads only.
 */
const AUTH_FIX = 'check LINEAR_API_KEY, or make a new one in Linear (Settings → API)';

export function linearKey(env: NodeJS.ProcessEnv = process.env): string {
  const k = env['LINEAR_API_KEY']?.trim();
  if (k) return k;
  throw new TrackerAuthError(
    'no Linear key — create one in Linear (Settings → API) and set LINEAR_API_KEY',
  );
}

const OPEN_QUERY = `query($team: String!, $after: String) {
  issues(first: 100, after: $after,
         filter: { team: { key: { eq: $team } }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { identifier title url description priority project { id name } cycle { number name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATE_QUERY = `query($id: String!) {
  issue(id: $id) { identifier archivedAt state { type } }
}`;

interface GqlError {
  message?: string;
  extensions?: { code?: string; type?: string };
}

interface Node {
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  priority?: number | null;
  project?: { id: string; name: string } | null;
  cycle?: { number: number; name?: string | null } | null;
}

export function linearSource(opts: {
  team: string;
  key: string;
  http?: TrackerHttp;
  endpoint?: string;
}): TrackerSource {
  const http = opts.http ?? defaultHttp;
  const endpoint = opts.endpoint ?? 'https://api.linear.app/graphql';
  const ctx = { tracker: 'Linear', authFix: AUTH_FIX };
  const owns = new RegExp(`^${opts.team.replace(/[^A-Za-z0-9]/g, '')}-\\d+$`);

  const ask = async (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: unknown; errors: GqlError[] }> => {
    const res = await getJson(
      http,
      endpoint,
      {
        method: 'POST',
        // A personal API key goes as-is; Linear reads `Bearer` only for OAuth tokens.
        headers: {
          authorization: opts.key,
          'content-type': 'application/json',
          'user-agent': 'musterd',
        },
        body: JSON.stringify({ query, variables }),
        okStatuses: [400],
      },
      ctx,
    );
    const j = (res.json ?? {}) as { data?: unknown; errors?: GqlError[] };
    const errors = j.errors ?? [];
    if (errors.some(isAuthError))
      throw new TrackerAuthError(`Linear refused the key — ${AUTH_FIX}`);
    return { data: j.data, errors };
  };

  return {
    tracker: 'linear',
    label: 'Linear',
    scope: opts.team,
    ownsRef: (ref) => owns.test(ref),
    async open(limit = Infinity) {
      const out: TrackerIssue[] = [];
      let after: string | null = null;
      for (;;) {
        const { data, errors } = await ask(OPEN_QUERY, { team: opts.team, after });
        if (errors.length) throw new CliError(`Linear: ${errors[0]!.message ?? 'query failed'}`, 1);
        const page = (
          data as {
            issues?: {
              nodes?: Node[];
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
          }
        )?.issues;
        if (!page?.nodes) throw new CliError('Linear sent an issues page without nodes', 1);
        for (const n of page.nodes) {
          if (typeof n.identifier !== 'string' || !owns.test(n.identifier))
            throw new CliError(
              `Linear sent an issue identifier that is not ${opts.team}-<number> — stopped`,
              1,
            );
          out.push(toIssue(n));
          if (out.length >= limit) return out;
        }
        if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) return out;
        after = page.pageInfo.endCursor;
      }
    },
    async state(ref): Promise<UpstreamState> {
      const { data, errors } = await ask(STATE_QUERY, { id: ref });
      if (errors.some((e) => /not found/i.test(e.message ?? ''))) return 'not_found';
      if (errors.length) throw new CliError(`Linear: ${errors[0]!.message ?? 'query failed'}`, 1);
      const issue = (
        data as {
          issue?: {
            identifier?: string;
            archivedAt?: string | null;
            state?: { type?: string };
          } | null;
        }
      )?.issue;
      // Moved to another team (a new identifier) or archived: gone from here, not closed.
      if (!issue || issue.identifier !== ref || issue.archivedAt) return 'not_found';
      const type = issue.state?.type;
      return type === 'completed' || type === 'canceled' ? 'closed' : 'open';
    },
  };
}

function isAuthError(e: GqlError): boolean {
  return (
    e.extensions?.code === 'AUTHENTICATION_ERROR' ||
    /authenticat/i.test(e.extensions?.type ?? '') ||
    /not authenticated|authentication required/i.test(e.message ?? '')
  );
}

function toIssue(n: Node): TrackerIssue {
  const stakes: LaneStakes | undefined =
    n.priority === 1 ? 'high' : n.priority === 4 ? 'low' : undefined;
  const group = n.project
    ? { key: n.project.id, title: n.project.name }
    : n.cycle
      ? {
          key: `cycle-${String(n.cycle.number)}`,
          title: n.cycle.name ?? `Cycle ${String(n.cycle.number)}`,
        }
      : undefined;
  return {
    ref: n.identifier,
    title: n.title,
    url: n.url,
    ...(n.description ? { body: n.description } : {}),
    ...(group ? { group } : {}),
    ...(stakes ? { stakes } : {}),
  };
}
