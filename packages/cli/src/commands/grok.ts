import { GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { resolveGrokBin } from '../grokBin.js';
import { ensureGrokSeatLeaderDir } from '../grokSeatSocket.js';
import type { LaunchPlan } from '../launcher/plan.js';
import { supervise, type SuperviseResult } from '../launcher/supervise.js';

/**
 * `musterd grok` — open this folder's Grok chat on its own leader socket (ADR 742).
 *
 * A chat that is already open does not attach. Run this in the seat folder to open
 * the one that can hear an idle push. `use_leader` is left alone, and the socket
 * is not `~/.grok/leader.sock`.
 */

/**
 * The flags `musterd grok` takes. It takes none of its own. Global flags are refused
 * here only when they are not global; `pnpm cli-flags:check` covers a flag this file reads.
 */
export const GROK_FLAGS = [] as const;

export interface GrokDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  resolveBin?: () => Promise<string | null>;
  supervise?: (plan: LaunchPlan) => Promise<SuperviseResult>;
  write?: (line: string) => void;
}

export async function grokCommand(parsed: Parsed, deps: GrokDeps = {}): Promise<number> {
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...GROK_FLAGS],
    '`musterd grok` takes no flags',
  );
  if (parsed.positionals.length > 0) {
    throw new CliError(
      'musterd grok starts this folder’s Grok chat. It takes no extra arguments.',
      2,
    );
  }
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const bin = await (deps.resolveBin ?? resolveGrokBin)();
  if (!bin) throw new CliError('Grok CLI not found (PATH + known install locations)', 1);
  const socket = ensureGrokSeatLeaderDir(cwd, env);
  (deps.write ?? ((line) => process.stderr.write(line)))(
    'starting grok with this folder’s leader socket\n',
  );
  const result = await (deps.supervise ?? supervise)({
    bin,
    args: ['--leader', '--leader-socket', socket],
    cwd,
    harness: 'grok',
    env: { GROK_LEADER_SOCKET: socket },
  });
  return result.code;
}
