import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import * as p from '@clack/prompts';
import type { HttpClient } from '../client.js';
import { excludeCredentialFromGit } from '../config.js';
import { paint as pc } from '../render/theme.js';
import { sym } from '../render/ui.js';
import { provisionAgentSeat, type AgentSeatInput } from './agentSeat.js';
import { bindingRefusal } from './guard.js';
import { HARNESSES, harnessAdapters } from './harnesses/index.js';
import { renderRepositoryPrimer, upsertPrimer } from './primer.js';
import { recentRepos } from './recents.js';

/**
 * `musterd init`'s default path (lane 01M4FDBVGB): one seat per picked repo, every chosen harness
 * wired into each, in one run. The per-repo work is `provisionAgentSeat` with `here: true` — the
 * sequence behind `musterd agent --here` — so nothing here re-implements minting or wiring.
 */

/** A seat name from the folder name: lower-case, no whitespace, suffixed `-2`, `-3` when taken. */
export function seatNameFor(dir: string, taken: Iterable<string>): string {
  const clean =
    basename(resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(clean)) return clean;
  for (let i = 2; ; i++) if (!lower.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

const SEAT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Why `name` cannot be a new seat, or null. The roster only refuses whitespace, but the name also
 * becomes `seats/<name>.toml` and the git trailer `<name>@<team>.musterd`, so connect holds it to
 * what `seatNameFor` itself produces. `taken` compares ignoring case, as `seatNameFor` does.
 */
export function seatNameProblem(name: string, taken: Iterable<string>): string | null {
  if (!name) return 'name the seat';
  if (name.length > 64) return 'at most 64 characters';
  if (!SEAT_NAME_RE.test(name))
    return 'letters, numbers, - and _ only, starting with a letter or number';
  const lower = name.toLowerCase();
  for (const t of taken) if (t.toLowerCase() === lower) return `${name} is taken on this team`;
  return null;
}

export interface ConnectResult {
  dir: string;
  name: string;
  status: 'ok' | 'partial' | 'failed';
  /** The selected harnesses whose every fragment is in place. */
  wired: string[];
  detail: string | null;
}

export interface ConnectReposInput {
  repos: string[];
  desired: string[];
  team: string;
  server: string;
  http: AgentSeatInput['http'];
  /** Names already on the team, so a new seat never collides with one. */
  roster: string[];
  /** Seat names chosen per repo dir; a repo missing here is named after its folder. */
  names?: Record<string, string>;
  rosterHome?: string | undefined;
  driver?: string | undefined;
  model?: string | undefined;
  provision?: typeof provisionAgentSeat;
  writePrimer?: (dir: string) => void;
  excludeCredential?: (dir: string) => boolean;
}

const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged']);

export async function connectRepos(input: ConnectReposInput): Promise<ConnectResult[]> {
  const provision = input.provision ?? provisionAgentSeat;
  const writePrimer =
    input.writePrimer ??
    ((dir: string) => void upsertPrimer(dir, renderRepositoryPrimer({ team: input.team })));
  const excludeCredential = input.excludeCredential ?? excludeCredentialFromGit;
  const taken = [...input.roster];
  const out: ConnectResult[] = [];
  for (const dir of input.repos) {
    const name = input.names?.[dir] ?? seatNameFor(dir, taken);
    taken.push(name);
    try {
      // The binding about to land here holds the seat's credential, and this is the person's own
      // repo: ignore it first, so not even a failed run leaves a committable key (ADR 176).
      const ignored = excludeCredential(dir);
      const r = await provision({
        name,
        team: input.team,
        server: input.server,
        http: input.http,
        harnesses: input.desired,
        toolkit: '',
        sourceDir: dir,
        here: true,
        // The person's own checkout: their commits stay theirs.
        gitIdentity: false,
        rosterHome: input.rosterHome,
        driver: input.driver,
        model: input.model,
      });
      const rows = r.wiring?.results ?? [];
      const wired: string[] = [];
      const problems: string[] = [];
      for (const id of input.desired) {
        const mine = rows.filter((x) => x.harness === id);
        const bad = mine.filter((x) => !WIRED.has(x.result) && x.result !== 'pending');
        if (bad.length > 0)
          problems.push(`${id}: ${bad.map((x) => x.detail ?? x.result).join(', ')}`);
        else if (mine.length > 0 && mine.every((x) => WIRED.has(x.result))) wired.push(id);
      }
      if (!ignored)
        problems.push("couldn't add .musterd/binding.json to .gitignore — don't commit it");
      const detail = r.wiringError ?? (problems.length ? problems.join('; ') : null);
      writePrimer(dir);
      out.push({ dir, name, status: detail ? 'partial' : 'ok', wired, detail });
    } catch (err) {
      out.push({ dir, name, status: 'failed', wired: [], detail: (err as Error).message });
    }
  }
  return out;
}

/** One summary line per repo: `✓ web — Claude Code, Cursor`. */
export function resultLine(r: ConnectResult, labels: Record<string, string>): string {
  const harnesses = r.wired.map((id) => labels[id] ?? id).join(', ') || 'no agent wired yet';
  if (r.status === 'failed') return `${pc.red(sym.err)} ${r.name} — ${r.detail}`;
  if (r.status === 'partial')
    return `${pc.yellow(sym.warn)} ${r.name} — ${harnesses}; ${r.detail}; run musterd wire there`;
  return `${pc.green(sym.ok)} ${r.name} — ${harnesses}`;
}

export interface RunConnectInput {
  team: string;
  server: string;
  http: Pick<HttpClient, 'roster'> & AgentSeatInput['http'];
  cwd: string;
  home: string;
  rosterHome?: string | undefined;
  driver?: string | undefined;
  model?: string | undefined;
}

/** init's own cancel guard, repeated here because init imports this module. */
function guard<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value as T;
}

function ago(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

const tilde = (dir: string, home: string) =>
  dir.startsWith(home + sep) ? '~' + dir.slice(home.length) : dir;

/** How to bring a connected seat up, by the first selected harness. */
function launchHint(desired: readonly string[], dir: string): string {
  const hints: Record<string, string> = {
    'claude-code': `cd ${dir} && claude`,
    cursor: `open ${dir} in Cursor`,
    codex: `open ${dir} in Codex`,
    opencode: `cd ${dir} && opencode`,
    grok: `cd ${dir} && grok`,
  };
  const first = desired.find((id) => hints[id]);
  return first ? hints[first]! : `cd ${dir} && musterd host`;
}

function realOr(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Each repo's seat name: the folder name (suffixed when taken), shown as `repo → name` and kept on
 * Enter. "Change names" asks once per repo, prefilled, refusing a taken or malformed name. A seat
 * name sticks (seat file, git trailer, what teammates address), so it is shown before it is minted.
 */
async function chooseNames(
  repos: string[],
  roster: string[],
  home: string,
): Promise<Record<string, string>> {
  const taken = [...roster];
  const names: Record<string, string> = {};
  const rows: string[] = [];
  for (const dir of repos) {
    const name = seatNameFor(dir, taken);
    const folder = seatNameFor(dir, []);
    taken.push(name);
    names[dir] = name;
    const why = name === folder ? '' : pc.dim(`  (${folder} is taken)`);
    rows.push(`${tilde(dir, home)}  ${pc.dim('→')}  ${pc.cyan(name)}${why}`);
  }
  p.note(rows.join('\n'), 'Seat names');
  const choice = guard(
    await p.select({
      message: 'Connect with these names?',
      options: [
        { value: 'accept', label: 'Yes, connect' },
        { value: 'edit', label: 'Change names' },
      ],
      initialValue: 'accept',
    }),
  );
  if (choice !== 'edit') return names;

  const picked = [...roster];
  for (const dir of repos) {
    const before = [...picked];
    const prefill = seatNameProblem(names[dir]!, before) ? seatNameFor(dir, before) : names[dir]!;
    const name = guard(
      await p.text({
        message: `Seat name for ${tilde(dir, home)}`,
        initialValue: prefill,
        validate: (v) => seatNameProblem((v ?? '').trim(), before) ?? undefined,
      }),
    ).trim();
    picked.push(name);
    names[dir] = name;
  }
  return names;
}

/**
 * The connect path's prompts: which agents (once, for every repo), which repos (this folder first,
 * then what the agents have recently worked in), then their seat names, then one result line per
 * repo. Returns the exit
 * code: 1 when any repo failed.
 */
export async function runConnect(input: RunConnectInput): Promise<number> {
  const sd = p.spinner();
  sd.start('Looking for the agents on this machine');
  const detected = await Promise.all(HARNESSES.map(async (h) => ({ h, d: await h.detect() })));
  sd.stop('Scanned for agents');
  for (const { h, d } of detected)
    p.log.step(
      `${pc.bold(h.label)} ${pc.dim('—')} ${d.installed ? pc.yellow('installed') : pc.dim('not installed')}`,
    );

  const labels: Record<string, string> = Object.fromEntries(HARNESSES.map((h) => [h.id, h.label]));
  const installed = new Set(detected.filter((x) => x.d.installed).map((x) => x.h.id));
  const adapters = harnessAdapters().filter((a) => a.id !== 'musterd');
  const desired = guard(
    await p.multiselect({
      message: 'Which agents should join? (space toggles, enter confirms)',
      options: adapters.map((a) => ({
        value: a.id,
        label: labels[a.id] ?? a.id,
        ...(installed.has(a.id) ? {} : { hint: 'pending — not installed here' }),
      })),
      initialValues: adapters.filter((a) => installed.has(a.id)).map((a) => a.id),
      required: false,
    }),
  ) as string[];

  const now = Date.now();
  const here = realOr(input.cwd);
  const hereOk = bindingRefusal(here, input.home) === null;
  const suggestions = recentRepos({
    home: input.home,
    harnessIds: [...installed],
    exclude: [here],
  });
  const repos = guard(
    await p.multiselect({
      message: 'Which repos should be connected? (each becomes a seat)',
      options: [
        ...(hereOk ? [{ value: here, label: tilde(here, input.home), hint: 'this folder' }] : []),
        ...suggestions.map((r) => ({
          value: r.dir,
          label: tilde(r.dir, input.home),
          hint: `${r.harnesses.map((id) => labels[id] ?? id).join(', ')} · ${ago(r.lastUsed, now)}`,
        })),
      ],
      initialValues: hereOk ? [here] : [],
      required: false,
    }),
  ) as string[];
  if (repos.length === 0) {
    p.outro('Nothing connected. Run `musterd init` again when you want to.');
    return 0;
  }

  const { members } = await input.http.roster(input.team);
  const roster = members.map((m) => m.name);
  const names = await chooseNames(repos, roster, input.home);
  const s = p.spinner();
  s.start(`Connecting ${repos.length} repo${repos.length === 1 ? '' : 's'}`);
  const results = await connectRepos({
    repos,
    desired,
    team: input.team,
    server: input.server,
    http: input.http,
    roster,
    names,
    rosterHome: input.rosterHome,
    driver: input.driver,
    model: input.model,
  });
  s.stop(`Connected to ${pc.bold(input.team)}`);
  for (const r of results) p.log.message(resultLine(r, labels));

  const up = results.filter((r) => r.status !== 'failed');
  if (up.length > 0) {
    p.note(
      up
        .map((r) => `${pc.cyan(r.name)}  ${launchHint(desired, tilde(r.dir, input.home))}`)
        .join('\n') + `\n\n${pc.yellow('musterd status')}   see them on the roster`,
      'Start any of them',
    );
  }
  // The same offer as init's single-agent path. No presence wait here: none of these seats is
  // running yet, and the tour's own team step waits for an agent and says how to start one.
  if (up.length > 0 && input.driver) {
    const tour = guard(
      await p.confirm({
        message: `Take the 5-minute tour? ${pc.dim('(it makes you a workspace of your own first)')}`,
        initialValue: true,
      }),
    );
    if (tour) {
      p.outro(pc.yellow('Starting the tour.'));
      return (await import('./tourOffer.js')).startTourAsPerson(input.driver, input.team);
    }
  }
  p.outro(pc.yellow(`${up.length} seat${up.length === 1 ? '' : 's'} on ${input.team}.`));
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}
