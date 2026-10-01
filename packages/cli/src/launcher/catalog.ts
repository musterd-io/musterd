import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TOKEN_PREFIXES } from '@musterd/protocol';
import { loadBinding, type Config } from '../config.js';
import { canonicalServer } from '../host/registry.js';
import { loadProvisioning } from '../onboard/manifest.js';
import { seatAddress, serverHost } from './address.js';
import type { Seat, SeatProblem, Snapshot, TeamEntry } from './store.js';

/*
 * The seat catalog (ADR 491 Decision 7): every Workspace on this machine, read from
 * config.bindings plus a scan of the ADR 447 layout (~/musterd/<team>/<project>/<member>). Each
 * binding is parsed through the protocol schema by `loadBinding` (exact folder, no env, no walk),
 * and only named non-secret fields are copied out. It runs AFTER the first paint: it loads the
 * protocol package, which measured ~740 ms cold.
 */

export interface CatalogInput {
  /** The `~` the layout hangs off. A parameter, not `homedir()`: tests do not pin HOME. */
  home: string;
  config: Pick<Config, 'bindings' | 'identities' | 'knownIdentities'>;
  now?: number;
}

export interface Catalog extends Snapshot {
  /** Registry entries whose folder is gone — `musterd init --prune-bindings --apply` drops them. */
  stale: string[];
}

type Draft = Omit<Seat, 'address'>;

export function buildCatalog(input: CatalogInput): Catalog {
  const roof = join(input.home, 'musterd');
  const realRoof = realpathOr(roof);
  const stale: string[] = [];
  const dirs = new Set<string>();
  const refs = new Map<string, { team: string; seat: string }>();
  for (const [dir, ref] of Object.entries(input.config.bindings)) {
    if (!existsSync(join(dir, '.musterd', 'binding.json'))) {
      stale.push(dir);
      continue;
    }
    dirs.add(realpathOr(dir));
    refs.set(realpathOr(dir), ref);
  }
  for (const dir of layoutWorkspaces(roof)) dirs.add(realpathOr(dir));

  const drafts: Draft[] = [];
  for (const dir of [...dirs].sort()) {
    const draft = readSeat(dir, realRoof, refs.get(dir));
    if (draft) drafts.push(draft);
  }
  const seats = addressed(drafts);
  const teamNames = new Set<string>([
    ...Object.keys(input.config.identities),
    ...input.config.knownIdentities.map((i) => i.team),
    ...seats.map((s) => s.team),
  ]);
  const teams: TeamEntry[] = [...teamNames]
    .sort()
    .map((team) => ({ team, here: seats.some((s) => s.team === team) }));
  return { taken_at: input.now ?? Date.now(), seats, teams, stale: stale.sort() };
}

function readSeat(
  dir: string,
  roof: string,
  ref: { team: string; seat: string } | undefined,
): Draft | null {
  const layout = layoutParts(dir, roof);
  const got = loadBinding(dir);
  if (got.kind === 'missing') return null;
  if (got.kind !== 'valid') {
    // A broken binding names nothing itself: the layout path or the bindings registry entry does.
    const name =
      layout ??
      (ref
        ? {
            team: ref.team,
            project: originRepoName(dir) ?? basename(dirname(dir)),
            member: ref.seat,
          }
        : null);
    if (!name) return null;
    const problem: SeatProblem =
      got.kind === 'legacy'
        ? { kind: 'binding-legacy', fix: `cd ${dir} && musterd harness configure` }
        : { kind: 'binding-invalid', fix: `cd ${dir} && musterd init --check` };
    return {
      ...name,
      server: '',
      path: dir,
      kind: 'agent',
      harnesses: [],
      remote: null,
      last_session: null,
      problem,
    };
  }
  const b = got.value;
  const remote = originRepoName(dir);
  const project = layout?.project ?? remote ?? basename(dirname(dir));
  const prov = loadProvisioning(dir);
  const problem: SeatProblem | null =
    prov.kind === 'legacy'
      ? { kind: 'provisioning-legacy', fix: `cd ${dir} && musterd harness configure` }
      : prov.kind === 'invalid'
        ? { kind: 'provisioning-invalid', fix: `cd ${dir} && musterd harness configure` }
        : null;
  return {
    team: b.team,
    project,
    member: b.claim?.mode === 'seat' ? b.claim.name : (layout?.member ?? basename(dir)),
    server: b.server,
    path: dir,
    // The prefix is read, never copied: a human Workspace's binding carries their `mscr_` (ADR 069).
    kind: b.agent_key?.startsWith(TOKEN_PREFIXES.credential) ? 'human' : 'agent',
    harnesses: prov.kind === 'valid' ? prov.value.desired : [],
    remote: remote !== null && remote !== project ? remote : null,
    last_session: b.session
      ? {
          harness: b.session.harness,
          started_at: b.session.started_at,
          ended_at: b.session.ended_at ?? null,
        }
      : null,
    problem,
  };
}

/** `team/project/member`; host-qualified when one address is served by two servers; `~2` for a duplicate. */
function addressed(drafts: Draft[]): Seat[] {
  const byBase = new Map<string, Draft[]>();
  for (const d of drafts) {
    const base = seatAddress(d.team, d.project, d.member);
    byBase.set(base, [...(byBase.get(base) ?? []), d]);
  }
  const out: Seat[] = [];
  for (const [base, group] of byBase) {
    const servers = new Set(group.map((d) => canonicalServer(d.server)));
    group.forEach((d, i) => {
      const address =
        servers.size > 1
          ? seatAddress(d.team, d.project, d.member, serverHost(canonicalServer(d.server)))
          : i === 0
            ? base
            : `${base}~${i + 1}`;
      out.push({ address, ...d });
    });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

function layoutWorkspaces(roof: string): string[] {
  const out: string[] = [];
  for (const team of childDirs(roof))
    for (const project of childDirs(join(roof, team)))
      for (const member of childDirs(join(roof, team, project))) {
        const dir = join(roof, team, project, member);
        if (existsSync(join(dir, '.musterd', 'binding.json'))) out.push(dir);
      }
  return out;
}

function layoutParts(
  dir: string,
  roof: string,
): { team: string; project: string; member: string } | null {
  if (!dir.startsWith(roof + '/')) return null;
  const parts = dir.slice(roof.length + 1).split('/');
  if (parts.length !== 3) return null;
  const [team, project, member] = parts as [string, string, string];
  return { team, project, member };
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The `origin` remote's repo name for the checkout at `dir`, read from git's own files — `.git`
 * (a file in a linked checkout), `commondir`, `config` — never a `git` subprocess, which would cost
 * ~10 ms per Workspace.
 */
export function originRepoName(dir: string): string | null {
  try {
    let gitDir = join(dir, '.git');
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = resolve(dir, m[1]!.trim());
    }
    const commondir = join(gitDir, 'commondir');
    const common = existsSync(commondir)
      ? resolve(gitDir, readFileSync(commondir, 'utf8').trim())
      : gitDir;
    const config = readFileSync(join(common, 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
    const url = section ? /^\s*url\s*=\s*(.+)$/m.exec(section[1]!)?.[1]?.trim() : undefined;
    if (!url) return null;
    const tail = url
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '');
    return tail ? tail : null;
  } catch {
    return null;
  }
}
