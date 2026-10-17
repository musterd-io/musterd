import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, bindingSeat, type Binding } from '@musterd/protocol';
import { resolveClaudeBin } from '../claudeBin.js';
import { resolveCodexBin } from '../codexBin.js';
import { findBinding } from '../config.js';
import { resolveGrokBin } from '../grokBin.js';
import { keychainLookup, seatKeyService } from '../keychain.js';
import { resolveMuseBin } from '../museBin.js';
import { resolveOpencodeBin } from '../opencodeBin.js';

/**
 * ADR 645 (spec 2026-10-17 §4.2): the four things a host must hold before a seat may be enrolled on
 * it, verified when the enrollment is made and never inferred at wake time. Each check names what
 * is missing; `residency on` refuses when any fails, so an enrollment row never promises a wake
 * this machine cannot serve. Mirrors what `musterd host` defers on at spawn (ADR 221: a missing
 * binary, binding or key DEFERS a wake and the act waits in silence) — the point of checking here
 * is to turn that silence into a refusal the operator sees.
 *
 * Pure: every probe is injectable, and nothing reads a credential's value — only that it exists.
 */
export const ENROLLMENT_CHECKS = [
  'harness',
  'model_credential',
  'seat_credential',
  'workspace',
] as const;
export type EnrollmentCheckName = (typeof ENROLLMENT_CHECKS)[number];

export interface EnrollmentCheck {
  name: EnrollmentCheckName;
  ok: boolean;
  /** One line: what was found, or what is missing and how to fix it. */
  detail: string;
}

export interface EnrollmentChecksInput {
  seat: string;
  harness: string;
  /** The seat's workspace on this machine (`--workspace`, else the folder run from). */
  dir: string | null;
  /** `--harness musterd` only (ADR 588): the env var naming the resident seat's API key. */
  keyEnv?: string | undefined;
  /** `binding.model ?? MUSTERD_MODEL`, the native engine's declared model (ADR 101). */
  model?: string | undefined;
}

export interface EnrollmentChecksDeps {
  resolveBin: (harness: string) => Promise<string | null | undefined>;
  exists: (p: string) => boolean;
  /** `null` when no Keychain item; the value is never read by the checks, only its presence. */
  keychain: (service: string) => Promise<string | null>;
  env: NodeJS.ProcessEnv;
  home: string;
  findBinding: (dir: string) => Binding | null;
}

/**
 * Where each login-bound harness keeps the fact that a human has logged in on this machine — a
 * file the harness writes at login, checked for existence only (ADR 442: the value never leaves
 * the harness). A provider API key in the environment is the other way each harness can run, so
 * it counts too. `null` means the harness is not login-bound (the native engine) or musterd does
 * not know its login artifact; those are reported as not checked rather than refused.
 */
export const HARNESS_LOGIN_PROBES: Record<
  string,
  { files: (home: string, env: NodeJS.ProcessEnv) => string[]; keychain?: string; envKey?: string }
> = {
  'claude-code': {
    files: (home) => [join(home, '.claude', '.credentials.json')],
    keychain: 'Claude Code-credentials',
    envKey: 'ANTHROPIC_API_KEY',
  },
  codex: { files: (home) => [join(home, '.codex', 'auth.json')], envKey: 'OPENAI_API_KEY' },
  grok: { files: (home) => [join(home, '.grok', 'auth.json')], envKey: 'XAI_API_KEY' },
  opencode: {
    files: (home, env) => [
      join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'opencode', 'auth.json'),
    ],
  },
};

/** Harness class → its wake-time binary resolver (ADR 221). The native engine needs no binary. */
const BIN_RESOLVERS: Record<string, () => Promise<string | null>> = {
  'claude-code': resolveClaudeBin,
  codex: () => resolveCodexBin(),
  grok: () => resolveGrokBin(),
  opencode: () => resolveOpencodeBin(),
  muse: () => resolveMuseBin(),
};

export const defaultEnrollmentDeps = (): EnrollmentChecksDeps => ({
  resolveBin: async (harness) => {
    const r = BIN_RESOLVERS[harness];
    return r ? r() : undefined;
  },
  exists: existsSync,
  keychain: keychainLookup,
  env: process.env,
  home: homedir(),
  findBinding: (dir) => findBinding(dir, {}),
});

