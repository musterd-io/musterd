/**
 * `pnpm train status [--version X.Y.Z]` — where a version stands on every surface it leaves through
 * (ADR 669 §3.1). Read-only and credential-free: public npm, git, GitHub, MCP Registry, the brew
 * tap and musterd.io, so any seat can run it. It is `musterd service site-gap` (ADR 308's
 * landed-is-not-live check) generalised from the site to the whole train.
 *
 * Each car reads one of three ways: ✓ the surface carries the version, ✗ it does not, ? the check
 * could not tell (network refused, endpoint down) — never folded into ✓ or ✗, because a car we
 * could not see is neither done nor broken. Exit 1 on any ✗, so it works as a gate.
 */
import { execFileSync } from 'node:child_process';

export type Verdict = 'ok' | 'missing' | 'unknown';
export interface CarResult {
  car: string;
  verdict: Verdict;
  detail: string;
}

export type FetchJson = (url: string) => Promise<{ status: number; json: unknown } | null>;
export type FetchText = (url: string) => Promise<{ status: number; text: string } | null>;
export type Git = (...args: string[]) => string | null;

export const PACKAGES = [
  '@musterd/protocol',
  '@musterd/telemetry',
  '@musterd/server',
  '@musterd/mcp',
  '@musterd/cli',
] as const;
export const REPO = 'musterd-io/musterd';
export const REGISTRY_NAME = 'io.musterd/musterd';
export const TAP_FORMULA =
  'https://raw.githubusercontent.com/SandRiseStudio/homebrew-musterd/main/Formula/musterd.rb';
export const SITE_BUILD = 'https://musterd.io/build.json';

export async function checkNpm(fetchJson: FetchJson, version: string): Promise<CarResult> {
  const behind: string[] = [];
  for (const name of PACKAGES) {
    const res = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
    if (!res || res.status !== 200)
      return { car: 'npm', verdict: 'unknown', detail: `could not read ${name}` };
    const latest = (res.json as { 'dist-tags'?: { latest?: string } })['dist-tags']?.latest;
    if (latest !== version) behind.push(`${name}@${latest ?? 'none'}`);
  }
  return behind.length
    ? { car: 'npm', verdict: 'missing', detail: `latest is not ${version}: ${behind.join(', ')}` }
    : { car: 'npm', verdict: 'ok', detail: `all ${PACKAGES.length} packages at ${version}` };
}

export function checkTag(git: Git, version: string): CarResult {
  const out = git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`);
  if (out === null) return { car: 'tag', verdict: 'unknown', detail: 'git ls-remote failed' };
  return out.trim()
    ? { car: 'tag', verdict: 'ok', detail: `v${version} on origin` }
    : { car: 'tag', verdict: 'missing', detail: `no v${version} tag on origin` };
}

export async function checkGithubRelease(
  fetchJson: FetchJson,
  version: string,
): Promise<CarResult> {
  const res = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`);
  if (!res) return { car: 'GitHub Release', verdict: 'unknown', detail: 'GitHub API unreachable' };
  if (res.status === 404)
    return { car: 'GitHub Release', verdict: 'missing', detail: `no release for v${version}` };
  if (res.status !== 200)
    return { car: 'GitHub Release', verdict: 'unknown', detail: `GitHub API ${res.status}` };
  const body = (res.json as { body?: string }).body ?? '';
  return body.trim()
    ? { car: 'GitHub Release', verdict: 'ok', detail: `v${version} published with notes` }
    : {
        car: 'GitHub Release',
        verdict: 'missing',
        detail: `v${version} published with an empty body`,
      };
}

