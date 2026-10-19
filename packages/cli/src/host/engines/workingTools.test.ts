import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineTool } from '../engine.js';
import { declaredScripts, preflightWorkingTool, workingTools } from './workingTools.js';

/**
 * The four working tools against a real temporary workspace: each one acts only inside it, the
 * preflight verdict matches what the tool itself refuses, and bash runs with a scrubbed
 * environment and a bounded clock.
 */

let ws: string;
let outside: string;
let tools: Record<string, EngineTool>;
let gateway: Server;
let blocked: Server;
let gatewayEnv: Record<string, string>;
const outsideSentinel = 'resident-sandbox-outside-read-marker';
const policy = { scripts: new Set(['hello', 'gateway', 'off-gateway']) };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

beforeAll(async () => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-wt-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-outside-')));
  writeFileSync(join(outside, 'host-only.txt'), outsideSentinel);
  gateway = createServer((_req, res) => res.end('gateway-marker'));
  blocked = createServer((_req, res) => res.end('off-gateway-marker'));
  const gatewayPort = await listen(gateway);
  const blockedPort = await listen(blocked);
  gatewayEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(gatewayPort)}` };
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@10.28.2',
      scripts: {
        hello: `cat ${join(outside, 'host-only.txt')}`,
        gateway:
          'node -e "fetch(process.env.ANTHROPIC_BASE_URL).then(r=>r.text()).then(console.log)"',
        'off-gateway': `BLOCKED_URL=http://127.0.0.1:${String(blockedPort)} node -e "fetch(process.env.BLOCKED_URL).then(r=>r.text()).then(console.log)"`,
      },
    }),
  );
  writeFileSync(join(ws, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  tools = Object.fromEntries(
    workingTools({
      workspace: ws,
      policy,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], SEAT_KEY: 'sk-secret' },
      gatewayEnv,
      secretEnvNames: ['SEAT_KEY'],
      bashTimeoutMs: 2_000,
    }).map((t) => [t.name, t]),
  );
});

