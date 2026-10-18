import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { GATEWAY_BASE_URL_KEYS, gatewayEnvironment, stagePnpmCorepackCache } from './sandbox.js';
import type { BashSandboxSpec, SandboxedChild } from './sandbox.macos.js';

function pathCommand(name: string, pathValue: string): string | undefined {
  for (const part of pathValue.split(':')) {
    if (!part) continue;
    const candidate = join(part, name);
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        // A broken PATH entry is not a sandbox permission.
      }
    }
  }
  return undefined;
}

function packageRoot(file: string): string {
  let current = dirname(file);
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    current = dirname(current);
  }
  return dirname(file);
}

function gatewayPort(env: Record<string, string | undefined> = {}): number | undefined {
  const ports = new Set<number>();
  for (const key of GATEWAY_BASE_URL_KEYS) {
    const raw = env[key];
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
  if (ports.size > 1) throw new Error('resident gateway URLs must share one loopback port');
  return [...ports][0];
}

function forward(socket: import('node:net').Socket, upstream: import('node:net').Socket): void {
  socket.pipe(upstream);
  upstream.pipe(socket);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
}

const RELAY_SOURCE = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const [rawPort, socketPath, cwd, command, rawEnv] = process.argv.slice(1);
const port = Number(rawPort);
const env = JSON.parse(rawEnv);
const relay = net.createServer((client) => {
  const bridge = net.createConnection(socketPath);
  client.pipe(bridge);
  bridge.pipe(client);
  client.on('error', () => bridge.destroy());
  bridge.on('error', () => client.destroy());
});
relay.listen(port, '127.0.0.1', () => {
  const child = spawn('/bin/sh', ['-f', '-c', command], { cwd, env, stdio: 'inherit' });
  child.on('error', () => process.exit(127));
  child.on('exit', (code, signal) => {
    relay.close(() => process.exit(code ?? (signal ? 128 : 1)));
  });
});
process.on('SIGTERM', () => relay.close(() => process.exit(143)));
process.on('SIGINT', () => relay.close(() => process.exit(130)));
`;

function addDirArgs(args: string[], path: string): void {
  let current = '/';
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = current === '/' ? `/${part}` : `${current}/${part}`;
    if (current !== path && current !== '/') args.push('--dir', current);
  }
}

function bindReadOnly(args: string[], source: string, destination: string): void {
  if (existsSync(source)) args.push('--ro-bind', source, destination);
}

export async function spawnLinuxSandboxedBash(
  spec: BashSandboxSpec,
  pnpmStore: string,
): Promise<SandboxedChild> {
  const workspace = realpathSync(spec.workspace);
  const temporary = mkdtempSync(join(tmpdir(), 'musterd-bash-'));
  const relayDir = join(temporary, 'relay');
  mkdirSync(relayDir, { mode: 0o700 });
  const socketPath = join(relayDir, 'gateway.sock');
  const port = gatewayPort(spec.gatewayEnv);
  let gateway: Server | undefined;
  if (port !== undefined) {
    gateway = createServer((socket) => {
      const target = connect({ host: '127.0.0.1', port });
      forward(socket, target);
    });
    await listen(gateway, socketPath);
  }

  const pathValue = spec.env['PATH'] ?? process.env['PATH'] ?? '/usr/bin:/bin';
  const pnpm = pathCommand('pnpm', pathValue);
  const node = realpathSync(process.execPath);
  const pnpmRoot = pnpm ? packageRoot(pnpm) : undefined;
  const corepackSource = spec.env['COREPACK_HOME'] ?? join(homedir(), '.cache/node/corepack');
  const corepackHome = join(temporary, 'corepack');
  stagePnpmCorepackCache(corepackSource, corepackHome);
  const pnpmRelative = pnpm && pnpmRoot ? relative(pnpmRoot, pnpm) : undefined;
  if (pnpmRelative?.startsWith(`..${sep}`) || pnpmRelative === '..') {
    throw new Error('pnpm launcher is outside its package root');
  }
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/tmp/home',
    '--dir',
    '/runtime',
    '--ro-bind',
    node,
    '/runtime/node',
    '--ro-bind',
    '/usr',
    '/usr',
  ];
  for (const systemPath of ['/bin', '/lib', '/lib64', '/etc/ssl/certs']) {
    bindReadOnly(args, systemPath, systemPath);
  }
  addDirArgs(args, workspace);
  if (pnpmRoot && pnpm && pnpmRelative) {
    args.push('--dir', '/pnpm');
    args.push('--ro-bind', pnpmRoot, '/pnpm');
    args.push('--symlink', `/pnpm/${pnpmRelative}`, '/runtime/pnpm');
  }
  args.push('--ro-bind', realpathSync(corepackHome), '/corepack');
  if (existsSync(pnpmStore)) {
    args.push('--ro-bind', realpathSync(pnpmStore), '/pnpm-store');
  } else {
    args.push('--dir', '/pnpm-store');
    args.push('--remount-ro', '/pnpm-store');
  }
  args.push('--bind', workspace, workspace);
  const musterd = join(workspace, '.musterd');
  if (existsSync(musterd)) args.push('--tmpfs', musterd);
  const git = join(workspace, '.git');
  if (existsSync(git)) args.push('--ro-bind', git, git);
  if (gateway) {
    addDirArgs(args, '/run/musterd-gateway');
    args.push('--ro-bind', relayDir, '/run/musterd-gateway');
  }
  args.push(
    '--setenv',
    'HOME',
    '/tmp/home',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'PATH',
    '/runtime:/usr/bin:/bin',
    '--setenv',
    'npm_config_store_dir',
    '/pnpm-store',
    '--setenv',
    'COREPACK_HOME',
    '/corepack',
    '--setenv',
    'COREPACK_ENABLE_NETWORK',
    '0',
    '--setenv',
    'OPENSSL_CONF',
    '/dev/null',
    '--chdir',
    workspace,
    '--',
  );
  const childEnv = {
    ...spec.env,
    ...gatewayEnvironment(spec.gatewayEnv),
    HOME: '/tmp/home',
    TMPDIR: '/tmp',
    PATH: '/runtime:/usr/bin:/bin',
    npm_config_store_dir: '/pnpm-store',
    COREPACK_HOME: '/corepack',
    COREPACK_ENABLE_NETWORK: '0',
    OPENSSL_CONF: '/dev/null',
  };
  args.push('/runtime/node', '-e', RELAY_SOURCE);
  if (port !== undefined) {
    args.push(String(port), '/run/musterd-gateway/gateway.sock');
  } else {
    args.push('0', '/dev/null');
  }
  args.push(workspace, spec.command, JSON.stringify(childEnv));
  const child = spawn('bwrap', args, {
    cwd: workspace,
    env: { PATH: pathValue },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  return {
    child,
    dispose: () => {
      gateway?.close();
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}
