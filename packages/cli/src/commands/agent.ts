import { resolveAttestedModel } from '@musterd/protocol';
import { flagStr, type Parsed, flagHue } from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { infraTouchWarning } from '../infra-gate.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { provisionSeat } from '../onboard/provisionSeat.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { writeSeatFile } from '../roster.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd agent <name>` — one command to add an agent AND give it an isolated, ready-to-run
 * workspace (ADR 065). It (1) adds/revives the agent member on the team, (2) creates a git worktree
 * (own branch + tree) — a sibling folder outside git — (3) writes that folder's binding, and
 * (4) registers the musterd MCP server there with autojoin, for the chosen harness. Opening a session
 * of that harness in the printed folder then *is* that agent, with no binding thrash against your own
 * seat.
 *
 * `--harness <claude-code|cursor|codex|opencode|grok>` picks the harness to wire (default claude-code) — the same
 * pluggable adapters `musterd init` uses (ADR 038/085), so a Cursor or Codex user gets a genuinely
 * wired workspace, not a Claude-Code-only one. `--here` keeps the legacy single-folder behavior;
 * `--path <dir>` targets an explicit folder.
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
      'usage: musterd agent <name> [--role <label>] [--profile <profile>] [--model <id>] [--harness <claude-code|cursor|codex|opencode|grok>] [--driver <you>] [--here | --path <dir>]',
      2,
    );
  }
  // ADR 272 inc 2 — the split: `--role` is the team fact (roster label) and `--profile` is the
  // local setup (workspace provisioning); neither implies the other. Pre-rename, one flag did both.
  const role = flagStr(parsed.flags, 'role');
  const profileName = flagStr(parsed.flags, 'profile');
  // ADR 374: the seat's colour, if the creator chose one; otherwise assigned at write (file-backed)
  // or by the daemon (db-only). Validated first so a typo touches nothing.
  const hue = flagHue(parsed.flags);
  // Model attestation (ADR 101): persist a *declared* model into the seat's binding.json so the adapter
  // attests by default instead of rotting to `unknown`. `--model` wins, else the ambient env the CLI
  // runs in (MUSTERD_MODEL / ANTHROPIC_MODEL, via the shared resolver). Never a guess — undefined stays
  // honestly `unknown` (warn-never-block); the `init --check` note catches an unattested live seat.
  const model = flagStr(parsed.flags, 'model') ?? resolveAttestedModel(process.env);

  // Driver co-presence (ADR 021, activated by ADR 155 Inc 1): opt-in per workspace. `--driver <you>`
  // writes `driver` into the seat's binding.json so the adapter reports who is steering — which makes
  // the steering human read `working`/present on the roster instead of offline. `--driver` bare uses
  // the acting identity (`--as`). Absent = no driver (unchanged, warn-never-block): presence is a
  // convenience the operator grants, never inferred behind their back. Bare `--driver` names the
  // member THIS folder resolves to (ADR 442 removed `--as`).
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

  // Which harness to wire (ADR 038/085 registry — the same adapters `init` drives). Default to Claude
  // Code for back-compat; a bad id fails fast with the valid set rather than silently doing nothing.
  const harnessId = flagStr(parsed.flags, 'harness') ?? 'claude-code';
  const harness = HARNESSES.find((h) => h.id === harnessId);
  if (!harness) {
    throw new CliError(
      `unknown harness "${harnessId}" — choose one of: ${HARNESSES.map((h) => h.id).join(', ')}`,
      2,
    );
  }

  // Adding a member is an admin act — needs an active identity (binding/env/--as), like `team add`.
  const { team, http, config } = resolve(parsed.flags);

  // The warn-only infra-touch gate (ADR 227 inc 2). This verb re-provisions through
  // harness.configure, which rewrites the MACHINE-SHARED MCP entry every seat on this repo root
  // launches through (ADR 143) and reinstalls hooks — infra consequences the 01KZ9CGYGH outage
  // proved out. One added line for a non-`platform` seat (the daemon writes the audit row), then
  // proceed; every failure mode is silence, same contract as `service`/`reset`.
  const gateWarn = await (deps.infraGate ?? infraTouchWarning)('agent');
  if (gateWarn) process.stdout.write(`${theme.warn(sym.warn)} ${theme.warn(gateWarn)}\n`);

  // ADR 058 §5: write the seat file first for a file-backed team so the file stays the single writer;
  // db-only teams skip this and the daemon originates. addMember revives a soft-removed name (ADR 065).
  const home = loadConfig().rosterHome[team];
  if (home)
    writeSeatFile(home, name, {
      kind: 'agent',
      ...(role ? { role } : {}),
      ...(hue !== undefined ? { hue } : {}),
    });
  // Declare the seat (v0.3: no per-seat token — the agent claims it with the team agent key on launch).
  // Idempotent: if the seat is already declared (e.g. you ran `team add <name>` first, or re-ran this
  // command), reuse it and just (re)build the workspace instead of dead-ending on a conflict — a
  // ready-to-run workspace is the whole point of this command. Guard against reusing a *human* seat.
  let reused = false;
  try {
    await http.addMember(team, {
      name,
      kind: 'agent',
      ...(role ? { role } : {}),
      ...(hue !== undefined ? { hue } : {}),
    });
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== 'conflict') throw err;
    const { members } = await http.roster(team);
    const existing = members.find((m) => m.name === name);
    if (existing && existing.kind !== 'agent') {
      throw new CliError(
        `"${name}" already exists in "${team}" as a ${existing.kind}, not an agent — ` +
          `pick a different name for the agent workspace`,
        err.exitCode,
      );
    }
    reused = true;
  }
  // Steps 2–5 of ADR 065 — credential, grant, binding, permissions, spec, harness wiring — are one
  // shared sequence (`provisionSeat`, ADR 463 §3), so a sponsor's host provisions exactly what this
  // command does. The workspace is made after the credential is minted, as it always was.
  const here = Boolean(parsed.flags['here']);
  const {
    workspace: ws,
    granted,
    mcpError,
  } = await provisionSeat({
    team,
    name,
    server: config.server,
    harness,
    http,
    workspace: () =>
      provisionWorkspace(name, {
        here,
        team,
        ...(flagStr(parsed.flags, 'path') ? { path: flagStr(parsed.flags, 'path')! } : {}),
      }),
    model,
    driver,
    profileName,
  });

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: name,
        team,
        dir: ws.dir,
        kind: ws.kind,
        branch: ws.branch ?? null,
        harness: harness.id,
        mcpRegistered: mcpError === null,
        granted,
      }) + '\n',
    );
    return 0;
  }

  process.stdout.write(
    `${theme.ok(sym.ok)} ${reused ? 'reused' : 'added'} ${theme.memberName(name, 'agent')} ${theme.meta(`(agent${role ? `, ${role}` : ''})`)} ${reused ? 'on' : 'to'} ${team}\n`,
  );
  const where =
    ws.kind === 'worktree'
      ? `git worktree on branch ${theme.accent(ws.branch ?? '')}`
      : ws.kind === 'folder'
        ? 'folder'
        : 'this folder';
  process.stdout.write(`${theme.ok(sym.ok)} workspace ${ws.dir} ${theme.meta(`(${where})`)}\n`);

  if (mcpError === null) {
    process.stdout.write(
      success(`wired the musterd MCP server there for ${harness.label} (autojoin)`, {
        next: `open a ${harness.label} session in ${ws.dir} — it joins as ${name} automatically`,
      }) + '\n',
    );
  } else {
    // Member + workspace + binding are set up; only the harness wiring failed (e.g. the harness CLI
    // isn't installed). Point at `musterd init` in the folder, which re-runs the same harness adapter.
    process.stdout.write(
      `${theme.warn(sym.warn)} couldn't auto-register the musterd MCP server for ${harness.label} (${mcpError}).\n` +
        theme.meta(
          `  finish the wiring by running \`musterd init\` in ${ws.dir} and choosing ${harness.label} — ` +
            `the binding.json is already written, so it only needs the harness config.`,
        ) +
        '\n',
    );
  }
  return 0;
}
