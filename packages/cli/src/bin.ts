#!/usr/bin/env node
import { parseArgs, type Parsed } from './args.js';
import { COMMANDS, isCommand } from './commandTable.js';
import { CliError } from './errors.js';
import { exitAfterFlush } from './exit.js';
import { nodeVersionTooOld } from './nodeVersion.js';
import { setColorEnabled, theme } from './render/theme.js';
import { sym } from './render/ui.js';
import { cliVersion } from './version.js';

/*
 * Everything heavy loads on demand (ADR 491): a command module only when it runs, help and its
 * catalog only when help is asked for, telemetry only when an OTLP endpoint is configured, and
 * the reachability nudge and the tab title only after a command returned. `importClosure.test.ts`
 * holds this file's static import graph to that.
 */
async function main(argv: string[]): Promise<number> {
  // Honor `--no-color` before any render. NO_COLOR / non-TTY are handled by picocolors' auto-detect;
  // this is the one place the flag is wired, and every command renders through the theme seam.
  if (argv.includes('--no-color')) setColorEnabled(false);

  const command = argv[0];
  const rest = parseArgs(argv.slice(1));

  // `--version`/`-v`/`version` print the CLI version and exit (ADR 067) — checked before help so
  // `musterd --version` isn't swallowed by the help path. Allowed on Node <22 (ADR 156).
  if (
    command === 'version' ||
    command === '--version' ||
    command === '-v' ||
    rest.flags['version'] === true ||
    argv.some((a) => a === '--version' || a === '-v')
  ) {
    process.stdout.write(cliVersion() + '\n');
    return 0;
  }

  // Fail fast on Node <22 before serve/service/init can load better-sqlite3 under a bad ABI (ADR 156).
  const tooOld = nodeVersionTooOld();
  if (tooOld) {
    process.stderr.write(`${theme.err('✗')} ${tooOld}\n`);
    return 1;
  }

  // `--help`/`-h` anywhere prints usage and exits — never runs the command.
  const wantsHelp =
    !command ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    rest.flags['help'] === true ||
    argv.slice(1).some((a) => a === '--help' || a === '-h');
  if (wantsHelp) {
    const help = await import('./render/help.js');
    if (rest.flags['json'] === true) {
      process.stdout.write(help.renderHelpJson() + '\n');
      return 0;
    }
    const topic = command === 'help' ? rest.positionals[0] : undefined;
    if (topic) {
      const detail = help.renderCommandHelp(topic) ?? help.renderGroupHelp(topic);
      if (detail) {
        process.stdout.write(detail + '\n');
        return 0;
      }
      const near = help.nearestCommand(topic);
      process.stderr.write(
        `${theme.warn(sym.warn)} no command "${topic}"${near ? ` — did you mean "${near}"?` : ''}\n`,
      );
    }
    process.stdout.write(help.renderHelp({ full: rest.flags['full'] === true }) + '\n');
    return 0;
  }

  // The other word order: `musterd agent help`. `wantsCommandHelp` only ever answers yes to exactly
  // one `help` positional, so the help module loads only then.
  if (rest.positionals.length === 1 && rest.positionals[0] === 'help') {
    const { renderCommandHelp, wantsCommandHelp } = await import('./render/help.js');
    if (wantsCommandHelp(command, rest.positionals)) {
      process.stdout.write(renderCommandHelp(command)! + '\n');
      return 0;
    }
  }

  // A word that is not a command is a seat address (ADR 491 Decision 2). Commands always win, and
  // the launcher returns before the postambles: a launched session never pays for the nudge.
  if (!isCommand(command)) {
    const { launchByName } = await import('./launcher/byName.js');
    return launchByName(command, rest);
  }

  const code = await instrumentedDispatch(command, rest);
  // Agent-side reachability (ADR 046) and the seat tab title (ADR 160): best-effort postambles.
  const { reachabilityNudge } = await import('./commands/helpers.js');
  const nudge = await reachabilityNudge(command, rest);
  if (nudge) process.stderr.write(nudge + '\n');
  const { emitTerminalTitle, terminalTitleFor } = await import('./render/title.js');
  const title = terminalTitleFor(command, rest);
  if (title) emitTerminalTitle(title);
  return code;
}

/**
 * CLI telemetry (ADR 089): run the command inside a `musterd.cli.command` span when an OTLP
 * endpoint is configured — the command word only, never argv. Skipped for `serve` (the daemon owns
 * that process's telemetry), `codex-hook`, `inbox --interrupt-check`, `gate` and `trace` (each rides
 * a tool-call budget an SDK boot would blow). Both modules load only when telemetry may run.
 */
async function instrumentedDispatch(command: string, rest: Parsed): Promise<number> {
  const skip =
    command === 'serve' ||
    command === 'codex-hook' ||
    (command === 'inbox' && rest.flags['interrupt-check'] === true) ||
    command === 'gate' ||
    command === 'trace';
  if (skip) return dispatch(command, rest);
  const { startTelemetry, telemetryEnabled } = await import('@musterd/telemetry');
  if (!telemetryEnabled()) return dispatch(command, rest);
  const telemetry = await startTelemetry({ serviceName: 'musterd-cli' });
  const { SpanStatusCode, trace } = await import('@opentelemetry/api');
  try {
    return await trace
      .getTracer('musterd-cli')
      .startActiveSpan('musterd.cli.command', async (span) => {
        span.setAttribute('musterd.command', command);
        try {
          const code = await dispatch(command, rest);
          span.setAttribute('musterd.exit_code', code);
          span.setStatus({ code: code === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
          return code;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      });
  } finally {
    await telemetry.shutdown({ timeoutMs: 1000 });
  }
}

async function dispatch(command: string, rest: Parsed): Promise<number> {
  const load = isCommand(command) ? COMMANDS[command] : undefined;
  if (!load) {
    const { nearestCommand } = await import('./render/help.js');
    const near = nearestCommand(command);
    const suggestion = near ? ` — did you mean "${near}"?` : '';
    throw new CliError(`unknown command "${command}"${suggestion}  ·  musterd help`, 2);
  }
  const run = await load();
  return run(rest);
}

main(process.argv.slice(2))
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(`${theme.err('✗')} ${err.message}\n`);
      exitAfterFlush(err.exitCode);
      return;
    }
    process.stderr.write(`${theme.err(sym.err)} ${(err as Error).message}\n`);
    exitAfterFlush(1);
  });
