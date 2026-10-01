import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin.js');

let home: string;
let bin: string;
let env: Record<string, string>;

beforeEach(() => {
  if (!existsSync(BIN))
    throw new Error(`the launcher e2e needs the built CLI at ${BIN} — run \`pnpm -r build\` first`);
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-launch-e2e-')));
  const ws = join(home, 'musterd', 'acme', 'proj', 'ada');
  mkdirSync(join(ws, '.musterd'), { recursive: true });
  writeFileSync(
    join(ws, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:9',
      team: 'acme',
      claim: { mode: 'seat', name: 'ada' },
      agent_key: 'mskey_E2E',
    }),
  );
  // A fake `claude`: answers --version (so the resolver accepts it), then exits 7 with its cwd on stdout.
  bin = join(home, 'bin');
  mkdirSync(bin);
  const fake = join(bin, 'claude');
  writeFileSync(
    fake,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\npwd\nexit 7\n',
  );
  chmodSync(fake, 0o755);
  env = {
    ...(process.env as Record<string, string>),
    HOME: home,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    MUSTERD_CONFIG: join(home, '.musterd', 'config.json'),
    NO_COLOR: '1',
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function musterd(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('the launcher through the built binary (ADR 491)', () => {
  it('seats --json lists the seat with no credential', async () => {
    const r = await musterd(['seats', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).seats[0].address).toBe('acme/proj/ada');
    expect(containsMusterdCredential(r.stdout)).toBe(false);
  });

  it('launches the harness in the Workspace, returns its code, prints the receipt, and `-` repeats it', async () => {
    const r = await musterd(['ada']);
    expect(r.code).toBe(7);
    expect(r.stdout.trim()).toBe(join(home, 'musterd', 'acme', 'proj', 'ada'));
    expect(r.stderr).toMatch(/^✗ ada · claude · \d+s · exit 7 · musterd - to go back\n$/);
    const again = await musterd(['-']);
    expect(again.code).toBe(7);
    const file = JSON.parse(readFileSync(join(home, '.musterd', 'launcher.json'), 'utf8'));
    expect(file.last).toBe('acme/proj/ada');
  });

  it('⌃C reaches the harness, not musterd: the receipt prints and the harness code comes back', async () => {
    // A terminal sends ⌃C to the whole foreground process group; `detached` gives musterd its own.
    const ready = join(home, 'ready');
    writeFileSync(
      join(bin, 'claude'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\n' +
        `trap 'exit 130' INT\ntouch '${ready}'\nwhile :; do sleep 0.05; done\n`,
    );
    const child = spawn(process.execPath, [BIN, 'ada'], {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const closed = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(ready)).toBe(true);
    process.kill(-child.pid!, 'SIGINT');
    expect(await closed).toBe(130);
    expect(stderr).toMatch(/^✗ ada · claude · \d+s · exit 130 · musterd - to go back\n$/);
  }, 20_000);

  it('--path prints the folder for `cd "$(musterd ada --path)"`', async () => {
    const r = await musterd(['ada', '--path']);
    expect(r).toMatchObject({
      code: 0,
      stdout: `${join(home, 'musterd', 'acme', 'proj', 'ada')}\n`,
    });
  });

  it("a non-seat word keeps today's unknown-command contract", async () => {
    for (const word of ['zzz-nope', '--json', '-r']) {
      const r = await musterd([word]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`unknown command "${word.replace(/-/g, '\\-')}"`));
    }
  });

  it('piped bare `musterd` still prints help', async () => {
    const r = await musterd([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('musterd help <command>');
  });
});
