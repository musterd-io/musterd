import {
  bindingSeat,
  type Binding,
  type ClaimPolicy,
  resolveAttestation,
  resolveAttestedModel,
  type Surface,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import { resolveWorkspace, resolveWorkspaceKey } from '@musterd/protocol/project';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { HttpClient, watchClaim } from '../client.js';
import {
  findBinding,
  loadConfig,
  rememberIdentity,
  requireUsableBinding,
  saveBinding,
  saveConfig,
  wsBase,
} from '../config.js';
import { CliError } from '../errors.js';
import { bindingRefusal, liveBindingClobber } from '../onboard/guard.js';
import {
  consumePending,
  listPendingForWorkspace,
  writeResolution,
  type PendingMarker,
} from '../onboard/pending.js';
import { setSeatGitIdentity } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { WAIT_TIMEOUT_EXIT } from './inbox.js';
import { renderMemoryLine } from './memory.js';

/** Default `musterd claim` pending-wait bound (seconds) — same window as `inbox --wait`
 *  (ADR 054/077): long enough to give an admin a real chance to approve, short enough a dropped
 *  socket can't hang a script forever. `--timeout 0` waits unbounded. */
const DEFAULT_CLAIM_TIMEOUT_S = 300;

/** What the caller asked to claim — a named seat, or the next open seat in a role pool. */
export type ClaimSeatTarget = { seat: string } | { role: string };

/**
 * `musterd claim <name>` / `--role <x>` — the v0.3 claim handshake (SPEC A.3, ADR 075). The folder's
 * harness presents the **team agent key** (`mskey_`, from `--key`/`MUSTERD_AGENT_KEY`/the binding) for
 * bootstrap, or its own claimed authority when reoccupying its bound seat; the server resolves it (a
 * role pool assigns the next free `<role>-<n>`
 * server-side) and returns the `occupied` seat — or `pending` (an admin must approve) / `refused` (with
 * a no-dead-end hint, ADR 055). The resolved seat is written into `.musterd/binding.json` as the
 * folder's standing claim policy so both the CLI and a (re)launched adapter re-occupy it. No per-seat
 * agent-seat credential and Presence lease are minted for routine HTTP authority; a grant (`msgr_`)
 * skips the approval lane.
 */

/** ms → a compact human age: 2d, 3h, 12m, 45s. Local by the same precedent as `report.ts` et al. */
function pendingAge(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec >= 86400) return `${Math.floor(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m`;
  return `${sec}s`;
}

