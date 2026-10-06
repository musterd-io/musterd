import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, saveBinding } from '../config.js';
import { claimAgentHttp } from '../test-auth.js';
import { styleSetBy } from './policy.js';
import { parseDialPairs, styleCommand } from './style.js';
import { teamCommand } from './team.js';

/**
 * ADR 514 increment 4 — `musterd style` (a human's own dials) and `musterd team policy style` (the
 * team's floor and defaults), against a real daemon. The exact no-color frames are pinned in
 * `docs/design/figma-brief-terminal.md` (`cmd/style`, `cmd/team-policy-style`; hard rule 2): a
 * divergence fails here instead of drifting.
 */
describe('style / policy style commands (ADR 514 inc 4)', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let nick: HttpClient;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    process.env['NO_COLOR'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'musterd-style-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // `team create` auto-binds the cwd identity (ADR 036), so the commands resolve `nick` (admin).
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
    nick = new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
      seat: 'nick',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['NO_COLOR'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }
  const style = (args: string[]) => capture(() => styleCommand(parseArgs(args)));
  const policy = (args: string[]) =>
    capture(() => teamCommand(parseArgs(['policy', 'style', ...args])));

  describe('musterd style', () => {
    it('bare: every dial labelled team default, no prose, and the block a seat steered by you reads', async () => {
      const res = await style([]);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/^style — nick \(epoch [0-9a-f]{8}\)\n/);
      expect(res.out).toContain('  pushback   when-it-matters  team default\n');
      expect(res.out).toContain('  format     prose            team default\n');
      expect(res.out).toContain('  prose      none\n');
      expect(res.out).toContain('the block a seat steered by you reads:\n  Style (epoch ');
      expect(res.out).toContain('  For nick (in chat, and in any act addressed to nick)');
    });

    it('set: changes the named dials, keeps the rest, and the view labels them yours (cmd/style frame)', async () => {
      const set = await style(['set', 'length=concise', 'pushback=every-time']);
      expect(set.code).toBe(0);
      expect(set.out).toBe(
        '✓ style set — pushback every-time, length concise\n' +
          '  next: musterd style\n' +
          'your seats now read: pushback every time · plain · concise · prose\n',
      );
      const prose = await style(['set', '--prose', 'Lead with the result.']);
      expect(prose.out).toContain('✓ style set — pushback every-time, length concise, prose\n');
      const res = await style([]);
      const epoch = /epoch ([0-9a-f]{8})/.exec(res.out)![1];
      expect(res.out).toBe(
        `style — nick (epoch ${epoch})\n` +
          '  pushback   every-time       yours\n' +
          '  bluntness  plain            team default\n' +
          '  length     concise          yours\n' +
          '  format     prose            team default\n' +
          '  prose      "Lead with the result." yours\n' +
          'the block a seat steered by you reads:\n' +
          `  Style (epoch ${epoch}) — how you talk here.\n` +
          "  Floor (team): assess before you agree; no praise before a check; disagree once, with the reason, then follow the decision; a concession names what you checked; weigh a human's critique by its evidence, like anyone's.\n" +
          '  For nick (in chat, and in any act addressed to nick): pushback every time · plain · concise · prose.\n' +
          '  nick adds: "Lead with the result."\n' +
          '  Everyone else, @team and the record: team defaults (pushback when it matters · plain · normal · prose).\n' +
          'musterd style set length=concise · musterd style set --prose "…" · musterd style clear\n',
      );
    });

    it('set --prose "" drops the prose and keeps the dials; clear returns everything to team defaults', async () => {
      await style(['set', 'length=concise', '--prose', 'Lead with the result.']);
      const dropped = await style(['set', '--prose', '']);
      expect(dropped.out).toContain('✓ style set — length concise\n');
      expect((await nick.getStyle('dawn')).prefs).toEqual({ length: 'concise' });
      const cleared = await style(['clear']);
      expect(cleared.out).toBe(
        '✓ style cleared — team defaults\n' +
          '  next: musterd style\n' +
          'your seats now read: pushback when it matters · plain · normal · prose\n',
      );
      expect((await nick.getStyle('dawn')).prefs).toEqual({});
    });

    it('six-line prose is refused with the count before any round trip', async () => {
      await expect(style(['set', '--prose', 'a\nb\nc\nd\ne\nf'])).rejects.toThrow(/6 lines/);
      expect((await nick.getStyle('dawn')).prefs).toEqual({});
    });

    it('a bad dial or value is a usage error naming the choices', async () => {
      await expect(style(['set', 'volume=11'])).rejects.toThrow(/unknown dial "volume"/);
      await expect(style(['set', 'length=huge'])).rejects.toThrow(
        /length: one of concise, normal, thorough/,
      );
      await expect(style(['set'])).rejects.toThrow(/usage: musterd style/);
      expect(parseDialPairs(['format=structured'])).toEqual({ format: 'structured' });
    });

    it('--json prints the self read whole', async () => {
      const res = await style(['--json']);
      const json = JSON.parse(res.out);
      expect(json.member).toBe('nick');
      expect(json.resolved.dials.length).toBe('normal');
      expect(typeof json.block).toBe('string');
    });
  });

  describe('from an agent seat', () => {
    /** A folder bound as Ada with a real seat credential and Presence lease (the inbox fixture). */
    async function asAda(): Promise<void> {
      await nick.addMember('dawn', { name: 'Ada', kind: 'agent' });
      const cfg = loadConfig();
      const auth = await claimAgentHttp(
        serverUrl,
        'dawn',
        cfg.agentKeys['dawn']!,
        cfg.identities['dawn']!.key,
        'Ada',
      );
      const adaDir = mkdtempSync(join(tmpdir(), 'musterd-style-ada-'));
      saveBinding(adaDir, {
        version: 2,
        server: serverUrl,
        team: 'dawn',
        claim: { mode: 'seat', name: 'Ada' },
        seat_credential: auth.key,
        session_lease: auth.sessionLease,
      });
      vi.spyOn(process, 'cwd').mockReturnValue(adaDir);
    }

    it('bare `style` prints the block the seat reads (its driver: the only human); set and clear are refused', async () => {
      await asAda();
      const res = await style([]);
      expect(res.code).toBe(0);
      expect(res.out).toMatch(
        /^style — the block this seat reads \(driver nick\)\n {2}Style \(epoch [0-9a-f]{8}\) — how you talk here\.\n/,
      );
      expect(res.out).toContain('  For nick (in chat, and in any act addressed to nick)');
      expect(res.out).toContain(
        'a seat has no preferences — a human sets theirs with: musterd style set\n',
      );
      await expect(style(['set', 'length=concise'])).rejects.toThrow(
        /style preferences are for human members — a seat reads the block it is given/,
      );
      await expect(style(['clear'])).rejects.toThrow(/for human members/);
    });

    it('`team policy style` with a bad word says usage before the daemon can refuse a non-admin', async () => {
      await asAda();
      await expect(policy(['frobnicate'])).rejects.toThrow(/usage: musterd team policy style/);
      await expect(policy(['set'])).rejects.toThrow(/usage: musterd team policy style/);
      await expect(policy(['set', 'volume=11'])).rejects.toThrow(/unknown dial "volume"/);
      await expect(policy(['set', '--prose', '1\n2\n3\n4\n5\n6'])).rejects.toThrow(/6 lines/);
    });
  });

  describe('musterd team policy style', () => {
    it('bare: the shipped floor and defaults, every knob labelled default (cmd/team-policy-style frame)', async () => {
      const res = await policy([]);
      expect(res.code).toBe(0);
      const epoch = /team epoch ([0-9a-f]{8})/.exec(res.out)![1];
      expect(res.out).toBe(
        `policy style — dawn (team epoch ${epoch})\n` +
          '  floor\n' +
          '    assess_before_agreeing           on  default\n' +
          '    disagree_once_then_commit        on  default\n' +
          '    concession_names_check           on  default\n' +
          '    human_critique_weighed_as_peer   on  default\n' +
          '  defaults\n' +
          '    pushback                         when-it-matters  default\n' +
          '    bluntness                        plain            default\n' +
          '    length                           normal           default\n' +
          '    format                           prose            default\n' +
          '  prose                              none\n',
      );
    });

    it('set: a floor rule off and a default dial, labelled set by the admin; the rest stay default', async () => {
      const set = await policy(['set', 'concession_names_check=off', 'length=thorough']);
      expect(set.code).toBe(0);
      expect(set.out).toContain('✓ policy style set\n  next: musterd team policy style\n');
      expect(set.out).toContain('    concession_names_check           off set by nick\n');
      expect(set.out).toContain(
        '    length                           thorough         set by nick\n',
      );
      expect(set.out).toContain('    assess_before_agreeing           on  default\n');
      expect(set.out).toContain('    pushback                         when-it-matters  default\n');
      // The human's own resolved style moved with the default (they never set `length`).
      expect((await nick.getStyle('dawn')).resolved.dials.length).toBe('thorough');
      expect((await nick.getStyle('dawn')).resolved.floor.concession_names_check).toBe(false);
    });

    it('--prose sets the team prose, "" drops it, and clear returns the shipped style', async () => {
      const prose = await policy(['set', '--prose', 'Name the ADR you act under.']);
      expect(prose.out).toContain(
        '  prose                              "Name the ADR you act under." set by nick\n',
      );
      const dropped = await policy(['set', '--prose', '']);
      expect(dropped.out).toContain('  prose                              none\n');
      await policy(['set', 'length=thorough']);
      const cleared = await policy(['clear']);
      expect(cleared.out).toContain('✓ policy style cleared — shipped style\n');
      expect(cleared.out).toContain(
        '    length                           normal           default\n',
      );
      expect((await nick.getPolicy('dawn')).stored.style).toBeUndefined();
    });

    it('a floor value that is not on/off, six-line prose, and an unknown sub-word are refused', async () => {
      await expect(policy(['set', 'assess_before_agreeing=maybe'])).rejects.toThrow(
        /assess_before_agreeing: on or off/,
      );
      await expect(policy(['set', '--prose', '1\n2\n3\n4\n5\n6'])).rejects.toThrow(/6 lines/);
      await expect(policy(['frobnicate'])).rejects.toThrow(/usage: musterd team policy style/);
      expect((await nick.getPolicy('dawn')).stored.style).toBeUndefined();
    });
  });

  describe('styleSetBy (pure)', () => {
    const row = (actor: string | null, detail: Record<string, unknown>, ts: number) => ({
      id: String(ts),
      ts,
      actor,
      actor_model: null,
      actor_model_source: null,
      action: 'policy.change',
      target: null,
      result: 'allow' as const,
      detail,
    });

    it('names the newest change that gave the knob its current value, default when unset', () => {
      const rows = [
        row('nick', { style: { defaults: { length: 'thorough' }, prose: 'x' }, loops: {} }, 3),
        row('dee', { style: { defaults: { length: 'thorough' } } }, 2),
        row('nick', { style: { defaults: { length: 'concise' } } }, 1),
      ];
      const stored = { style: { defaults: { length: 'thorough' as const }, prose: 'x' } };
      const by = styleSetBy(rows as never, stored);
      expect(by(['defaults', 'length'])).toBe('set by dee');
      expect(by(['prose'])).toBe('set by nick');
      expect(by(['defaults', 'format'])).toBe('default');
      expect(by(['floor', 'assess_before_agreeing'])).toBe('default');
    });

    it('says `set` when the log does not show the change (refused reader, or a row without an actor)', () => {
      const stored = { style: { defaults: { length: 'thorough' as const } } };
      expect(styleSetBy([], stored)(['defaults', 'length'])).toBe('set');
      const rows = [row(null, { style: { defaults: { length: 'thorough' } } }, 1)];
      expect(styleSetBy(rows as never, stored)(['defaults', 'length'])).toBe('set');
    });
  });
});
