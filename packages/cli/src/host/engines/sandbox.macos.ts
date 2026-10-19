import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GATEWAY_BASE_URL_KEYS, gatewayEnvironment, stagePnpmCorepackCache } from './sandbox.js';

export interface BashSandboxSpec {
  workspace: string;
  command: string;
  env: Record<string, string | undefined>;
  gatewayEnv?: Record<string, string | undefined>;
}

export interface SandboxedChild {
  child: ChildProcess;
  dispose(): void;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function existingPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function packageRootFor(command: string, pathValue: string): string | undefined {
  for (const part of pathValue.split(':')) {
    if (!part) continue;
    const candidate = join(part, command);
    if (!existsSync(candidate)) continue;
    const real = existingPath(candidate);
    if (real) {
      let current = dirname(real);
      while (current !== dirname(current)) {
        if (existsSync(join(current, 'package.json'))) return current;
        current = dirname(current);
      }
      return dirname(real);
    }
  }
  return undefined;
}

function nodeLibraryRoots(nodeBinary: string, nodeInstall: string): string[] {
  const roots = [join(nodeInstall, 'lib')];
  try {
    const dependencies = execFileSync('/usr/bin/otool', ['-L', nodeBinary], { encoding: 'utf8' });
    for (const line of dependencies.split('\n').slice(1)) {
      const dependency = line.trim().split(' (')[0];
      if (!dependency) continue;
      const path = dependency.startsWith('@rpath/')
        ? join(nodeInstall, 'lib', dependency.slice('@rpath/'.length))
        : dependency;
      const root = existingPath(dirname(path));
      roots.push(dirname(path));
      if (root) roots.push(root);
    }
  } catch {
    // Some supported macOS images do not ship otool; the base runtime path remains allowed.
  }
  return roots;
}

function gatewayPorts(gatewayEnv: Record<string, string | undefined> = {}): number[] {
  const ports = new Set<number>();
  for (const key of GATEWAY_BASE_URL_KEYS) {
    const raw = gatewayEnv[key];
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('resident gateway URL is invalid');
    }
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('resident gateway must use loopback HTTP');
    }
    const port = Number(url.port || '80');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('resident gateway port is invalid');
    }
    ports.add(port);
  }
  return [...ports];
}

export function macSandboxProfile(
  spec: BashSandboxSpec,
  temporary: string,
  pnpmStore: string,
): string {
  const workspace = realpathSync(spec.workspace);
  const nodeBinary = realpathSync(process.execPath);
  const nodeInstall = dirname(dirname(nodeBinary));
  const pnpmRoot = packageRootFor('pnpm', spec.env['PATH'] ?? process.env['PATH'] ?? '');
  const corepackHome = spec.env['COREPACK_HOME'] ?? join(homedir(), '.cache/node/corepack');
  const readRoots = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/private/etc',
    '/private/var/select',
    nodeInstall,
    ...nodeLibraryRoots(nodeBinary, nodeInstall),
    pnpmStore,
    corepackHome,
    workspace,
    temporary,
    pnpmRoot,
  ].filter((path): path is string => !!path);
  const readRules = [...new Set(readRoots)].map(
    (path) => `(allow file-read* (subpath ${quote(path)}))`,
  );
  const metadataRules = [
    ...new Set(
      ['/'].concat(
        readRoots.flatMap((path) => {
          const parts = path.split('/').filter(Boolean);
          return parts.map((_part, index) => `/${parts.slice(0, index + 1).join('/')}`);
        }),
      ),
    ),
  ].map((path) => `(allow file-read-metadata (literal ${quote(path)}))`);
  const portRules = gatewayPorts(spec.gatewayEnv).map(
    (port) => `(allow network-outbound (remote ip "localhost:${String(port)}"))`,
  );
  const permitted = [
    '(allow file-read* (literal "/"))',
    '(allow file-read* (literal "/dev/null"))',
    `(allow file-read* (literal ${quote(nodeBinary)}))`,
    ...readRules,
    ...metadataRules,
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-per-user-lookup)',
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    '(allow system-socket)',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
    '(allow file-write-data (literal "/dev/dtracehelper"))',
    '(allow file-write-data (literal "/dev/tty"))',
    `(allow file-write* (subpath ${quote(workspace)}))`,
    `(allow file-write* (subpath ${quote(temporary)}))`,
    ...portRules,
    `(deny file-read* (subpath ${quote(join(workspace, '.musterd'))}))`,
    `(deny file-write* (subpath ${quote(join(workspace, '.musterd'))}))`,
    `(deny file-write* (subpath ${quote(join(workspace, '.git'))}))`,
  ];
  return ['(version 1)', '(deny default)', ...permitted].join('\n');
}

export function spawnMacSandboxedBash(spec: BashSandboxSpec, pnpmStore: string): SandboxedChild {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-bash-')));
  const binDir = join(temporary, 'bin');
  mkdirSync(binDir, { mode: 0o700 });
  symlinkSync(realpathSync(process.execPath), join(binDir, 'node'));
  const pnpmPath = (spec.env['PATH'] ?? process.env['PATH'] ?? '')
    .split(':')
    .map((part) => join(part, 'pnpm'))
    .find((path) => existsSync(path));
  if (pnpmPath) symlinkSync(realpathSync(pnpmPath), join(binDir, 'pnpm'));
  const corepackSource = spec.env['COREPACK_HOME'] ?? join(homedir(), '.cache/node/corepack');
  const corepackHome = join(temporary, 'corepack');
  stagePnpmCorepackCache(corepackSource, corepackHome);
  mkdirSync(join(temporary, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(temporary, 'tmp'), { recursive: true, mode: 0o700 });
  const sandboxSpec = { ...spec, env: { ...spec.env, COREPACK_HOME: corepackHome } };
  const profile = macSandboxProfile(sandboxSpec, temporary, pnpmStore);
  const env: Record<string, string | undefined> = {
    ...spec.env,
    ...gatewayEnvironment(spec.gatewayEnv),
    HOME: join(temporary, 'home'),
    TMPDIR: join(temporary, 'tmp'),
    XDG_CACHE_HOME: join(temporary, 'home', '.cache'),
    XDG_CONFIG_HOME: join(temporary, 'home', '.config'),
    PATH: `${binDir}:/usr/bin:/bin`,
    npm_config_store_dir: pnpmStore,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: '0',
    OPENSSL_CONF: '/dev/null',
  };
  const child = spawn(
    '/usr/bin/sandbox-exec',
    ['-p', profile, '--', '/bin/sh', '-f', '-c', spec.command],
    { cwd: spec.workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  return {
    child,
    dispose: () => rmSync(temporary, { recursive: true, force: true }),
  };
}
