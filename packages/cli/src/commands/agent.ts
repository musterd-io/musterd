import { resolveAttestedModel } from '@musterd/protocol';
import { flagStr, type Parsed, flagHue } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { infraTouchWarning } from '../infra-gate.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import {
  publishSeatFileReport,
  seatFilePath,
  seatFileUnpublished,
  seatReachLines,
} from '../roster.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd agent <name>` — one command to add an agent AND give it an isolated, ready-to-run
 * workspace (ADR 065). It (1) adds/revives the agent member on the team, (2) creates a git worktree
 * (own branch + tree) — a sibling folder outside git — (3) writes that folder's binding, and
 * (4) records the desired harness set (`provisioned.json`) and wires it through the reconcile engine
 * (ADR 491), the same engine `musterd init` and `musterd wire` drive — so the repo-shared Claude Code
 * entry keeps its launch marker (ADR 286). `musterd <name>` then launches it.
 *
 * `--harness <id[,id…]>` names the set to wire (default claude-code). `--here` keeps the legacy
 * single-folder behavior; `--path <dir>` targets an explicit folder.
 */
export async function agentCommand(
  parsed: Parsed,
  deps: {
    /** ADR 227 inc 2: the warn-only infra-touch gate (injected so tests never reach a daemon). */
    infraGate?: (verb: string) => Promise<string | null>;
  } = {},
): Promise<number> {
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd agent <name> [--role <label>] [--profile <profile>] [--model <id>] [--harness <id[,id…]>] [--driver <you>] [--here | --path <dir>] | --hosted [--json]',
      2,
    );
  }
  // ADR 272 inc 2 — the split: `--role` is the team fact (roster label) and `--profile` is the
  // local setup (the Workspace's toolkit); neither implies the other.
  const role = flagStr(parsed.flags, 'role');
  const toolkit = flagStr(parsed.flags, 'profile') ?? '';
  // ADR 374: the seat's colour, if the creator chose one. Validated first so a typo touches nothing.
  const hue = flagHue(parsed.flags);
  // Model attestation (ADR 101): a *declared* model only — `--model`, else the ambient env. Never a guess.
  const model = flagStr(parsed.flags, 'model') ?? resolveAttestedModel(process.env);

  // Driver co-presence (ADR 021/155): opt-in per Workspace. Bare `--driver` names the member THIS
  // folder resolves to (ADR 442 removed `--as`).
  let driver: string | undefined;
  const driverFlag = parsed.flags['driver'];
  if (typeof driverFlag === 'string' && driverFlag.trim()) {
    driver = driverFlag.trim();
  } else if (driverFlag === true) {
    driver = resolveRead(parsed.flags).identity?.name;
    if (!driver)
      throw new CliError(
        '`--driver` marks the human steering this seat — pass a name (`--driver <you>`), or run it ' +
          'from your own Workspace so bare `--driver` resolves to you',
        2,
      );
  }

  // The desired harness set (ADR 281 registry). A bad id fails fast with the valid set.
  const known = harnessAdapters().map((a) => a.id);
  const harnesses = (flagStr(parsed.flags, 'harness') ?? 'claude-code')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const unknown = harnesses.filter((h) => !known.includes(h));
  if (unknown.length || harnesses.length === 0) {
    throw new CliError(
      `unknown harness "${unknown.join(', ')}" — choose from: ${known.join(', ')}`,
      2,
    );
  }

  // Adding a member is an admin act — needs an active identity, like `team add`.
  const { team, http, config } = resolve(parsed.flags);

  // `--hosted` (ADR 463 §2 / ADR 647): the seat lives on a host of the sponsor's, not in a folder
  // here. The sponsored mint is the ONE path that queues a provision, and only while a host key of
  // the sponsor's has polled in the last ten minutes — so stand the host up first (the cloud-agent
  // pilot ran these the other way round on 2026-10-19 and the host polled an empty queue forever).
  // No workspace, no wiring: the host clones and wires on its own machine.
  if (parsed.flags['hosted'] === true) {
    const minted = await http.mintSponsoredAgent(team, { name, ...(role ? { role } : {}) });
    if (parsed.flags['json']) {
      process.stdout.write(
        JSON.stringify({
          team,
          member: minted.member.name,
          hosting: minted.hosting,
          host: minted.host,
          connect_url: minted.connect_url,
        }) + '\n',
      );
      return minted.hosting === 'sponsor_host' ? 0 : 1;
    }
    process.stdout.write(
      `${theme.ok(sym.ok)} added ${theme.memberName(minted.member.name, 'agent')} (agent) to ${theme.accent(team)}\n`,
    );
    if (minted.hosting === 'sponsor_host') {
      process.stdout.write(
        `${theme.ok(sym.ok)} provision queued — host ${theme.accent(minted.host ?? '?')} stands it up on its next poll\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${theme.warn(sym.warn)} ${theme.warn('nothing queued: no host of yours polled in the last 10 minutes')}\n` +
        theme.meta(
          `  start the host first (\`musterd host --cloud-provision …\`), then \`musterd team remove ${name}\` and run this again;\n`,
        ) +
        theme.meta(`  or open the connect link on the agent's machine: ${minted.connect_url}\n`),
    );
    return 1;
  }

  // The warn-only infra-touch gate (ADR 227 inc 2): wiring writes harness config other seats on this
  // repo root launch through. One added line for a non-`platform` seat, then proceed.
  const gateWarn = await (deps.infraGate ?? infraTouchWarning)('agent');
  if (gateWarn) process.stdout.write(`${theme.warn(sym.warn)} ${theme.warn(gateWarn)}\n`);

  // Member declaration, credential, grant, binding, permissions, spec, desired set and wiring are one
  // shared sequence (`provisionAgentSeat`), so this command and the launcher cannot drift.
  const rosterHome = loadConfig().rosterHome[team];
  let r: Awaited<ReturnType<typeof provisionAgentSeat>>;
  try {
    r = await provisionAgentSeat({
      name,
      team,
      server: config.server,
      http,
      harnesses,
      toolkit,
      // A re-run (the documented grant repair) that names no --harness / --profile keeps what the
      // Workspace already records, so it never unwires a harness `init` or `harness configure` added.
      keepDesired: flagStr(parsed.flags, 'harness') === undefined,
      keepToolkit: flagStr(parsed.flags, 'profile') === undefined,
      sourceDir: process.cwd(),
      rosterHome,
      role,
      hue,
      model,
      driver,
      here: parsed.flags['here'] === true,
      path: flagStr(parsed.flags, 'path'),
    });
  } catch (err) {
    // ADR 591: the seat file is written first (ADR 058 §5), so a failure past it — the credential
    // mint refused, the worktree not cut — leaves a file nobody was told to publish. On 2026-10-13
    // that file sat uncommitted for 100 minutes and held the hub's fold on every later event.
    const reach = seatReachLines(name, rosterHome, 'agent', role);
    if (reach) {
      process.stderr.write(
        `${theme.warn(sym.warn)} ${theme.warn(reach[0])}\n${theme.meta(`  ${reach[1]}`)}\n`,
      );
    }
    throw err;
  }
  const ws = r.workspace;
  // ADR 547: the seat replicates over sync but its roster entry travels by git — so publish it now
  // (ADR 592), once the seat and its workspace exist; `--no-publish` prints the lines instead. Before
  // the --json branch, so a scripted `musterd agent --json` publishes too.
  const publication = rosterHome
    ? publishSeatFileReport(name, rosterHome, { publish: parsed.flags['no-publish'] !== true })
    : null;

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        dir: ws.dir,
        kind: ws.kind,
        branch: ws.branch ?? null,
        harness: harnesses[0],
        harnesses,
        mcpRegistered: r.wiringError === null,
        granted: r.granted,
        ...(publication?.outcome ? { seat_file_published: publication.outcome } : {}),
        ...(rosterHome && seatFileUnpublished(rosterHome, name)
          ? {
              seat_file_unpublished: {
                path: seatFilePath(rosterHome, name),
                state: seatFileUnpublished(rosterHome, name),
              },
            }
          : {}),
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${r.reused ? 'reused' : 'added'} ${theme.memberName(name, 'agent')} ${theme.meta(`(agent${role ? `, ${role}` : ''})`)} ${r.reused ? 'on' : 'to'} ${team}\n`,
  );
  const where =
    ws.kind === 'worktree'
      ? `git worktree on branch ${theme.accent(ws.branch ?? '')}`
      : ws.kind === 'folder'
        ? 'folder'
        : 'this folder';
  process.stdout.write(`${theme.ok(sym.ok)} workspace ${ws.dir} ${theme.meta(`(${where})`)}\n`);
  if (publication?.ok) process.stdout.write(`${theme.ok(sym.ok)} ${publication.ok}\n`);
  if (publication?.warn)
    process.stdout.write(
      `${theme.warn(sym.warn)} ${theme.warn(publication.warn[0])}\n${theme.meta(`  ${publication.warn[1]}`)}\n`,
    );

  if (r.wiringError === null) {
    process.stdout.write(
      success(`wired the musterd MCP server there for ${harnesses.join(', ')} (autojoin)`, {
        next: `musterd ${name} — launches it there; it joins as ${name} automatically`,
      }) + '\n',
    );
  } else {
    // Member, Workspace, binding and provisioned.json are written; only the wiring is incomplete
    // (e.g. the harness CLI isn't installed). `musterd wire` resumes from the recorded desired set.
    process.stdout.write(
      `${theme.warn(sym.warn)} the harness wiring is incomplete (${r.wiringError}).\n` +
        theme.meta(
          `  finish it by running \`musterd wire\` in ${ws.dir} — the binding and provisioned.json ` +
            `are already written, so it only needs the harness config.`,
        ) +
        '\n',
    );
  }
  return 0;
}
