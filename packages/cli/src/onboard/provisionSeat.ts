import type { Binding } from '@musterd/protocol';
import type { AuthorityProof, HttpClient } from '../client.js';
import { saveBinding, saveWorkspaceSpec } from '../config.js';
import { CliError } from '../errors.js';
import { loadProvisioning, saveProvisioning } from './manifest.js';
import { defaultHarnessContext } from './reconcile/context.js';
import { reconcileHarnesses, type ReconcileReport } from './reconcile/engine.js';
import {
  defaultRecordedToolkit,
  finishRoleEquipment,
  installMissingBuiltinRoleSkills,
} from './roleEquipment.js';
import { withRoleSkills } from './roleSkills.js';
import type { ToolkitProvisionOutcome } from './toolkitProvision.js';
import type { Workspace } from './workspace.js';

/**
 * The one seat-provisioning sequence (ADR 065 steps 2–5, extracted for ADR 463 §3; wiring per
 * ADR 491): a credential scoped to this one seat, a standing grant, the Workspace's binding, the
 * committed launch spec, the desired harness set (`provisioned.json`), and the reconcile engine's
 * wiring. `musterd agent`, a sponsor's host and the launcher all run it.
 *
 * The caller owns declaring the member, the seat file, and creating the Workspace, which arrives as
 * a factory called AFTER the mint. Any failure before the desired set is recorded revokes the minted
 * credential; after that, every step is idempotent, so running the same set-up again finishes it.
 */
export interface ProvisionSeatInput {
  team: string;
  name: string;
  server: string;
  http: Pick<HttpClient, 'mintBootstrapCredential' | 'issueGrant'> &
    Partial<Pick<HttpClient, 'revokeBootstrapCredential'>>;
  /** Collect an A2 proof for a hub-local authority operation after its unsigned attempt is refused. */
  authorityApproval?: (
    act: 'credential_mint' | 'grant_issue',
    target: string,
    payload: unknown,
  ) => Promise<AuthorityProof>;
  /** Create (or reuse) the seat's Workspace. Called once, after the credential is minted. */
  workspace: () => Workspace;
  /**
   * The harnesses this Workspace launches (the ADR 281 desired set) and its toolkit. `keepDesired` /
   * `keepToolkit`: a Workspace that already records one keeps it — a re-run that named no
   * `--harness` / `--profile` must not unwire what `init` or `harness configure` added.
   */
  wiring: {
    desired: string[];
    toolkit: string;
    keepDesired?: boolean;
    keepToolkit?: boolean;
    reconcile?: typeof reconcileHarnesses;
  };
  /**
   * Roster home and the role this call is giving the seat, when the caller has them. An omitted
   * `--profile` records the role's toolkit from here (ADR 713). Absent on a db-only team.
   */
  rosterHome?: string | undefined;
  role?: string | undefined;
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
  /**
   * The recorded toolkit's tools, provisioned into every wired harness (ADR 708): one
   * outcome per harness, empty when the toolkit names nothing to provision. Best-effort —
   * failures ride the outcome's `error`, never `wiringError` or a throw.
   */
  toolkitProvision: ToolkitProvisionOutcome[];
  /** Skill bridges written because reconcile left them absent, and missing-skill lines (ADR 713). */
  skillNotes: string[];
}

/** `pending` (selected but not installed) is NOT wired: launching it would fail at spawn. */
const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged']);

function needsAuthorityProof(err: unknown): boolean {
  return err instanceof CliError && /authority refused \(no_signature\)/.test(err.message);
}