export async function checkRegistry(fetchJson: FetchJson, version: string): Promise<CarResult> {
  const res = await fetchJson(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(REGISTRY_NAME)}`,
  );
  if (!res || res.status !== 200)
    return { car: 'MCP Registry', verdict: 'unknown', detail: 'registry unreachable' };
  const servers =
    (res.json as { servers?: { server?: { name?: string; version?: string } }[] }).servers ?? [];
  const ours = servers.map((s) => s.server).filter((s) => s?.name === REGISTRY_NAME);
  if (!ours.length)
    return { car: 'MCP Registry', verdict: 'missing', detail: `${REGISTRY_NAME} not listed` };
  return ours.some((s) => s?.version === version)
    ? { car: 'MCP Registry', verdict: 'ok', detail: `${REGISTRY_NAME} ${version} listed` }
    : {
        car: 'MCP Registry',
        verdict: 'missing',
        detail: `${REGISTRY_NAME} listed at ${ours.map((s) => s?.version).join(', ')}, not ${version}`,
      };
}

export async function checkBrew(fetchText: FetchText, version: string): Promise<CarResult> {
  const res = await fetchText(TAP_FORMULA);
  if (!res || res.status !== 200)
    return { car: 'Homebrew', verdict: 'unknown', detail: 'tap formula unreachable' };
  const m = /cli-(\d+\.\d+\.\d+[^"]*)\.tgz/.exec(res.text);
  if (!m) return { car: 'Homebrew', verdict: 'unknown', detail: 'formula has no cli tarball url' };
  return m[1] === version
    ? { car: 'Homebrew', verdict: 'ok', detail: `tap formula at ${version}` }
    : { car: 'Homebrew', verdict: 'missing', detail: `tap formula at ${m[1]}` };
}

/**
 * musterd.io serves its build stamp; the site carries the version when the tagged commit is an
 * ancestor of the commit it was built from. The stamp's ref can end in `-dirty` (a build from a
 * working tree with local changes) — the commit part still answers the question.
 */
export async function checkSite(
  fetchJson: FetchJson,
  git: Git,
  version: string,
): Promise<CarResult> {
  const res = await fetchJson(SITE_BUILD);
  const ref = (res?.json as { ref?: string } | undefined)?.ref?.replace(/-dirty$/, '');
  if (!res || res.status !== 200 || !ref)
    return { car: 'site', verdict: 'unknown', detail: 'no build stamp' };
  const tagSha = git('rev-list', '-n', '1', `v${version}`)?.trim();
  if (!tagSha)
    return { car: 'site', verdict: 'unknown', detail: `v${version} not in local git (fetch tags)` };
  // A ref git cannot resolve is a fetch we have not done, not a site that is behind.
  if (git('cat-file', '-e', `${ref}^{commit}`) === null) {
    return {
      car: 'site',
      verdict: 'unknown',
      detail: `site at ${ref.slice(0, 8)}, not in local git (git fetch)`,
    };
  }
  const ancestor = git('merge-base', '--is-ancestor', tagSha, ref);
  if (ancestor === null) {
    return {
      car: 'site',
      verdict: 'missing',
      detail: `site at ${ref.slice(0, 8)}, which does not contain v${version}`,
    };
  }
  return { car: 'site', verdict: 'ok', detail: `site at ${ref.slice(0, 8)}, contains v${version}` };
}

export async function trainStatus(
  version: string,
  io: { fetchJson: FetchJson; fetchText: FetchText; git: Git },
): Promise<CarResult[]> {
  return [
    await checkNpm(io.fetchJson, version),
    checkTag(io.git, version),
    await checkGithubRelease(io.fetchJson, version),
    await checkRegistry(io.fetchJson, version),
    await checkBrew(io.fetchText, version),
    await checkSite(io.fetchJson, io.git, version),
  ];
}

const MARK: Record<Verdict, string> = { ok: '✓', missing: '✗', unknown: '?' };

export function renderStatus(version: string, results: CarResult[]): string {
  const width = Math.max(...results.map((r) => r.car.length));
  const lines = results.map((r) => `  ${MARK[r.verdict]} ${r.car.padEnd(width)}  ${r.detail}`);
  const missing = results.filter((r) => r.verdict === 'missing').length;
  const unknown = results.filter((r) => r.verdict === 'unknown').length;
  const summary = missing
    ? `${missing} car${missing > 1 ? 's' : ''} not there yet`
    : unknown
      ? `nothing missing; ${unknown} could not be checked`
      : 'all green';
  return [`train v${version} — ${summary}`, ...lines].join('\n');
}

// ── real I/O ────────────────────────────────────────────────────────────────────────────────────

const timeout = () => AbortSignal.timeout(10_000);
export const realIo = {
  fetchJson: (async (url) => {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'musterd-train' },
        signal: timeout(),
      });
      return { status: r.status, json: r.status === 200 ? await r.json() : null };
    } catch {
      return null;
    }
  }) as FetchJson,
  fetchText: (async (url) => {
    try {
      const r = await fetch(url, { signal: timeout() });
      return { status: r.status, text: await r.text() };
    } catch {
      return null;
    }
  }) as FetchText,
  git: ((...args: string[]) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  }) as Git,
};
