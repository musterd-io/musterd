import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { HttpClient } from '../client.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { resolveBaseRef } from '../onboard/workspace.js';
import { publishSeatFileReport } from '../roster.js';
import { buildCatalog } from './catalog.js';
import type { Seat } from './store.js';

/**
 * Your own human seat's Workspace in a team and project — the identity a launcher-made seat acts
 * as, and the checkout it is made from (ADR 491 §4.7). The CLI writes only as a folder-bound
 * identity (ADR 036, ADR 442), never as one it finds in the machine config.
 */
export function actingSeat(team: string, project: string, seats: readonly Seat[]): Seat | null {
  return (
    seats.find(
      (s) => s.kind === 'human' && s.team === team && s.project === project && s.problem === null,
    ) ?? null
  );
}

export interface CreateInput {
  team: string;
  project: string;
  member: string;
  harnesses: string[];
  /** The current catalog, to find the acting seat. */
  seats: readonly Seat[];
  home?: string;
}

export interface CreateDeps {
  provision?: typeof provisionAgentSeat;
  client?: (server: string, key: string) => HttpClient;
  baseRef?: (dir: string) => string | null;
  /** Where the seat-file lines go (ADR 547/592); the launcher's own stderr by default. */
  warn?: (line: string) => void;
  /** ADR 592: publish the seat file (git add/commit/push in the roster home); tests stub it. */
  publish?: typeof publishSeatFileReport;
}

/** Set up an agent seat in `team/project` on this machine and return it, ready to launch. */
export async function createSeat(input: CreateInput, deps: CreateDeps = {}): Promise<Seat> {
  const acting = actingSeat(input.team, input.project, input.seats);
  if (!acting) {
    throw new CliError(
      `set up your own seat in ${input.team}/${input.project} first: musterd human <you>`,
      2,
    );
  }
  const b = loadBinding(acting.path);
  if (b.kind !== 'valid' || !b.value.agent_key) {
    throw new CliError(
      `${acting.path} has no usable identity — run \`musterd init --check\` there`,
      4,
    );
  }
  const config = loadConfig();
  const http = (deps.client ?? ((server: string, key: string) => new HttpClient({ server, key })))(
    b.value.server,
    b.value.agent_key,
  );
  const base = (deps.baseRef ?? resolveBaseRef)(acting.path);
  const rosterHome = config.rosterHome[input.team];
  const result = await (deps.provision ?? provisionAgentSeat)({
    name: input.member,
    team: input.team,
    server: b.value.server,
    http,
    harnesses: input.harnesses,
    toolkit: '',
    sourceDir: acting.path,
    ...(base ? { base } : {}),
    rosterHome,
  });
  // ADR 547: the seat replicates over sync but its roster entry travels by git, so a seat made here
  // is invisible to other machines until its file is pushed. ADR 592: push it now, the way `musterd
  // agent` does (lane 01M4Z6FN8W) — the warning and its fix only when that could not happen.
  const publication = (deps.publish ?? publishSeatFileReport)(input.member, rosterHome);
  const say = deps.warn ?? ((line) => process.stderr.write(`${line}\n`));
  if (publication?.ok) say(`✓ ${publication.ok}`);
  if (publication?.warn) say(`⚠ ${publication.warn[0]}\n  ${publication.warn[1]}`);
  if (result.wiringError) {
    throw new CliError(
      `set up ${input.member} at ${result.workspace.dir}, but wiring is incomplete: ${result.wiringError} — run \`musterd wire\` there`,
      1,
    );
  }
  const real = realpathSync(result.workspace.dir);
  const seat = buildCatalog({ home: input.home ?? homedir(), config }).seats.find(
    (s) => s.path === real,
  );
  if (!seat) {
    throw new CliError(
      `set up ${input.member} at ${result.workspace.dir}, but it is not in the seat catalog — run \`musterd seats\``,
      1,
    );
  }
  return seat;
}
