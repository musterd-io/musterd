import { bindingSeat, type SeatToolServer, type SeatToolsPolicy } from '@musterd/protocol';
import { HttpClient } from '../../client.js';
import { readBindingAt } from '../../config.js';
import type { HarnessContext } from '../reconcile/context.js';
import { seatRolesAt } from '../roleSkills.js';
import { loadDeclaredSet } from './cache.js';
import type { DeclaredSet } from './resolve.js';

export interface WithSeatToolsDeps {
  /** Reads the team's grants; default: `GET /seat-tools` as the folder's bound seat. */
  fetch?: () => Promise<SeatToolsPolicy>;
  /** The seat's roles; default: its seat file in the team's roster home. */
  roles?: readonly string[];
  now?: number;
}

/**
 * The declared set for a bound agent seat (ADR 794). A folder with no seat binding and no set
 * already on the context is a human's folder: `undefined`, and the caller writes no complement.
 */
export async function resolveSeatDeclared(ctx: HarnessContext): Promise<DeclaredSet | undefined> {
  if (ctx.seatTools) return ctx.seatTools;
  const binding = readBindingAt(ctx.worktreeRoot);
  if (!binding || !bindingSeat(binding)) return undefined;
  return (await withSeatTools(ctx)).seatTools;
}

/**
 * The context, with the bound seat's declared tool set resolved for the adapters (ADR 794). Never
 * throws and never widens: every failure lands on the cache or on repo tools and the floor.
 */
export async function withSeatTools(
  ctx: HarnessContext,
  deps: WithSeatToolsDeps = {},
): Promise<HarnessContext> {
  const roles = deps.roles ?? safeRoles(ctx);
  const seatTools = await loadDeclaredSet({
    worktreeRoot: ctx.worktreeRoot,
    fs: ctx.fs,
    fetch: deps.fetch ?? (() => fetchAsBoundSeat(ctx.worktreeRoot)),
    roles,
    now: deps.now ?? ctx.clock.now(),
  });
  return { ...ctx, seatTools };
}

function safeRoles(ctx: HarnessContext): string[] {
  try {
    return seatRolesAt(ctx.worktreeRoot, ctx.team)?.roles ?? [];
  } catch {
    return [];
  }
}

/**
 * One read as the folder's own seat, with the session lease its hooks present (ADR 337), and no
 * per-request claim — a claim here would churn the live session's lease. Rejects when the folder
 * has no usable binding; the caller falls back to the cache.
 */
async function fetchAsBoundSeat(worktreeRoot: string): Promise<SeatToolsPolicy> {
  const binding = readBindingAt(worktreeRoot);
  const seat = binding ? bindingSeat(binding) : undefined;
  const key = binding?.seat_credential ?? binding?.agent_key;
  if (!binding?.server || !binding.team || !seat || !key) throw new Error('no seat binding');
  const http = new HttpClient({
    server: binding.server,
    team: binding.team,
    workspace: worktreeRoot,
    key,
    seat,
    ...(binding.session_lease !== undefined ? { sessionLease: binding.session_lease } : {}),
    surface: 'cli',
    claimSeatPerRequest: false,
  });
  return (await http.getSeatTools(binding.team)).seat_tools;
}

/**
 * The admin server-definition map (ADR 817). A failed or timed-out read is an empty map: this
 * function does not read a workspace file, because that file is in the seat's trust domain.
 */
export async function grantedServersFrom(
  read: () => Promise<Pick<SeatToolsPolicy, 'servers'>>,
  timeoutMs = 3_000,
): Promise<Record<string, SeatToolServer>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const policy = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('seat tools read timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return policy.servers;
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `GET /seat-tools` for `worktreeRoot`'s bound seat, or an empty map when that read fails. */
export async function fetchGrantedServers(
  worktreeRoot: string,
): Promise<Record<string, SeatToolServer>> {
  return grantedServersFrom(() => fetchAsBoundSeat(worktreeRoot));
}