/** Throws only when the credential cannot be minted or the Workspace cannot be made. */
export async function provisionSeat(input: ProvisionSeatInput): Promise<ProvisionSeatResult> {
  const { team, name, server, http } = input;

  // ADR 344: a credential constrained to this one seat. Mint after declaration — the server
  // validates the target against the live roster. Never fall back to a Team-wide key.
  const bootstrapMint = {
    use: 'claim_seat',
    target: name,
    label: `${input.wiring.desired[0] ?? 'musterd'}:${name}`,
  } as const;
  let mint: Awaited<ReturnType<HttpClient['mintBootstrapCredential']>>;
  try {
    mint = await http.mintBootstrapCredential(team, bootstrapMint);
  } catch (err) {
    if (!needsAuthorityProof(err) || !input.authorityApproval) throw err;
    const approval = await input.authorityApproval('credential_mint', name, {
      action: 'bootstrap_mint',
      use: bootstrapMint.use,
      target: bootstrapMint.target,
    });
    mint = await http.mintBootstrapCredential(team, { ...bootstrapMint, approval });
  }
  const agentKey = mint.agent_key;

  // A standing grant so autojoin occupies on launch instead of opening an approval (ADR 077).
  let grant: string | undefined;
  try {
    const grantBody = { scope: 'seat', target: name, lifetime: 'standing' } as const;
    try {
      grant = (await http.issueGrant(team, grantBody)).token;
    } catch (err) {
      if (!needsAuthorityProof(err) || !input.authorityApproval) throw err;
      const approval = await input.authorityApproval('grant_issue', name, grantBody);
      grant = (await http.issueGrant(team, { ...grantBody, approval })).token;
    }
  } catch {
    grant = undefined;
  }

  // Everything from here to the recorded desired set can fail after the mint (the Workspace, a
  // full disk, a corrupt `.musterd`). Any failure revokes the credential, which is then written
  // nowhere, so it cannot be left live (spec §4.7(3)). The standing grant has no revoke API.
  let ws: Workspace;
  let desired: string[];
  let toolkitName = '';
  try {
    ws = input.workspace();
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
    saveWorkspaceSpec(ws.dir, { version: 2, server, team, claim: { mode: 'seat', name } });

    // Desire BEFORE reconciliation (ADR 282): a stop right after this leaves honest intent that the
    // next `musterd wire` resumes. A re-provisioned Workspace keeps its recorded contributions. The
    // permissions floor is the engine's fragment (spec §4.7(2)), so it is ledger-owned and
    // `uninstall` can release it — nothing here writes it directly.
    const prior = loadProvisioning(ws.dir);
    const recorded = prior.kind === 'valid' ? prior.value : null;
    desired = input.wiring.keepDesired && recorded ? recorded.desired : input.wiring.desired;
    toolkitName = input.wiring.keepToolkit && recorded ? recorded.toolkit : input.wiring.toolkit;
    // `--profile` omitted and nothing recorded yet: the role file's toolkit is the equipment
    // (ADR 713). An explicit profile, or a re-run that keeps a recorded name, wins.
    if (!toolkitName && input.rosterHome) {
      toolkitName = defaultRecordedToolkit(input.rosterHome, name, ws.dir);
    }
    saveProvisioning(ws.dir, {
      version: 3,
      toolkit: toolkitName,
      desired,
      contributions: recorded?.contributions ?? {},
      provisionedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (http.revokeBootstrapCredential) {
      await http.revokeBootstrapCredential(team, mint.credential.id).catch(() => undefined);
    }
    throw err;
  }

  let wiring: ReconcileReport | null = null;
  let wiringError: string | null = null;
  const prevCwd = process.cwd();
  try {
    // Claude Code's `claude mcp` local scope is keyed by the process cwd, not ctx.worktreeRoot.
    process.chdir(ws.dir);
    // A bundled built-in the repo lacks has to be on disk before reconcile plans its bridge.
    installMissingBuiltinRoleSkills({
      workspace: ws.dir,
      rosterHome: input.rosterHome,
      seat: name,
      team,
      harnessIds: desired,
    });
    wiring = await (input.wiring.reconcile ?? reconcileHarnesses)(
      withRoleSkills(defaultHarnessContext(ws.dir, process.env, { team })),
      desired,
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

  // The role's toolkit, plus whatever was recorded, into every wired harness (ADR 708, ADR 713).
  // Best-effort: a failure is an outcome, never a failed seat. What was written is recorded
  // under the manifest's `role-tools` contribution, the key `musterd uninstall` consults.
  const equipped = await finishRoleEquipment({
    workspace: ws.dir,
    rosterHome: input.rosterHome,
    seat: name,
    team,
    harnessIds: desired,
    recorded: toolkitName,
  });

  return {
    workspace: ws,
    agentKey,
    granted: grant !== undefined,
    wiring,
    wiringError,
    toolkitProvision: equipped.outcomes,
    skillNotes: [
      ...equipped.skills.written.map((w) => `wrote role skill bridge ${w}`),
      ...equipped.skills.notes,
    ],
  };
}
