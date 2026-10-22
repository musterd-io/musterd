import { rmSync } from 'node:fs';
import { resolveAttestedModel } from '@musterd/protocol';
import { flagHue, flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { infraTouchWarning } from '../infra-gate.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import {
  publishSeatFileReport,
  readSeatFiles,
  seatFileExists,
  seatFilePath,
  seatFileUnpublished,
  seatReachLines,
  writeSeatFile,
} from '../roster.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * ADR 700 decision 5. The hub's `hubSeatFileWait` sentence contains this, and only this refusal
 * keeps the seat file: the sponsor publishes it and retries after the hub's next git refresh.
 * Any other refusal deletes the unpublished file.
 */
const HUB_SEAT_FILE_WAIT = "no seat file in the hub's roster root";

/**
 * Write `seats/<name>.toml` before the hosted mint, when none exists. `until` is copied from the
 * sponsor's own seat file so the file matches the expiry the mint stores from that member.
 * Returns whether this call created the file.
 */
function writeHostedSeatFile(
  home: string,
  name: string,
  sponsor: string,
  role: string | undefined,
): boolean {
  if (seatFileExists(home, name)) return false;
  const sponsorSeat = readSeatFiles(home)[sponsor];
  const expiring = sponsorSeat?.lifecycle === 'until' && sponsorSeat.until;
  writeSeatFile(home, name, {
    kind: 'agent',
    ...(role ? { role } : {}),
    sponsored_by: sponsor,
    ...(expiring ? { lifecycle: 'until' as const, until: sponsorSeat.until } : {}),
  });
  return true;
}

/** A refused hosted mint drops the unpublished file. The hub-wait refusal leaves it and says how. */
function settleHostedSeatFile(
  home: string,
  name: string,
  created: boolean,
  err: unknown,
  role: string | undefined,
): void {
  if (err instanceof CliError && err.message.includes(HUB_SEAT_FILE_WAIT)) {
    const reach = seatReachLines(name, home, 'agent', role);
    if (reach) {
      process.stderr.write(
        `${theme.warn(sym.warn)} ${theme.warn(reach[0])}\n${theme.meta(`  ${reach[1]}`)}\n`,
      );
    }
    return;
  }
  // This call's file, or an unpublished leftover from an earlier try. A file already on a remote
  // (`seatFileUnpublished` is null) stays — deleting it would unseat someone the hub can see.
  if (created || seatFileUnpublished(home, name) !== null) {
    rmSync(seatFilePath(home, name), { force: true });
  }
}

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
/**
 * The flags `musterd agent` takes (lane
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
/**
 * The flags `musterd agent` takes (lane
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
export const AGENT_FLAGS = [
  'add',
  'branch',
  'commit',
  'driver',
  'git',
  'harness',
  'host',
  'hosted',
  'hue',
  'ignore',
  'log',
  'ls-files',
  'model',
  'path',
  'pipe',
  'profile',
  'pull',
  'push',
  'rev-parse',
  'role',
] as const;

export async function agentCommand(
  parsed: Parsed,
  deps: {
    /** ADR 227 inc 2: the warn-only infra-touch gate (injected so tests never reach a daemon). */
    infraGate?: (verb: string) => Promise<string | null>;
  } = {},
): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...AGENT_FLAGS],
    'the flags `musterd agent` takes are listed by `musterd help agent`',
  );
  const name = parsed.positionals[0];
  if (!name || /\s/.test(name)) {
    throw new CliError(
      'usage: musterd agent <name> [--role <label>] [--profile <profile>] [--model <id>] [--harness <id[,id…]>] [--driver <you>] [--here | --path <dir>] | --hosted [--host <label>] [--json]',
      2,
    );
  }
  // `--role` is the team fact. `--profile` records an explicit toolkit. When `--profile` is
  // omitted and the Workspace has none yet, seat creation records the role's toolkit (ADR 713).
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
  const { team, http, config, identity } = resolve(parsed.flags);

  // `--hosted` (ADR 463 §2 / ADR 647): the seat lives on a host of the sponsor's, not in a folder
  // here. The sponsored mint is the ONE path that queues a provision, and only while a host key of
  // the sponsor's has polled in the last ten minutes — so stand the host up first (the cloud-agent
  // pilot ran these the other way round on 2026-10-19 and the host polled an empty queue forever).
  // No workspace, no wiring: the host clones and wires on its own machine.
  if (parsed.flags['hosted'] === true) {
    // `--host <label>` pins the provision to one live host of the sponsor's (lane 01M5DR34Y2);
    // without it the newest-seen host is named and any live host of the sponsor's may claim.
    const host = flagStr(parsed.flags, 'host');
    // ADR 700 decision 5: on a file-backed team the file is written first, the mint runs every
    // check it runs today, and the file is published only after that mint succeeds. A db-only
    // team has no roster home and keeps the mint-only path.
    const rosterHome = loadConfig().rosterHome[team];
    let created = false;
    if (rosterHome) {
      if (!identity?.name) {
        throw new CliError(
          'no identity in this folder — a hosted seat on a file-backed team records you as sponsored_by',
          4,
        );
      }
      created = writeHostedSeatFile(rosterHome, name, identity.name, role);
    }
    let minted: Awaited<ReturnType<typeof http.mintSponsoredAgent>>;
    try {
      minted = await http.mintSponsoredAgent(team, {
        name,
        ...(role ? { role } : {}),
        ...(host ? { host } : {}),
      });
    } catch (err) {
      if (rosterHome) settleHostedSeatFile(rosterHome, name, created, err, role);
      throw err;
    }
    const publication = rosterHome
      ? publishSeatFileReport(name, rosterHome, { publish: parsed.flags['no-publish'] !== true })
      : null;
    if (parsed.flags['json']) {
      process.stdout.write(
        JSON.stringify({
          team,
          member: minted.member.name,
          hosting: minted.hosting,
          host: minted.host,
          connect_url: minted.connect_url,
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
      return minted.hosting === 'sponsor_host' ? 0 : 1;
    }
    process.stdout.write(
      `${theme.ok(sym.ok)} added ${theme.memberName(minted.member.name, 'agent')} (agent) to ${theme.accent(team)}\n`,
    );
    if (publication?.ok) process.stdout.write(`${theme.ok(sym.ok)} ${publication.ok}\n`);
    if (publication?.warn)
      process.stdout.write(
        `${theme.warn(sym.warn)} ${theme.warn(publication.warn[0])}\n${theme.meta(`  ${publication.warn[1]}`)}\n`,
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
  // The toolkit's tools, provisioned into each wired harness (ADR 708) — named so a seat
  // that starts without its equipment is visible at creation, not discovered later.
  for (const o of r.toolkitProvision ?? []) {
    if (o.error) {
      process.stdout.write(
        `${theme.warn(sym.warn)} toolkit tools not provisioned for ${o.harness}: ${o.error}\n`,
      );
    } else if (o.servers.length > 0) {
      process.stdout.write(
        `${theme.ok(sym.ok)} provisioned toolkit tools for ${o.harness}: ${o.servers.join(', ')}${o.skipped.length ? ` (skipped: ${o.skipped.join(', ')})` : ''}\n`,
      );
    }
  }
  for (const line of r.skillNotes ?? []) {
    process.stdout.write(`${theme.warn(sym.warn)} ${line}\n`);
  }
  return 0;
}