afterAll(() => {
  gateway.close();
  blocked.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('workingTools', () => {
  it.each(['cat ?.txt', 'cat [a].txt', 'cat *.txt', 'cat {a,b}.txt'])(
    'refuses expansion at preflight and execution: %s',
    async (command) => {
      expect(preflightWorkingTool({ workspace: ws, policy }, 'bash', { command })).toMatch(
        /expansion/,
      );
      await expect(tools['bash']!.run({ command })).rejects.toThrow(/denied.*expansion/);
    },
  );

  it('keeps quoted and escaped patterns literal in the shell child', async () => {
    await expect(tools['bash']!.run({ command: String.raw`printf '%s' '*?[{'` })).resolves.toBe(
      'exit 0\n*?[{',
    );
    await expect(tools['bash']!.run({ command: String.raw`printf '%s' \*\?\[\{` })).resolves.toBe(
      'exit 0\n*?[{',
    );
  });

  it('publishes exactly read, write, edit, bash with object input schemas', () => {
    expect(Object.keys(tools)).toEqual(['read', 'write', 'edit', 'bash']);
    for (const t of Object.values(tools)) expect(t.input_schema['type']).toBe('object');
  });

  it('read returns the file, or a 1-based line window', async () => {
    await expect(tools['read']!.run({ path: 'a.txt' })).resolves.toBe('one\ntwo\nthree\nfour\n');
    await expect(tools['read']!.run({ path: 'a.txt', offset: 2, limit: 2 })).resolves.toBe(
      'two\nthree',
    );
    await expect(tools['read']!.run({ path: '../outside' })).rejects.toThrow(/denied/);
  });

  it('write creates parents inside the workspace and refuses to leave it', async () => {
    await expect(tools['write']!.run({ path: 'deep/new.txt', content: 'x' })).resolves.toMatch(
      /wrote 1 bytes/,
    );
    expect(readFileSync(join(ws, 'deep/new.txt'), 'utf8')).toBe('x');
    await expect(tools['write']!.run({ path: '/tmp/escape.txt', content: 'x' })).rejects.toThrow(
      /denied/,
    );
    await expect(tools['write']!.run({ path: '.git/config', content: 'x' })).rejects.toThrow(
      /denied/,
    );
  });

  it('edit replaces a unique occurrence, refuses ambiguity unless all, reports a miss', async () => {
    await expect(tools['edit']!.run({ path: 'a.txt', old: 'two', new: '2' })).resolves.toMatch(
      /replaced 1/,
    );
    writeFileSync(join(ws, 'b.txt'), 'x x x');
    await expect(tools['edit']!.run({ path: 'b.txt', old: 'x', new: 'y' })).rejects.toThrow(
      /occurs 3 times/,
    );
    await expect(
      tools['edit']!.run({ path: 'b.txt', old: 'x', new: 'y', all: true }),
    ).resolves.toMatch(/replaced 3/);
    await expect(tools['edit']!.run({ path: 'b.txt', old: 'zzz', new: 'y' })).rejects.toThrow(
      /not found/,
    );
  });

  it('bash runs an allowed command in the workspace with the key scrubbed from its env', async () => {
    const out = await tools['bash']!.run({ command: 'pwd && printenv && cat a.txt' });
    expect(out).toMatch(/^exit 0\n/);
    expect(out).toContain(ws);
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('one');
  });

  it('bash cannot read a host file through an allowed package script', async () => {
    const out = await tools['bash']!.run({ command: 'pnpm hello' });
    expect(out).not.toContain(outsideSentinel);
  });

  it('bash can reach the metering gateway and cannot reach another local port', async () => {
    await expect(tools['bash']!.run({ command: 'pnpm gateway' })).resolves.toContain(
      'gateway-marker',
    );
    await expect(tools['bash']!.run({ command: 'pnpm off-gateway' })).resolves.not.toContain(
      'off-gateway-marker',
    );
  });

  it('bash refuses what the policy refuses, and reports a non-zero exit', async () => {
    await expect(tools['bash']!.run({ command: 'rm -rf .' })).rejects.toThrow(/denied/);
    const out = await tools['bash']!.run({ command: 'cat does-not-exist' });
    expect(out).toMatch(/^exit 1\n/);
    expect(out).toContain('stderr:');
  });

  it('bash kills a command past the ceiling', async () => {
    // `true` is a reader; the pipeline keeps the shell busy on the ceiling side.
    const out = await tools['bash']!.run({ command: 'tail -f a.txt', timeout_ms: 1_000 });
    expect(out).toMatch(/^killed after 1000ms/);
  }, 10_000);
});

describe('preflightWorkingTool', () => {
  it('gives the same verdict the tools enforce, and leaves musterd tools alone', () => {
    const jail = { workspace: ws, policy };
    expect(preflightWorkingTool(jail, 'read', { path: 'a.txt' })).toBeUndefined();
    expect(preflightWorkingTool(jail, 'read', { path: '../x' })).toMatch(/outside/);
    expect(preflightWorkingTool(jail, 'write', { path: '.musterd/x' })).toMatch(/not writable/);
    expect(preflightWorkingTool(jail, 'bash', { command: 'pnpm hello' })).toBeUndefined();
    expect(preflightWorkingTool(jail, 'bash', { command: 'pnpm nope' })).toMatch(/declared/);
    expect(preflightWorkingTool(jail, 'bash', {})).toMatch(/non-empty/);
    expect(preflightWorkingTool(jail, 'team_next', {})).toBeUndefined();
  });
});

describe('declaredScripts', () => {
  it('reads package.json scripts, and is empty (deny-safe) when there are none', () => {
    expect([...declaredScripts(ws)]).toEqual(['hello', 'gateway', 'off-gateway']);
    expect(declaredScripts('/nowhere').size).toBe(0);
    expect(declaredScripts(ws, () => '{"scripts": 3}').size).toBe(0);
  });
});
