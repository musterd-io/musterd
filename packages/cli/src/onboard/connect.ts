import { basename, resolve } from 'node:path';
import { paint as pc } from '../render/theme.js';
import { sym } from '../render/ui.js';
import { provisionAgentSeat, type AgentSeatInput } from './agentSeat.js';
import { renderRepositoryPrimer, upsertPrimer } from './primer.js';

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
  rosterHome?: string | undefined;
  driver?: string | undefined;
  model?: string | undefined;
  provision?: typeof provisionAgentSeat;
  writePrimer?: (dir: string) => void;
}

const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged']);

export async function connectRepos(input: ConnectReposInput): Promise<ConnectResult[]> {
  const provision = input.provision ?? provisionAgentSeat;
  const writePrimer =
    input.writePrimer ??
    ((dir: string) => void upsertPrimer(dir, renderRepositoryPrimer({ team: input.team })));
  const taken = [...input.roster];
  const out: ConnectResult[] = [];
  for (const dir of input.repos) {
    const name = seatNameFor(dir, taken);
    taken.push(name);
    try {
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
        if (bad.length > 0) problems.push(`${id}: ${bad.map((x) => x.detail ?? x.result).join(', ')}`);
        else if (mine.length > 0 && mine.every((x) => WIRED.has(x.result))) wired.push(id);
      }
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
