import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { NUDGE_BUDGET_MS, reachabilityNudge } from './helpers.js';

/**
 * Lane 01M3ABD9DM: the reachability nudge rides EVERY dispatched command, hook-fired `session start`
 * included, and its inbox read had no bound. With the capture itself bounded, this was the call that
 * still held a woken session's SessionStart hook until undici's 300 s header timeout.
 */
describe('reachabilityNudge against a daemon that never answers', () => {
  let server: net.Server;
  const sockets: net.Socket[] = [];
  const saved = { ...process.env };

  beforeEach(async () => {
    server = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_TEAM'] = 'dawn';
    process.env['MUSTERD_AGENT_KEY'] = 'msac_scout';
    process.env['MUSTERD_CLAIM'] = 'seat:scout';
    delete process.env['MUSTERD_NO_NUDGE'];
  });
  afterEach(async () => {
    process.env = { ...saved };
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('gives up silently inside its budget', async () => {
    const started = Date.now();
    const out = await reachabilityNudge('lanes', parseArgs([]), 200);
    expect(out).toBe('');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sockets.length).toBeGreaterThan(0); // it really did reach the stalled daemon
  });

  it('a hook-fired command (--stdin) never reads the inbox: its stderr goes to /dev/null (lane 01M5G3J54H)', async () => {
    for (const [cmd, argv] of [
      ['gate', ['check', '--stdin']],
      ['trace', ['hook', '--stdin']],
      ['session', ['start', '--stdin']],
    ] as const) {
      expect(await reachabilityNudge(cmd, parseArgs([...argv]), 200)).toBe('');
    }
    expect(sockets.length).toBe(0);
  });

  it('the production budget is a statusline-sized pause, not a hook-sized one', () => {
    expect(NUDGE_BUDGET_MS).toBeLessThanOrEqual(2_000);
  });
});
