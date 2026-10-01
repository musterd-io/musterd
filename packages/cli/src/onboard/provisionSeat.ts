import type { Binding } from '@musterd/protocol';
import type { HttpClient } from '../client.js';
import { saveBinding, saveWorkspaceSpec } from '../config.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';
import { installSeatPermissions } from './permissions.js';
import { defaultHarnessContext } from './reconcile/context.js';
import { reconcileHarnesses, type ReconcileReport } from './reconcile/engine.js';
import { loadToolkit } from './toolkit.js';
import type { Workspace } from './workspace.js';

/**
 * The one seat-provisioning sequence (ADR 065 steps 2–5, extracted for ADR 463 §3; wiring per
 * ADR 491): a credential scoped to this one seat, a standing grant, the Workspace's binding, the
 * committed launch spec, the desired harness set (`provisioned.json`), and the reconcile engine's
 * wiring. `musterd agent`, a sponsor's host and the launcher all run it.
 *
 * The caller owns declaring the member, the seat file, and creating the Workspace, which arrives as
 * a factory called AFTER the mint. A factory that throws gets the minted credential revoked: there
 * is no other rollback, and every step is idempotent, so running the same set-up again finishes it.
 */
export interface ProvisionSeatInput {
  team: string;
  name: string;
  server: string;
  http: Pick<HttpClient, 'mintBootstrapCredential' | 'issueGrant'> &
    Partial<Pick<HttpClient, 'revokeBootstrapCredential'>>;
  /** Create (or reuse) the seat's Workspace. Called once, after the credential is minted. */
  workspace: () => Workspace;
  /** The harnesses this Workspace launches (the ADR 281 desired set) and its toolkit. */
  wiring: { desired: string[]; toolkit: string; reconcile?: typeof reconcileHarnesses };
  /** A declared model for the seat's binding (ADR 101). Never a guess. */
  model?: string | undefined;
  /** The human steering this seat, if any (ADR 155). */
  driver?: string | undefined;
}

export interface ProvisionSeatResult {
  workspace: Workspace;
  agentKey: string;
  /** Whether a standing grant was minted (best-effort — the first claim routes through approval if not). */
  granted: boolean;
  /** The reconcile report, or null when wiring threw before producing one. */
  wiring: ReconcileReport | null;
  /** Why wiring is incomplete, or null. The binding and spec are already written when this is set. */
  wiringError: string | null;
}

const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged', 'pending']);

/** Throws only when the credential cannot be minted or the Workspace cannot be made. */
export async function provisionSeat(input: ProvisionSeatInput): Promise<ProvisionSeatResult> {
  const { team, name, server, http } = input;

  // ADR 344: a credential constrained to this one seat. Mint after declaration — the server
  // validates the target against the live roster. Never fall back to a Team-wide key.
  const mint = await http.mintBootstrapCredential(team, {
    use: 'claim_seat',
    target: name,
    label: `${input.wiring.desired[0] ?? 'musterd'}:${name}`,
  });
  const agentKey = mint.agent_key;

  // A standing grant so autojoin occupies on launch instead of opening an approval (ADR 077).
  let grant: string | undefined;
  try {
    grant = (await http.issueGrant(team, { scope: 'seat', target: name, lifetime: 'standing' }))
      .token;
  } catch {
    grant = undefined;
  }

  let ws: Workspace;
  try {
    ws = input.workspace();
  } catch (err) {
    const id = (mint.credential as { id?: string } | undefined)?.id;
    if (id && http.revokeBootstrapCredential) {
      await http.revokeBootstrapCredential(team, id).catch(() => undefined);
    }
    throw err;
  }

  const binding: Binding = {
    version: 2,
    server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    // Per-Workspace, never the shared harness entry (ADR 165 inc 2).
    autojoin: true,
    ...(input.driver ? { driver: input.driver } : {}),
  };
  saveBinding(ws.dir, binding);
  // ADR 261: the permissions floor (plus the toolkit's lists) lands with the binding, so a
  // non-interactive session can write on day one. Best-effort: it never fails seat creation.
  try {
    installSeatPermissions(
      ws.dir,
      input.wiring.toolkit ? loadToolkit(ws.dir, input.wiring.toolkit) : undefined,
    );
  } catch {
    // an unknown toolkit or a broken settings file — `musterd init --check` reports it
  }
  saveWorkspaceSpec(ws.dir, { version: 2, server, team, claim: { mode: 'seat', name } });

  // Desire BEFORE reconciliation (ADR 282): a stop right after this leaves honest intent that the
  // next `musterd wire` resumes. A re-provisioned Workspace keeps its recorded contributions.
  const prior = loadProvisioning(ws.dir);
  saveProvisioning(ws.dir, {
    version: 3,
    toolkit: input.wiring.toolkit,
    desired: input.wiring.desired,
    contributions: prior.kind === 'valid' ? prior.value.contributions : {},
    provisionedAt: new Date().toISOString(),
  });

  let wiring: ReconcileReport | null = null;
  let wiringError: string | null = null;
  const prevCwd = process.cwd();
  try {
    // Claude Code's `claude mcp` local scope is keyed by the process cwd, not ctx.worktreeRoot.
    process.chdir(ws.dir);
    wiring = await (input.wiring.reconcile ?? reconcileHarnesses)(
      defaultHarnessContext(ws.dir, process.env, { team }),
      input.wiring.desired,
      { legacyRepair: false },
    );
    const bad = wiring.results.filter((r) => !WIRED.has(r.result));
    if (bad.length) {
      wiringError = bad
        .map((r) => `${r.harness}: ${r.result}${r.detail ? ` — ${r.detail}` : ''}`)
        .join('; ');
    }
  } catch (err) {
    wiringError = (err as Error).message;
  } finally {
    process.chdir(prevCwd);
  }

  return { workspace: ws, agentKey, granted: grant !== undefined, wiring, wiringError };
}