/**
 * The flags `musterd claim` takes (lane `01M5D907S74XVT5YECNWB5VW5A`).
 *
 * A flag this command does not know takes the NEXT argument as its value and drops it, so a
 * typo silently loses an argument — the lane id, the target, the words of a message. A command
 * knows its own flags, so it refuses the ones it does not, before anything is composed. The
 * global flags every command inherits come from `GLOBAL_FLAGS`; this list is the command's own.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
/**
 * The flags `musterd claim` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const CLAIM_FLAGS = [
  '--',
  '--git-dir',
  '--porcelain',
  '--show-toplevel',
  '-c',
  'abort',
  'aborted',
  'act',
  'add',
  'all',
  'away',
  'blocking',
  'bootstrap',
  'branch',
  'canonical',
  'check',
  'check-build',
  'client',
  'close',
  'cloud-provision',
  'commit',
  'connect',
  'connection',
  'content-type',
  'credential',
  'data',
  'deferred',
  'end',
  'enroll',
  'error',
  'exec',
  'exit',
  'fetch',
  'firehose',
  'fix',
  'for',
  'from',
  'git',
  'grant',
  'harness',
  'hex',
  'hook',
  'host',
  'id',
  'ignore',
  'inbox',
  'installed',
  'interval',
  'key',
  'key-env',
  'leases',
  'limit',
  'local-session-live',
  'log',
  'ls-files',
  'main',
  'malformed',
  'members',
  'message',
  'migrate-bootstrap',
  'musterd',
  'musterd-cli',
  'musterd-host',
  'new',
  'no-gateway',
  'offline',
  'online',
  'open',
  'origin',
  'pipe',
  'pull',
  'push',
  'refresh-permissions',
  'remote',
  'repair',
  'rev-list',
  'rev-parse',
  'review',
  'role',
  'roster',
  'session',
  'sha256',
  'skipped',
  'sponsor',
  'sqlite3',
  'status',
  'surface',
  'timeout',
  'until',
  'until-lane',
  'until-reply',
  'utf8',
  'waiting',
  'workspace',
] as const;

export async function claimCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...CLAIM_FLAGS],
    'the flags `musterd claim` takes are listed by `musterd help claim`',
  );
  // A FIRST binding never sits above a Workspace (reach spec §6, ADR 442). A folder already bound
  // is left to the clobber guard below — this is the layout rule, not a re-claim rule — so the
  // pre-migration `~/agents` (bound, with worktrees beneath) still re-claims until lane 3 moves it.
  if (!findBinding(process.cwd(), {})) {
    const refusal = bindingRefusal(process.cwd());
    if (refusal) throw new CliError(`claim refused: ${refusal.reason}`, 2);
  }
  const flags = parsed.flags;
  const config = loadConfig();
  // Strict read (ADR 281/282): claim consumes the binding AS identity (key, grant, claim target),
  // so a legacy/invalid one refuses with the configure repair instead of claiming as someone else.
  const binding = requireUsableBinding();
  const server =
    flagStr(flags, 'server') ?? process.env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;
  const team =
    flagStr(flags, 'team') ?? process.env['MUSTERD_TEAM'] ?? binding?.team ?? config.current;
  if (!team) {
    throw new CliError('no team — run init, or pass --team <slug>', 2);
  }

  // Bootstrap claims present the team agent key. A reoccupy of this binding's exact seat may present
  // its claimed agent credential; never use that credential to target a different member.
  const agentKey =
    flagStr(flags, 'key') ??
    process.env['MUSTERD_AGENT_KEY'] ??
    binding?.agent_key ??
    // The ADR 059 vault: a fresh folder claiming a seat this machine has held before needs no key
    // pasted — the legacy alias supplied the same fallback, so retiring it at FEATURE_EPOCH 20
    // loses nothing.
    (parsed.positionals[0]
      ? config.knownIdentities.find((i) => i.team === team && i.name === parsed.positionals[0])?.key
      : undefined);
  const grant = flagStr(flags, 'grant') ?? process.env['MUSTERD_GRANT'] ?? binding?.grant;
  const target = resolveTarget(parsed, binding);
  const boundSeat = binding ? bindingSeat(binding) : undefined;
  const bootstrapAdoption = flags['bootstrap'] === true;
  if (
    bootstrapAdoption &&
    (!parsed.positionals[0] ||
      'role' in target ||
      boundSeat === undefined ||
      target.seat !== boundSeat)
  ) {
    const command = boundSeat
      ? `musterd claim ${boundSeat} --bootstrap`
      : 'musterd claim <seat> --bootstrap';
    throw new CliError(
      `--bootstrap requires the explicit seat name from this Workspace binding: ${command}`,
      2,
    );
  }
  const reoccupyingBoundSeat =
    'seat' in target && boundSeat !== undefined && target.seat === boundSeat;
  const claimKey = bootstrapAdoption
    ? binding?.agent_key
    : ((reoccupyingBoundSeat ? binding?.seat_credential : undefined) ?? agentKey);
  if (!claimKey) {
    throw new CliError(
      'no agent authority — bootstrap claiming needs a team agent key; reconnecting needs this ' +
        'workspace’s agent-seat credential.',
      4,
    );
  }
  // A CLI claim is intrinsically `cli` (ADR 286) — identity files no longer declare a surface.
  // `--surface` stays a deliberate manual override (headless/testing), never a stored default.
  const surface = (flagStr(flags, 'surface') ?? 'cli') as Surface;

  const http = new HttpClient({ server, surface });
  // A hosted team serves no roster to an anonymous caller (cloud: a credential for the team on every
  // read), so a fresh folder claiming on `<slug>.musterd.dev` presents the credential it will claim
  // with. A bootstrap key (`mskey_`) is left off: the server refuses it on routine reads ("a bootstrap
  // key only claims a seat"), and a self-hosted roster is public on loopback anyway.
  const readKey = claimKey.startsWith(TOKEN_PREFIXES.agent_key) ? undefined : claimKey;
  let members: Awaited<ReturnType<HttpClient['roster']>>['members'];
  try {
    ({ members } = await new HttpClient({
      server,
      surface,
      ...(readKey ? { key: readKey } : {}),
    }).roster(team));
  } catch (err) {
    // A folder holding only a bootstrap key on a hosted team can read nothing before it claims: the
    // anonymous read is refused and the key itself is refused on routine calls. The read only feeds
    // the "already live here" shortcut and the clobber guard, and the claim itself still runs the
    // server's checks — so an unauthorized read with no credential to offer is an empty roster, not a
    // refusal to claim (cloud-agent canary 2026-10-20: `musterd claim` from a provisioned seat's own
    // workspace died in this preflight with "missing bearer token").
    if (!(readKey === undefined && err instanceof CliError && err.code === 'unauthorized'))
      throw err;
    members = [];
  }
  const workspace = resolveWorkspace();

  // Consolidated self-service (ADR 087): a bare `musterd claim` (no seat/role given) in a folder whose
  // bound seat is already live *in this workspace* is a "who am I" confirmation, not a re-claim — print
  // the identity and stop, folding whoami into the one verb an agent reaches for. An explicit target, or
  // a seat that's offline or live in another workspace, still runs the claim handshake below.
  const bareClaim = !parsed.positionals[0] && flagStr(flags, 'role') === undefined;
  if (bareClaim && boundSeat) {
    const liveHere = members
      .find((m) => m.name === boundSeat)
      ?.presences.some((p) => p.status !== 'offline' && p.workspace === workspace);
    if (liveHere) {
      if (flags['json']) {
        process.stdout.write(
          JSON.stringify({ team, member: boundSeat, live: true, already: true }) + '\n',
        );
      } else {
        process.stdout.write(
          `${theme.ok('✓')} ${theme.memberName(boundSeat, 'agent')} — already live on ${theme.accent(team)} ` +
            `in this folder ${theme.dim(`(${surface})`)}\n`,
        );
      }
      return 0;
    }
  }

  // ADR 066 clobber guard (amended by ADR 105). Claiming a *different* seat into a folder silently
  // repoints its binding — fine for a stale/offline seat, a collision when the bound member is live *or
  // held within its reclaim grace* (a reservation that may be reconnecting). Refuse and point at the
  // isolated-workspace path; --force repoints anyway. Checked before the claim, so a refusal is clean.
  const guardTarget = 'seat' in target ? target.seat : null;
  const clobber = liveBindingClobber(binding, members, guardTarget);
  if (clobber && !flags['force']) {
    const status = clobber.reclaimable
      ? `disconnected moments ago and may be reconnecting (within its reclaim grace)`
      : `live right now${clobber.workspace ? ` (live in ${clobber.workspace})` : ''}`;
    throw new CliError(
      `this folder is already bound to ${clobber.member}, who is ${status} — ` +
        `claiming here would evict them and point both sessions at one working tree. ` +
        `Give the new agent its own workspace instead: musterd agent <name> ` +
        `(adds the seat + a git worktree + binding), or run this claim from a separate worktree. ` +
        `Re-run with --force to repoint this folder anyway.`,
      2,
    );
  }

  // `--detach` (ADR 377 increment 1) preserves the predecessor's one-shot HTTP claim behavior. It
  // occupies the seat, binds the folder and EXITS, leaving a Presence with no session lease — so the
  // seat stays present, on the surface named here, after the process is gone (until PRESENCE_TIMEOUT
  // reaps it). The default WS handshake below holds the Presence through a session lease that dies
  // with the process (ADR 337). The fold made a difference visible that the ADR's "byte-for-byte"
  // line missed: fixtures and scripts that want a room to STAY occupied (scripts/a11y) need this
  // path, and it is now a flag on the one verb rather than a second verb's hidden behaviour.
  if (flags['detach']) {
    return detachedClaim({
      http,
      config,
      server,
      team,
      key: claimKey,
      // The key the binding TRACES under, kept apart from the key this claim authenticates with:
      // on a re-occupy `claimKey` is the seat credential, and writing that as `agent_key` moved
      // `sessionDigest(agent_key, session_id)` mid-session (lane 01M3NNJQV1).
      agentKey,
      target,
      surface,
      grant,
      json: Boolean(flags['json']),
    });
  }

  // Disambiguate which pending session (if any) this claim is for. Informational + lets `--for`
  // scope the marker that gets cleared; the resolved seat is delivered via the resolution sidecar.
  // Scope to *this* workspace so a marker written by a sibling launch sharing the same `.musterd`
  // (or a pre-fix leaked global marker) can't trip the multi-pending guard on an unrelated claim.
  const pendings = listPendingForWorkspace(process.cwd(), team, workspace);
  const forCode = flagStr(flags, 'for');
  if (!forCode && pendings.length > 1) {
    const now = Date.now();
    const list = pendings
      .map(
        (p) =>
          `  ${theme.bold(p.code)}  ${p.surface}${p.driver ? ` · driven by ${p.driver}` : ''}` +
          // The age is the whole diagnosis when this fires on junk: a marker is stamped once at
          // adapter boot and never refreshed, so a days-old one is a session that is long gone and
          // was never reaped. Without it the list reads as three equally-plausible live sessions.
          theme.meta(` · ${pendingAge(now - p.ts)} old`),
      )
      .join('\n');
    throw new CliError(
      `several unclaimed sessions are waiting here — re-run with --for <code>:\n${list}`,
      2,
    );
  }
  const marker: PendingMarker | undefined =
    (forCode ? pendings.find((p) => p.code === forCode) : pendings[0]) ?? undefined;
  if (forCode && !marker) {
    throw new CliError(`no pending session with code "${forCode}" in this folder`, 2);
  }

  const timeoutRaw = flagStr(flags, 'timeout');
  const timeoutS = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_CLAIM_TIMEOUT_S;
  if (Number.isNaN(timeoutS) || timeoutS < 0) {
    throw new CliError('--timeout must be a non-negative number of seconds', 2);
  }

  // The v0.3 claim handshake (ADR 075/077) over a live WS: `occupied`/`refused` resolve immediately,
  // same as the old one-shot HTTP mirror; `pending` (the seat is held elsewhere) now holds the socket
  // open and waits for the server-pushed terminal frame once an admin decides (`musterd requests
  // decide`) instead of dead-ending the process (the old `http.claim` one-shot mirror's fate).
  return new Promise<number>((resolveP, rejectP) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSigint);
      session.close();
      fn();
    };
    const onSigint = () => {
      finish(() =>
        rejectP(
          new CliError(
            'stopped waiting — the request is still open; approve it with ' +
              '`musterd requests decide <id> --approve` and re-run `musterd claim` once it is',
            130,
          ),
        ),
      );
    };
    process.on('SIGINT', onSigint);

    const model = resolveAttestation({
      observed: binding?.model_observed,
      env: resolveAttestedModel(process.env),
      binding: binding?.model,
    }).model;
    const session = watchClaim({
      wsUrl: wsBase(server) + '/ws',
      team,
      key: claimKey,
      target,
      surface,
      workspace,
      ...(grant !== undefined ? { grant } : {}),
      ...(model !== undefined ? { model } : {}),
      onOccupied: (
        occupiedSeat,
        _presenceId,
        resumeGrant,
        memory,
        seatCredential,
        sessionLease,
      ) => {
        const seat = occupiedSeat.name;
        // Prefer a freshly-delivered resume token (ADR 087, first approval) over any grant we claimed
        // with, so `binding.grant` carries the reusable token that re-occupies this seat silently.
        const effectiveGrant = resumeGrant ?? grant;
        const next: Binding = {
          version: 2,
          server,
          team,
          ...(agentKey !== undefined ? { agent_key: agentKey } : {}),
          ...((seatCredential ?? binding?.seat_credential)
            ? { seat_credential: seatCredential ?? binding?.seat_credential }
            : {}),
          ...(sessionLease !== undefined ? { session_lease: sessionLease } : {}),
          // Record the resolved seat as the folder's standing policy so re-launches re-occupy it.
          claim: { mode: 'seat', name: seat },
          ...(effectiveGrant !== undefined ? { grant: effectiveGrant } : {}),
          // Preserve the attested model across the rewrite (ADR 101) — a claim resolves a seat, it
          // never redeclares which model sits in it. Dropping it here reverted a provisioned seat to
          // `unknown` on the next adapter boot.
          ...(binding?.model !== undefined ? { model: binding.model } : {}),
        };
        saveBinding(process.cwd(), next);
        // ADR 197: re-bind refreshes the worktree git identity. Provision writes it once; without
        // this, a folder that moves to another team (or seat) keeps `seat@oldTeam.musterd`.
        setSeatGitIdentity(seat, process.cwd(), team);

        // Bring a matched waiting session online now (ADR 034): hand it the resolved seat via a
        // sidecar its watcher adopts (it already holds the team agent key), then drop the marker.
        let live = false;
        if (marker) {
          writeResolution(process.cwd(), marker.code, { seat });
          consumePending(process.cwd(), marker.code);
          live = true;
        }

        finish(() => {
          if (flags['json']) {
            process.stdout.write(JSON.stringify({ team, member: seat, live }) + '\n');
            resolveP(0);
            return;
          }
          const tail = live
            ? `the waiting ${marker!.surface} session is going online as ${seat} now.`
            : `bound this folder to ${seat}; the agent here will occupy it on launch (or call team_join).`;
          // The continuity one-liner (ADR 093 §3): headline + age, never the body.
          const memLine = memory ? `${renderMemoryLine(memory)}\n` : '';
          process.stdout.write(
            `${theme.ok('✓')} ${theme.memberName(seat, 'agent')} — occupied on ${team}\n` +
              `${theme.dim(tail)}\n` +
              memLine,
          );
          resolveP(0);
        });
      },
      onRefused: (code, message, claimable, hint) => {
        finish(() => {
          const tail = hint ? ` — ${hint}` : '';
          rejectP(new CliError(`claim refused (${code}): ${message}${tail}`, 4));
        });
      },
      onPending: (requestId, message) => {
        if (flags['json']) {
          process.stdout.write(JSON.stringify({ team, pending: true, request: requestId }) + '\n');
        } else {
          process.stdout.write(
            `${theme.meta('⧖')} ${message}\n` +
              theme.dim(
                `waiting for an admin to approve (request ${requestId}) — have an admin run ` +
                  `\`musterd requests decide ${requestId} --approve\`; ^C to stop waiting.`,
              ) +
              '\n',
          );
        }
        if (timeoutS > 0) {
          timer = setTimeout(() => {
            finish(() =>
              rejectP(
                new CliError(
                  `still waiting on request ${requestId} after ${timeoutS}s — check ` +
                    '`musterd requests` and re-run `musterd claim` once it is approved',
                  WAIT_TIMEOUT_EXIT,
                ),
              ),
            );
          }, timeoutS * 1000);
        }
      },
      onDeliver: () => {},
      onError: (msg) => {
        finish(() => rejectP(new CliError(`claim failed: ${msg}`, 1)));
      },
    });
  });
}

function resolveTarget(parsed: Parsed, binding: Binding | null): ClaimSeatTarget {
  const name = parsed.positionals[0];
  const role = flagStr(parsed.flags, 'role');
  if (name && role) {
    throw new CliError('pass a seat name or --role <x>, not both', 2);
  }
  if (name) return { seat: name };
  if (role) return { role };
  // No explicit target → fall back to the folder claim policy (ADR 018 ladder), if any.
  const policy = bindingPolicy(parsed, binding);
  if (policy.mode === 'seat') return { seat: policy.name };
  if (policy.mode === 'role') return { role: policy.role };
  throw new CliError(
    'name the seat to claim: `musterd claim <name>` or `musterd claim --role <role>`',
    2,
  );
}

function bindingPolicy(_parsed: Parsed, binding: Binding | null): ClaimPolicy {
  return binding?.claim ?? { mode: 'chat' };
}

/**
 * The one-shot HTTP claim (`POST /teams/<slug>/claim`): resolve now, bind the folder, remember the
 * identity in the ADR 059 vault, and return — no socket held, no lease. `pending` is reported and
 * left for an admin; the caller re-runs once approved (it does not block the way the WS path does).
 */
