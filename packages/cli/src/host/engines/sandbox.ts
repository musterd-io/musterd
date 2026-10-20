import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BashSandboxSpec, SandboxedChild } from './sandbox.macos.js';

export type { BashSandboxSpec, SandboxedChild } from './sandbox.macos.js';

export const GATEWAY_BASE_URL_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GROK_MODELS_BASE_URL',
  'GROK_XAI_API_BASE_URL',
] as const;

export function gatewayEnvironment(
  source: Record<string, string | undefined> = {},
): Record<string, string> {
  return Object.fromEntries(
    GATEWAY_BASE_URL_KEYS.flatMap((key) => (source[key] ? [[key, source[key]!]] : [])),
  );
}

/**
 * Corepack's cache normally lives under the host home directory, which the sandbox denies.
 * Stage pnpm's package cache into the private per-child directory, where it is mounted read-only.
 */
export function stagePnpmCorepackCache(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const pnpmSource = join(source, 'v1', 'pnpm');
  if (existsSync(pnpmSource))
    cpSync(pnpmSource, join(destination, 'v1', 'pnpm'), { recursive: true });
  const knownGood = join(source, 'lastKnownGood.json');
  if (existsSync(knownGood)) copyFileSync(knownGood, join(destination, 'lastKnownGood.json'));
}

function pnpmStorePath(env: Record<string, string | undefined>): string {
  const configured = env['npm_config_store_dir'] ?? env['PNPM_STORE_DIR'];
  const candidates = [
    configured,
    join(homedir(), 'Library/pnpm/store'),
    join(homedir(), '.local/share/pnpm/store'),
    join(homedir(), '.cache/pnpm/store'),
    join(homedir(), '.pnpm-store'),
  ].filter((path): path is string => !!path);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        // Keep looking; a stale store path is not authority to widen the sandbox.
      }
    }
  }
  return configured ?? candidates[1]!;
}

export async function spawnSandboxedBash(spec: BashSandboxSpec): Promise<SandboxedChild> {
  const store = pnpmStorePath(spec.env);
  if (process.platform === 'darwin') {
    const { spawnMacSandboxedBash } = await import('./sandbox.macos.js');
    return spawnMacSandboxedBash(spec, store);
  }
  if (process.platform === 'linux') {
    const { spawnLinuxSandboxedBash } = await import('./sandbox.linux.js');
    return spawnLinuxSandboxedBash(spec, store);
  }
  throw new Error(`resident bash sandbox is unsupported on ${process.platform}`);
}
