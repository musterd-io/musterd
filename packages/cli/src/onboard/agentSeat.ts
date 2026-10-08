import type { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import {
  seatFileExists,
  seatFileUnpublished,
  writeSeatFile,
  type SeatFilePublication,
} from '../roster.js';
import { provisionSeat } from './provisionSeat.js';
import type { ReconcileReport, reconcileHarnesses } from './reconcile/engine.js';
import { provisionWorkspace, type Workspace } from './workspace.js';

/**
 * Add (or reuse) an agent member and give it a provisioned, wired Workspace (ADR 065, ADR 491) —
 * the core of `musterd agent`, shared with the launcher's "set up here" and "+ new seat". The caller
 * owns identity: it passes an `http` client already acting as someone allowed to add the member.
 */
export interface AgentSeatInput {
  name: string;
  team: string;
  server: string;
  http: Pick<
    HttpClient,
    'addMember' | 'roster' | 'mintBootstrapCredential' | 'issueGrant' | 'revokeBootstrapCredential'
  >;
  harnesses: string[];
  toolkit: string;
  /** Keep a Workspace's recorded desired set / toolkit (the caller named none). */
  keepDesired?: boolean | undefined;
  keepToolkit?: boolean | undefined;
  /** The checkout the new Workspace is made from (its git root and layout group). */
  sourceDir: string;
  /** Start commit for a new branch (`resolveBaseRef`). */
  base?: string | undefined;
  /** A file-backed team's roster home: the seat file is written first (ADR 058 §5). */
  rosterHome?: string | undefined;
  role?: string | undefined;
  hue?: number | undefined;
  model?: string | undefined;
  driver?: string | undefined;
  here?: boolean | undefined;
  path?: string | undefined;
  reconcile?: typeof reconcileHarnesses | undefined;
}

export interface AgentSeatResult {
  workspace: Workspace;
  reused: boolean;
  granted: boolean;
  wiring: ReconcileReport | null;
  wiringError: string | null;
  /** ADR 547: whether the seat's file has reached a remote; null on a db-only team, outside git, or when published. */
  seatFileUnpublished: SeatFilePublication | null;
}

export async function provisionAgentSeat(input: AgentSeatInput): Promise<AgentSeatResult> {
  const { name, team, http } = input;
  const declared = {
    ...(input.role ? { role: input.role } : {}),
    ...(input.hue !== undefined ? { hue: input.hue } : {}),
  };
  // ADR 058 §5: a file-backed team's seat file is written first — but only when there is none. The
  // file is the single writer: rewriting it would drop a reused agent's role and hue, or turn a
  // human teammate's file into an agent's before the kind check below refuses the name.
  if (input.rosterHome && !seatFileExists(input.rosterHome, name))
    writeSeatFile(input.rosterHome, name, { kind: 'agent', ...declared });

  // Idempotent: an already-declared agent is reused and its Workspace (re)built. `forbidden` for a
  // sponsor provisioning the agent they created (ADR 463 §3) is not adding a member either; the
  // daemon decides at the credential mint whether this caller may provision THIS agent.
  let reused = false;
  try {
    await http.addMember(team, { name, kind: 'agent', ...declared });
  } catch (err) {
    if (!(err instanceof CliError) || (err.code !== 'conflict' && err.code !== 'forbidden'))
      throw err;
    const { members } = await http.roster(team);
    const existing = members.find((m) => m.name === name);
    if (err.code === 'forbidden' && existing?.kind !== 'agent') throw err;
    if (existing && existing.kind !== 'agent') {
      throw new CliError(
        `"${name}" already exists in "${team}" as a ${existing.kind}, not an agent — pick a different name for the agent workspace`,
        err.exitCode,
      );
    }
    reused = true;
  }

  const r = await provisionSeat({
    team,
    name,
    server: input.server,
    http,
    workspace: () =>
      provisionWorkspace(name, {
        here: input.here === true,
        team,
        cwd: input.sourceDir,
        ...(input.path ? { path: input.path } : {}),
        ...(input.base ? { base: input.base } : {}),
      }),
    wiring: {
      desired: input.harnesses,
      toolkit: input.toolkit,
      keepDesired: input.keepDesired === true,
      keepToolkit: input.keepToolkit === true,
      ...(input.reconcile ? { reconcile: input.reconcile } : {}),
    },
    model: input.model,
    driver: input.driver,
  });
  return {
    workspace: r.workspace,
    reused,
    granted: r.granted,
    wiring: r.wiring,
    wiringError: r.wiringError,
    seatFileUnpublished: input.rosterHome ? seatFileUnpublished(input.rosterHome, name) : null,
  };
}
