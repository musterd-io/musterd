import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

interface StandalonePnpmInstall {
  version: string;
  root: string;
  launcher: string;
}

function standalonePnpmInstalls(pnpmHome: string | undefined): StandalonePnpmInstall[] {
  if (!pnpmHome || !existsSync(pnpmHome)) return [];
  const installs: StandalonePnpmInstall[] = [];
  const layouts: Array<[string, string]> = [
    ['pnpm', join('bin', 'pnpm')],
    ['pnpm-exe', 'pnpm'],
  ];
  for (const [folder, launcher] of layouts) {
    const installsDir = join(pnpmHome, '.tools', folder);
    if (!existsSync(installsDir)) continue;
    for (const version of readdirSync(installsDir)) {
      const root = join(installsDir, version);
      const executable = join(root, launcher);
      if (!existsSync(executable)) continue;
      const realRoot = existingPath(root);
      const realLauncher = existingPath(executable);
      if (realRoot && realLauncher)
        installs.push({ version, root: realRoot, launcher: realLauncher });
    }
  }
  return installs;
}

function firstPnpmCommand(pathValue: string): string | undefined {
  for (const part of pathValue.split(':')) {
    if (!part) continue;
    const candidate = resolve(part, 'pnpm');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function pnpmShimTarget(pnpmPath: string): string | undefined {
  let wrapper: string;
  try {
    wrapper = readFileSync(pnpmPath, 'utf8');
  } catch {
    return undefined;
  }
  const targetLine = wrapper.match(/^# cmd-shim-target=(.+)$/m)?.[1]?.trim();
  if (targetLine) return resolve(dirname(pnpmPath), targetLine);

  const execTarget = wrapper.match(
    /^\s*exec\s+["'](\$basedir\/[^"']+)["']\s+["']\$@["']\s*$/m,
  )?.[1];
  if (!execTarget) return undefined;
  const relativeTarget = execTarget.slice('$basedir/'.length);
  if (/[\\$`\n\r;]/.test(relativeTarget)) return undefined;
  return resolve(dirname(pnpmPath), relativeTarget);
}

function pnpmGlobalHome(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const normalized = resolve(target);
  const match = normalized.match(
    /^(.*)\/global\/v\d+\/[^/]+\/node_modules\/(?:pnpm|@pnpm\/exe)\/[^/]+$/,
  );
  return match?.[1] ? (existingPath(match[1]) ?? match[1]) : undefined;
}

function pathIsUnder(path: string | undefined, root: string): boolean {
  if (!path) return false;
  const real = existingPath(path);
  if (!real) return false;
  const fromRoot = relative(root, real);
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..');
}

function standalonePnpmHome(pathValue: string, configured?: string): string | undefined {
  const explicit = configured ? existingPath(configured) : undefined;
  if (explicit) return explicit;
  const command = firstPnpmCommand(pathValue);
  const globalHome = pnpmGlobalHome(command ? pnpmShimTarget(command) : undefined);
  if (globalHome && existsSync(globalHome)) return existingPath(globalHome) ?? globalHome;
  if (command) {
    let current = dirname(command);
    while (current !== dirname(current)) {
      if (
        existsSync(join(current, '.tools', 'pnpm')) ||
        existsSync(join(current, '.tools', 'pnpm-exe'))
      ) {
        return existingPath(current) ?? current;
      }
      current = dirname(current);
    }
  }
  return undefined;
}

function standalonePnpmInstallFor(
  workspace: string,
  pnpmHome: string,
  pnpmPath: string,
): StandalonePnpmInstall | undefined {
  const installs = standalonePnpmInstalls(pnpmHome);
  if (!pathIsUnder(pnpmPath, pnpmHome)) return undefined;
  const target = pnpmShimTarget(pnpmPath);
  if (pnpmGlobalHome(target) === pnpmHome) {
    const launcher = target ? existingPath(target) : undefined;
    if (!launcher || !pathIsUnder(launcher, pnpmHome)) return undefined;
    const root = packageRootFor('pnpm', dirname(launcher));
    if (!root || !pathIsUnder(root, pnpmHome) || !pathIsUnder(launcher, root)) return undefined;
    let version = '';
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch {
      return undefined;
    }
    return { version, root, launcher };
  }
  let wrapper = '';
  if (pnpmPath) {
    try {
      wrapper = readFileSync(pnpmPath, 'utf8');
    } catch {
      // A native standalone launcher has no text wrapper; use the workspace's pinned version.
    }
  }
  let packageManager = '';
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === 'string') packageManager = pkg.packageManager;
  } catch {
    // A workspace without package.json can still use its only installed standalone version.
  }
  const wrapperTarget = wrapper.match(/\.tools\/(pnpm(?:-exe)?)\/([^/\s"'`]+)/);
  const version = wrapperTarget?.[2] ?? packageManager.match(/^pnpm@([^+]+)/)?.[1];
  if (version && wrapperTarget) {
    return installs.find(
      (install) =>
        install.version === version &&
        install.root.includes(`${sep}.tools${sep}${wrapperTarget[1]}${sep}${version}`),
    );
  }
  if (version) return installs.find((install) => install.version === version);
  return installs.length === 1 ? installs[0] : undefined;
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
  const pathValue = spec.env['PATH'] ?? process.env['PATH'] ?? '';
  const pnpmPath = firstPnpmCommand(pathValue);
  const pnpmHome = standalonePnpmHome(pathValue, spec.env['PNPM_HOME']);
  const pnpmRoot = packageRootFor('pnpm', pathValue);
  const standaloneInstall = pnpmHome
    ? pnpmPath
      ? standalonePnpmInstallFor(spec.workspace, pnpmHome, pnpmPath)
      : undefined
    : undefined;
  if (pnpmHome && pathIsUnder(pnpmPath, pnpmHome) && !standaloneInstall) {
    throw new Error('could not resolve standalone pnpm install under PNPM_HOME');
  }
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
    ...(standaloneInstall ? [standaloneInstall.root] : []),
    pnpmStore,
    corepackHome,
    workspace,
    temporary,
    standaloneInstall?.root ?? pnpmRoot,
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
  const pathValue = spec.env['PATH'] ?? process.env['PATH'] ?? '';
  const pnpmPath = firstPnpmCommand(pathValue);
  const pnpmHome = standalonePnpmHome(pathValue, spec.env['PNPM_HOME']);
  const standaloneInstall =
    pnpmHome && pnpmPath ? standalonePnpmInstallFor(spec.workspace, pnpmHome, pnpmPath) : undefined;
  if (pnpmHome && pathIsUnder(pnpmPath, pnpmHome) && !standaloneInstall) {
    throw new Error('could not resolve standalone pnpm install under PNPM_HOME');
  }
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-bash-')));
  const binDir = join(temporary, 'bin');
  mkdirSync(binDir, { mode: 0o700 });
  symlinkSync(realpathSync(process.execPath), join(binDir, 'node'));
  if (pnpmPath) {
    const launcher = standaloneInstall?.launcher ?? realpathSync(pnpmPath);
    symlinkSync(launcher, join(binDir, 'pnpm'));
  }
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
