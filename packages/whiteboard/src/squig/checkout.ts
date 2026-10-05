/**
 * Where Squig lives on this machine (ADR 524). Squig publishes no npm package: it runs from a
 * local checkout — `SQUIG_CHECKOUT`, else `~/.squig/src` — built with `pnpm build:local`, which
 * writes the local editor bundle the companion serves. No checkout, no build, or a Node too old
 * for `--experimental-strip-types` means the service falls back to tldraw and says why.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SquigCheckout {
  root: string;
  entry: string;
  loader: string;
  node: string;
}

export type CheckoutProbe = { ok: true; checkout: SquigCheckout } | { ok: false; reason: string };

/** Squig's scripts run under `--experimental-strip-types`, which needs Node 22.6 or newer. */
export function nodeSupportsSquig(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => parseInt(n, 10));
  return major > 22 || (major === 22 && minor >= 6);
}

export function probeSquigCheckout(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
  node: { execPath: string; version: string } = {
    execPath: process.execPath,
    version: process.versions.node,
  },
): CheckoutProbe {
  const dirs = env['SQUIG_CHECKOUT'] ? [env['SQUIG_CHECKOUT']] : [join(home, '.squig', 'src')];
  for (const dir of dirs) {
    const root = resolve(dir);
    const entry = join(root, 'scripts', 'squig.ts');
    const loader = join(root, 'scripts', 'register-loader.mjs');
    if (!exists(entry) || !exists(loader)) continue;
    if (!exists(join(root, 'out', '.squig-local-editor.json'))) {
      return {
        ok: false,
        reason: `Squig checkout at ${root} has no local editor build — run \`pnpm build:local\` there`,
      };
    }
    if (!nodeSupportsSquig(node.version)) {
      return {
        ok: false,
        reason: `Squig needs Node 22.6 or newer; the whiteboard service runs Node ${node.version}`,
      };
    }
    return { ok: true, checkout: { root, entry, loader, node: node.execPath } };
  }
  return {
    ok: false,
    reason: `no Squig checkout at ${dirs.map((d) => resolve(d)).join(' or ')} (set SQUIG_CHECKOUT, or clone Squig into ~/.squig/src and run \`pnpm build:local\`)`,
  };
}