async function detachedClaim(input: {
  http: HttpClient;
  config: ReturnType<typeof loadConfig>;
  server: string;
  team: string;
  key: string;
  /** The team agent key the binding keeps as `agent_key`; `key` may be the seat credential. */
  agentKey: string | undefined;
  target: ClaimSeatTarget;
  surface: Surface;
  grant: string | undefined;
  json: boolean;
}): Promise<number> {
  const { http, config, server, team, key, agentKey, target, surface, grant, json } = input;
  const outcome = await http.claim(team, {
    key,
    target,
    surface,
    // The detached Presence names where it is, and is protected by that name (ADR 014/092/368):
    // without these the server attached `workspace: null` and evicted this folder's own live
    // session on every re-claim.
    workspace: resolveWorkspace(),
    workspaceKey: resolveWorkspaceKey(),
    ...(grant !== undefined ? { grant } : {}),
  });
  if (outcome.state === 'refused') {
    const tail = outcome.hint ? ` — ${outcome.hint}` : '';
    throw new CliError(`claim refused (${outcome.code}): ${outcome.message}${tail}`, 4);
  }
  if (outcome.state === 'pending') {
    if (json) {
      process.stdout.write(
        JSON.stringify({ team, pending: true, request: outcome.requestId }) + '\n',
      );
    } else {
      process.stdout.write(
        `${theme.meta('⧖')} ${outcome.message} ${theme.meta(`(request ${outcome.requestId}) — approve, then re-run musterd claim`)}\n`,
      );
    }
    return 0;
  }
  const seat = outcome.seat.name;

  config.server = server;
  config.current = team;
  // The identity carries the surface: every later act from this config goes out on it, which is what
  // lets a detached seat render as its harness rather than falling back to `cli`.
  config.identities[team] = { name: seat, key, surface };
  rememberIdentity(config, { team, name: seat, key, surface }); // ADR 059 vault
  saveConfig(config);
  // `agent_key` is the TEAM key the seat traces under (`sessionDigest`), never the credential this
  // claim happened to present: a re-occupy claims with `seat_credential`, and writing that here
  // split one Claude Code session into two digests at the minute of the claim (ryder
  // 27f7954d → b7bed855, 2026-09-28 20:50:54) and re-tailed its whole transcript under the new
  // one. The credential rides beside it (`saveBinding` carries the on-disk one forward).
  // A seat's FIRST claim is the one time the server hands out its seat credential (`credential_hash`
  // null → minted); every later claim returns none. The attached path saves it; this path dropped it
  // and relied on `saveBinding` carrying one forward from disk — so a first claim made with
  // `--detach` left a binding that could only ever present the bootstrap key, and every routine
  // call after it was refused "a bootstrap key only claims a seat" (hosted canary-6, 2026-10-20).
  const binding: Binding = {
    version: 2,
    server,
    team,
    agent_key: agentKey ?? key,
    claim: { mode: 'seat', name: seat },
    ...(outcome.seatCredential !== undefined ? { seat_credential: outcome.seatCredential } : {}),
    ...(grant !== undefined ? { grant } : {}),
  };
  saveBinding(process.cwd(), binding);
  // ADR 197: agents get the seat git identity; humans keep their real email (same gate as doctor).
  if (key.startsWith(TOKEN_PREFIXES.agent_key)) {
    setSeatGitIdentity(seat, process.cwd(), team);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ team, member: seat, surface, detached: true }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`${theme.memberName(seat, 'agent')} — occupied on ${team}`, { next: 'musterd next' }) +
      '\n',
  );
  process.stdout.write(
    `${theme.presenceDot('online')} ${theme.meta(`${seat} online via ${surface} (detached — no session held)`)}\n`,
  );
  return 0;
}
