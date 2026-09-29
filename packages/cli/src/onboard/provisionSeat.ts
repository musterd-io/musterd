import type { Binding } from '@musterd/protocol';
import type { HttpClient } from '../client.js';
import { saveBinding, saveWorkspaceSpec } from '../config.js';
import type { Harness } from './harness.js';
import { buildEntry } from './mcpEntry.js';
import { installSeatPermissions } from './permissions.js';
import { loadToolkit } from './toolkit.js';
import type { Workspace } from './workspace.js';

/**
 * The one seat-provisioning sequence (ADR 065 steps 2–5, extracted for ADR 463 §3): a credential
 * scoped to this one seat, a standing grant, the Workspace's binding, its permissions floor, the
 * committed launch spec, and the harness's MCP wiring. `musterd agent` runs it for an admin's
 * agent; a sponsor's host runs it for a sponsored agent — one implementation, so the two cannot
 * drift on what a provisioned seat carries.
 *
 * The caller owns everything around it: declaring the member, the seat file, and creating the
 * Workspace. The Workspace arrives as a factory, called AFTER the credential is minted, so a failed
 * mint leaves no worktree behind (`musterd agent` always minted first; that order is kept).
 */
export interface ProvisionSeatInput {
  team: string;
  name: string;
  server: string;
  harness: Harness;
  http: Pick<HttpClient, 'mintBootstrapCredential' | 'issueGrant'>;
  /** Create (or reuse) the seat's Workspace. Called once, after the credential is minted. */
  workspace: () => Workspace;
  /** A declared model for the seat's binding (ADR 101). Never a guess. */
  model?: string | undefined;
  /** The human steering this seat, if any (ADR 155). */
  driver?: string | undefined;
  /** A toolkit profile whose permission lists join the floor (ADR 261). */
  profileName?: string | undefined;
}

export interface ProvisionSeatResult {
  workspace: Workspace;
  agentKey: string;
  /** Whether a standing grant was minted (best-effort — the first claim routes through approval if not). */
  granted: boolean;
  /** Why the harness wiring failed, or null. The binding is already written when this is set. */
  mcpError: string | null;
}

/**
 * Throws only when the credential cannot be minted — nothing was written then. A grant, permissions
 * or harness failure never throws: the seat still comes online, and the harness failure is reported
 * in the result so the caller can say how to finish the wiring.
 */
export async function provisionSeat(input: ProvisionSeatInput): Promise<ProvisionSeatResult> {
  const { team, name, server, harness, http } = input;

  // ADR 344: every provisioned workspace receives a credential constrained to this one seat.
  // Mint after declaration because the server validates the target against the live roster. Never
  // fall back to the ambient legacy Team-wide key: that would silently preserve its blast radius.
  // This field is the *claim* authenticator. The wake actuator authenticates with `binding.host_key`
  // (ADR 395), minted at `residency on` — a claim-scoped key cannot poll `/residency/wake-leases`.
  const agentKey = (
    await http.mintBootstrapCredential(team, {
      use: 'claim_seat',
      target: name,
      label: `${harness.id}:${name}`,
    })
  ).agent_key;

  // Mint a standing grant for the seat so the workspace's autojoin occupies immediately on launch
  // instead of opening an admin-approval request every session (ADR 077). Best-effort: if it fails
  // (e.g. the caller isn't admin), the agent still comes online — its first claim just routes through
  // the approval lane.
  let grant: string | undefined;
  try {
    const mint = await http.issueGrant(team, { scope: 'seat', target: name, lifetime: 'standing' });
    grant = mint.token;
  } catch {
    grant = undefined;
  }

  const ws = input.workspace();

  const binding: Binding = {
    version: 2,
    server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name },
    ...(grant !== undefined ? { grant } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    // Per-worktree, NOT the shared harness entry (ADR 165 inc 2): the entry is keyed by repo root
    // and shared by every sibling worktree, so autojoin/driver baked there applied family-wide —
    // `--driver nick` marked every seat on the machine as driven by nick (ADR 155 corruption).
    autojoin: true,
    ...(input.driver ? { driver: input.driver } : {}),
  };
  saveBinding(ws.dir, binding);
  // ADR 261: the permissions floor — plus the profile's lists when a profile is named — lands
  // with the binding, so a NON-INTERACTIVE session in this worktree can work on day one. Until this
  // write, a fresh seat's first Write failed closed with no way to prompt and presented as a
  // broken tool (the 2026-08-13 ryder incident). Best-effort like hook install: a permissions
  // hiccup never fails seat creation. Dir-aware — ws.dir is never cwd().
  try {
    const template = input.profileName ? loadToolkit(ws.dir, input.profileName) : undefined;
    installSeatPermissions(ws.dir, template);
  } catch {
    /* an unknown profile name or a broken settings file must not block the seat — init --check
       (ADR 261 increment 2) is the surface that reports it */
  }
  // Also write the secret-free committed launch spec (ADR: committed launch spec) so this worktree
  // self-wires via `musterd wire` on a fresh clone/machine — the key stays out of the committed file.
  saveWorkspaceSpec(ws.dir, {
    version: 2,
    server,
    team,
    claim: { mode: 'seat', name },
  });

  // Register the MCP server *for the workspace folder*. No secret is baked into any harness config —
  // binding.json stays the single source of truth (ADR 018/115) — and, critically, **we do not name the
  // binding file in the env** (ADR 143).
  //
  // We used to set `MUSTERD_BINDING=<ws.dir>/.musterd/binding.json` here, on the assumption that chdir-ing
  // into `ws.dir` scoped the registration to this worktree: "`claude mcp add -s local` keys off cwd".
  // **That assumption is false.** Claude Code keys its local scope by **repo root**, and every seat
  // worktree (`agents-miley`, `agents-dolly`, …) is a git worktree of the *same* repo — so all of them
  // share one entry, and `MUSTERD_BINDING` was a single global slot that each `musterd agent` overwrote.
  // Provisioning one seat therefore re-pointed *every live session on the machine* at that seat: on
  // 2026-07-13 they all booted as `dolly` and superseded each other off their own seats, mid-task.
  //
  // The env var was never needed here anyway: the adapter anchors on the `.musterd/binding.json` it finds
  // by walking up from its **cwd**, which the harness sets to the session's workspace — a signal that is
  // genuinely per-worktree, unlike the shared config. Omitting it makes the shared entry identical for
  // every seat, and therefore harmless. (The adapter also refuses a cross-workspace `MUSTERD_BINDING`
  // outright now — see `mcp/binding.ts` — so this can't come back through another door.)
  const agentBinding = {
    server,
    team,
    agent_key: agentKey,
    claim: { mode: 'seat', name } as const,
    ...(grant !== undefined ? { grant } : {}),
  };
  // Seat-agnostic by construction (ADR 143, completed by ADR 165 + increment 2): this entry is keyed
  // by repo root and therefore shared by every seat worktree, so it carries NOTHING — autojoin and
  // driver, the last two baked names, now live in binding.json like everything else. `buildMcpEnv`
  // is where the rule is written down and where the sharedEntry regression binds.
  const entry = buildEntry(agentBinding);
  let mcpError: string | null = null;
  const prevCwd = process.cwd();
  try {
    process.chdir(ws.dir);
    await harness.configure(entry, agentBinding);
  } catch (err) {
    mcpError = (err as Error).message;
  } finally {
    process.chdir(prevCwd);
  }

  return { workspace: ws, agentKey, granted: grant !== undefined, mcpError };
}