export async function enrollmentChecks(
  input: EnrollmentChecksInput,
  deps: EnrollmentChecksDeps = defaultEnrollmentDeps(),
): Promise<EnrollmentCheck[]> {
  const checks: EnrollmentCheck[] = [];

  // 1. The harness binary is installed here.
  if (input.harness === 'musterd') {
    checks.push({ name: 'harness', ok: true, detail: 'native engine — no binary needed' });
  } else {
    const bin = await deps.resolveBin(input.harness);
    if (bin === undefined) {
      checks.push({
        name: 'harness',
        ok: true,
        detail: `${input.harness}: not checked (no resolver for this harness class)`,
      });
    } else if (bin) {
      checks.push({ name: 'harness', ok: true, detail: `${input.harness} at ${bin}` });
    } else {
      checks.push({
        name: 'harness',
        ok: false,
        detail:
          `no ${input.harness} binary resolves on this host — install it on PATH, or enroll the seat ` +
          `on a machine that has it`,
      });
    }
  }

  // 2. The model credential: a harness login (login-bound), or the key + model (key-bound).
  if (input.harness === 'musterd') {
    const keyEnv = input.keyEnv;
    if (!keyEnv) {
      checks.push({ name: 'model_credential', ok: false, detail: '--key-env <VAR> is required' });
    } else {
      const inEnv = Boolean(deps.env[keyEnv]);
      const inKeychain = !inEnv && (await deps.keychain(seatKeyService(keyEnv))) !== null;
      if (!inEnv && !inKeychain) {
        checks.push({
          name: 'model_credential',
          ok: false,
          detail:
            `${keyEnv} is unset in this shell and there is no Keychain item ${seatKeyService(keyEnv)} — ` +
            `security add-generic-password -s ${seatKeyService(keyEnv)} -a musterd -w (ADR 605)`,
        });
      } else if (!input.model) {
        checks.push({
          name: 'model_credential',
          ok: false,
          detail:
            'no model declared (binding.model or MUSTERD_MODEL) — a native wake never defaults one (ADR 101)',
        });
      } else {
        checks.push({
          name: 'model_credential',
          ok: true,
          detail: `${keyEnv} ${inEnv ? 'in env' : 'in Keychain'} · model ${input.model}`,
        });
      }
    }
  } else {
    const probe = HARNESS_LOGIN_PROBES[input.harness];
    if (!probe) {
      checks.push({
        name: 'model_credential',
        ok: true,
        detail: `${input.harness}: login not checked (musterd knows no login artifact for it)`,
      });
    } else {
      const file = probe.files(deps.home, deps.env).find((p) => deps.exists(p));
      const viaEnv = probe.envKey !== undefined && Boolean(deps.env[probe.envKey]);
      const viaKeychain =
        !file && !viaEnv && probe.keychain !== undefined
          ? (await deps.keychain(probe.keychain)) !== null
          : false;
      if (file || viaEnv || viaKeychain) {
        checks.push({
          name: 'model_credential',
          ok: true,
          detail: file
            ? `${input.harness} login present (${file})`
            : viaEnv
              ? `${probe.envKey} in env`
              : `${input.harness} login present (Keychain)`,
        });
      } else {
        checks.push({
          name: 'model_credential',
          ok: false,
          detail:
            `${input.harness} is not logged in on this machine (no ${probe.files(deps.home, deps.env).join(' / ')}` +
            (probe.keychain ? `, no Keychain item "${probe.keychain}"` : '') +
            (probe.envKey ? `, no ${probe.envKey})` : ')') +
            ` — log the harness in here first; a wake cannot`,
        });
      }
    }
  }

  // 4 before 3: a workspace that is gone makes the binding question moot.
  if (!input.dir) {
    checks.push({
      name: 'workspace',
      ok: false,
      detail: "no workspace — pass --workspace <the seat's folder on this machine>",
    });
    checks.push({ name: 'seat_credential', ok: false, detail: 'no workspace to hold a binding' });
    return ordered(checks);
  }
  if (!deps.exists(input.dir)) {
    checks.push({ name: 'workspace', ok: false, detail: `${input.dir} does not exist` });
    checks.push({ name: 'seat_credential', ok: false, detail: 'no workspace to hold a binding' });
    return ordered(checks);
  }
  checks.push({ name: 'workspace', ok: true, detail: input.dir });

  // 3. The seat's own credential, in that workspace's binding.
  const binding = deps.findBinding(input.dir);
  const bound = binding ? bindingSeat(binding) : undefined;
  if (!binding) {
    checks.push({
      name: 'seat_credential',
      ok: false,
      detail: `${join(input.dir, BINDING_DIR, BINDING_FILE)} is missing — provision the seat there first`,
    });
  } else if (bound !== input.seat) {
    checks.push({
      name: 'seat_credential',
      ok: false,
      detail:
        `${input.dir} is bound to ${bound ? `"${bound}"` : 'no seat'}, not "${input.seat}" — ` +
        `--workspace must be the seat's own folder`,
    });
  } else if (!(binding.seat_credential ?? binding.agent_key ?? binding.host_key)) {
    checks.push({
      name: 'seat_credential',
      ok: false,
      detail: `"${input.seat}"'s binding holds no credential — claim the seat there once`,
    });
  } else {
    checks.push({ name: 'seat_credential', ok: true, detail: `"${input.seat}" bound here` });
  }

  return ordered(checks);
}

/** The spec's order (§4.2): harness, model credential, seat credential, workspace. */
function ordered(checks: EnrollmentCheck[]): EnrollmentCheck[] {
  return [...checks].sort(
    (a, b) => ENROLLMENT_CHECKS.indexOf(a.name) - ENROLLMENT_CHECKS.indexOf(b.name),
  );
}

/** The refusal `residency on` prints: one line per failing check, in the order checked. */
export function enrollmentRefusal(checks: readonly EnrollmentCheck[], seat: string): string | null {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  return (
    `cannot enroll "${seat}" on this machine — ${failed.length} of ${ENROLLMENT_CHECKS.length} ` +
    `checks failed (ADR 645), nothing was written:\n` +
    failed.map((c) => `  ✗ ${c.name}: ${c.detail}`).join('\n')
  );
}
