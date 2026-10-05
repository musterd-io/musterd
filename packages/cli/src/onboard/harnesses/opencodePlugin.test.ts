import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_IDLE_BELL_CAP,
  OPENCODE_PLUGIN_GENERATION,
  OPENCODE_PLUGIN_ID,
  OPENCODE_PLUGIN_MARKER,
  OPENCODE_PLUGIN_SURFACE,
  inspectOpencodePluginDrift,
  installMusterdOpencodePlugin,
  installedPluginGeneration,
  opencodePluginHeader,
  opencodePluginPath,
  removeMusterdOpencodePlugin,
  renderOpencodePlugin,
} from './opencodePlugin.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-opencode-plugin-'));
  dirs.push(dir);
  return dir;
}

describe('OpenCode doorbell plugin install / drift / remove (ADR 392, ADR 168)', () => {
  it('writes a marker-stamped, dependency-free ESM plugin and reads back as current', () => {
    const dir = tmpProject();
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    const raw = readFileSync(opencodePluginPath(dir), 'utf8');
    expect(raw.startsWith(opencodePluginHeader())).toBe(true);
    expect(installedPluginGeneration(raw)).toBe(OPENCODE_PLUGIN_GENERATION);
    // node built-ins only: no bun install step, no package.json (ADR 362 finding 2 met, not waived)
    const imports = raw.match(/^import .* from "(.+)";$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/from "node:/);
    expect(raw).toContain('"tool.execute.after"');
    expect(raw).toContain('"session.idle"');
    expect(raw).not.toContain('experimental.');
    expect(raw).not.toContain('@opencode');
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('dual entry (gen 3): a default {id, setup, server} for V2 / V1.18.29+ plus the named export for older V1', () => {
    const dir = tmpProject();
    installMusterdOpencodePlugin(dir);
    const raw = readFileSync(opencodePluginPath(dir), 'utf8');
    expect(raw).toContain('export const MusterdInterrupt');
    expect(raw).toContain('export default {');
    expect(raw).toContain(`id: PLUGIN_ID`);
    expect(raw).toContain('setup: async (ctx)');
    expect(raw).toContain('server: async (input)');
    // The installed file is linted (`pnpm lint` runs repo-wide), and the default export is
    // non-negotiable for the V2 loader — so the generator must emit the disable that keeps the
    // two from colliding. `--` after the rule name: an em dash makes ESLint read the rest of the
    // line as the rule name and fail on an unknown rule (this bit us once).
    expect(raw).toMatch(
      /^\/\/ eslint-disable-next-line import\/no-default-export[^\n]*\nexport default \{$/m,
    );
  });

  it('names a missing plugin as the deaf state, and a stale one as STALE with the refresh repair', () => {
    const dir = tmpProject();
    const missing = inspectOpencodePluginDrift(dir);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('nothing probes the interrupt line');
    expect(missing[0]).toContain('musterd init --refresh-hooks');

    mkdirSync(join(dir, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(
      opencodePluginPath(dir),
      `${opencodePluginHeader(0)}\nexport const MusterdInterrupt = async () => ({});\n`,
    );
    const stale = inspectOpencodePluginDrift(dir);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('STALE');
    expect(stale[0]).toContain('v0');
    // and the refresh rewrites an OLDER generation in place
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('refuses to downgrade a plugin written by a newer build (ADR 168) and to clobber a foreign file (ADR 027)', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.opencode', 'plugins'), { recursive: true });
    const newer = `${opencodePluginHeader(OPENCODE_PLUGIN_GENERATION + 1)}\nexport const X = async () => ({});\n`;
    writeFileSync(opencodePluginPath(dir), newer);
    const w = installMusterdOpencodePlugin(dir);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('newer musterd build');
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(newer);

    const foreign = "// somebody else's plugin\nexport const Theirs = async () => ({});\n";
    writeFileSync(opencodePluginPath(dir), foreign);
    const w2 = installMusterdOpencodePlugin(dir);
    expect(w2).toHaveLength(1);
    expect(w2[0]).toContain("not musterd's");
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(foreign);
    expect(inspectOpencodePluginDrift(dir)[0]).toContain("not musterd's");
    removeMusterdOpencodePlugin(dir);
    expect(readFileSync(opencodePluginPath(dir), 'utf8')).toBe(foreign);
  });

  it('honours a declined opencode:plugin surface (ADR 332): no install, no drift', () => {
    const dir = tmpProject();
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'declined.json'),
      JSON.stringify({
        version: 1,
        declined: [{ surface: OPENCODE_PLUGIN_SURFACE, at: '2026-09-06T00:00:00Z' }],
      }),
    );
    expect(installMusterdOpencodePlugin(dir)).toEqual([]);
    expect(inspectOpencodePluginDrift(dir)).toEqual([]);
  });

  it('removes exactly our file', () => {
    const dir = tmpProject();
    installMusterdOpencodePlugin(dir);
    removeMusterdOpencodePlugin(dir);
    expect(inspectOpencodePluginDrift(dir)[0]).toContain('missing');
  });
});

/**
 * The plugin executed for real, in a node subprocess (the same node built-ins Bun serves inside
 * OpenCode; a subprocess because vite will not import a file from outside the project), against a
 * fake `musterd` on PATH that prints whatever MUSTERD_FAKE_LINE says. What the shape pins IS the
 * delivery: a raised line lands in the tool output the model reads, and an idle bell becomes one
 * capped reply-mode prompt.
 */
describe('OpenCode doorbell plugin behaviour', () => {
  function stage(dir: string) {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'musterd');
    writeFileSync(
      fake,
      // records cwd and args so the test can assert the probe ran in the seat folder
      `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> "${join(dir, 'calls.log')}"\ncase "$*" in *--hook*|*--stdin*) cat >> "${join(dir, 'stdin.log')}"; echo >> "${join(dir, 'stdin.log')}";; esac\nif [ -n "$MUSTERD_FAKE_LINE" ]; then printf '%s\\n' "$MUSTERD_FAKE_LINE"; fi\n`,
    );
    chmodSync(fake, 0o755);
    const pluginFile = join(dir, 'musterd-plugin.mjs');
    writeFileSync(pluginFile, renderOpencodePlugin());
    return { bin, pluginFile };
  }

  function spawn(
    dir: string,
    bin: string,
    line: string,
    script: string,
    env: Record<string, string> = {},
  ) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        MUSTERD_FAKE_LINE: line,
        MUSTERD_NO_NUDGE: '',
        ...env,
      },
    });
    if (res.status !== 0) throw new Error(`plugin scenario failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  }

  function run(dir: string, line: string, scenario: string, env: Record<string, string> = {}) {
    const { bin, pluginFile } = stage(dir);
    const script = `const { MusterdInterrupt } = await import(${JSON.stringify(pathToFileURL(pluginFile).href)});\n${scenario}`;
    return spawn(dir, bin, line, script, env);
  }

  function runV2(dir: string, line: string, scenario: string, env: Record<string, string> = {}) {
    const { bin, pluginFile } = stage(dir);
    const script = `const mod = await import(${JSON.stringify(pathToFileURL(pluginFile).href)});\nconst def = mod.default;\n${scenario}`;
    return spawn(dir, bin, line, script, env);
  }

  it('appends a raised line, fenced, to the tool output; silent when the probe prints nothing', () => {
    const dir = tmpProject();
    const seat = join(dir, 'seat');
    mkdirSync(seat);
    const r = run(
      dir,
      'musterd: nick steered you — run team_inbox_check',
      `const hooks = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(seat)} });
       const out = { title: 't', output: 'file contents', metadata: {} };
       await hooks['tool.execute.after']({}, out);
       process.env.MUSTERD_FAKE_LINE = '';
       const quiet = { title: 't', output: 'unchanged', metadata: {} };
       await hooks['tool.execute.after']({}, quiet);
       console.log(JSON.stringify({ out: out.output, quiet: quiet.output }));`,
    );
    expect(r['out']).toBe(
      'file contents\n\n<musterd-interrupt>\nmusterd: nick steered you — run team_inbox_check\n</musterd-interrupt>',
    );
    expect(r['quiet']).toBe('unchanged');
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('inbox --interrupt-check');
    expect(calls[0]!.startsWith(seat) || calls[0]!.startsWith(`/private${seat}`)).toBe(true);
  });

  it('rings an idle session with one reply-mode prompt per raised line, capped per session', () => {
    const dir = tmpProject();
    const r = run(
      dir,
      'musterd: a huddle turn is yours',
      `const prompts = [];
       const client = { session: { promptAsync: async (req) => void prompts.push(req) } };
       const hooks = await MusterdInterrupt({ client, directory: ${JSON.stringify(dir)} });
       const idle = { event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } };
       for (let i = 0; i < ${String(OPENCODE_IDLE_BELL_CAP)} + 3; i++) await hooks.event(idle);
       const afterCap = prompts.length;
       await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_2' } } });
       await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_3' } } });
       console.log(JSON.stringify({ afterCap, total: prompts.length, first: prompts[0] }));`,
    );
    expect(r['afterCap']).toBe(OPENCODE_IDLE_BELL_CAP);
    expect(r['total']).toBe(OPENCODE_IDLE_BELL_CAP + 1);
    expect(r['first']).toEqual({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'musterd: a huddle turn is yours', synthetic: true }] },
    });
  });

  it('taps the trace (ADR 445): the tool probe carries the call on stdin; idle records Stop', () => {
    const dir = tmpProject();
    run(
      dir,
      '',
      `const hooks = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(dir)} });
       await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_1', callID: 'call_9' }, { output: '' });
       await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
       console.log('{}');`,
    );
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
    expect(calls).toContain('inbox --interrupt-check --hook opencode');
    expect(calls).toContain('trace hook --stdin --harness opencode --kind Stop');
    const stdin = readFileSync(join(dir, 'stdin.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(stdin).toContainEqual({
      session_id: 'ses_1',
      hook_event_name: 'PostToolUse',
      tool_name: 'bash',
      tool_use_id: 'call_9',
    });
    expect(stdin).toContainEqual({ session_id: 'ses_1', hook_event_name: 'Stop' });
  });

  it('MUSTERD_NO_NUDGE=1 mutes the plugin without running the CLI', () => {
    const dir = tmpProject();
    const r = run(
      dir,
      'should never print',
      `const hooks = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(dir)} });
       const out = { title: 't', output: 'x', metadata: {} };
       await hooks['tool.execute.after']({}, out);
       console.log(JSON.stringify({ out: out.output }));`,
      { MUSTERD_NO_NUDGE: '1' },
    );
    expect(r['out']).toBe('x');
    expect(() => readFileSync(join(dir, 'calls.log'))).toThrow();
  });

  it('V2 default export carries the loader shape: {id, setup, server}', () => {
    const dir = tmpProject();
    const r = runV2(
      dir,
      '',
      `console.log(JSON.stringify({
         id: def.id,
         setup: typeof def.setup,
         server: typeof def.server,
         named: typeof (await import(${JSON.stringify(pathToFileURL(join(dir, 'musterd-plugin.mjs')).href)})).MusterdInterrupt,
       }));`,
    );
    expect(r['id']).toBe(OPENCODE_PLUGIN_ID);
    expect(r['setup']).toBe('function');
    expect(r['server']).toBe('function');
    expect(r['named']).toBe('function');
  });

  it('V2 setup: completed tool results gain the fenced line; the trace tap carries v2 ids', () => {
    const dir = tmpProject();
    const r = runV2(
      dir,
      'musterd: nick steered you — run team_inbox_check',
      `const prompts = [];
       const hooks = {};
       const ctx = {
         location: { directory: ${JSON.stringify(dir)} },
         tool: { hook: async (name, cb) => { (hooks[name] ??= []).push(cb); } },
         event: { subscribe: () => (async function* () {})() },
         session: { prompt: async (req) => { prompts.push(req); } },
       };
       await def.setup(ctx);
       const after = hooks['execute.after'][0];
       const completed = { tool: 'bash', sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_9', input: {}, status: 'completed', result: { output: 'file contents' } };
       await after(completed);
       const failed = { tool: 'bash', sessionID: 'ses_1', agent: 'build', messageID: 'msg_2', id: 'call_10', input: {}, status: 'error', error: { message: 'boom' }, result: undefined };
       await after(failed);
       console.log(JSON.stringify({ out: completed.result.output }));`,
    );
    expect(r['out']).toBe(
      'file contents\n\n<musterd-interrupt>\nmusterd: nick steered you — run team_inbox_check\n</musterd-interrupt>',
    );
    const stdin = readFileSync(join(dir, 'stdin.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(stdin).toContainEqual({
      session_id: 'ses_1',
      hook_event_name: 'PostToolUse',
      tool_name: 'bash',
      tool_use_id: 'call_9',
    });
  });

  it('V2 setup: a session.idle event rings one reply-mode prompt per raised line, capped per session', () => {
    const dir = tmpProject();
    const r = runV2(
      dir,
      'musterd: a huddle turn is yours',
      `const prompts = [];
       const idles = [];
       for (let i = 0; i < ${(OPENCODE_IDLE_BELL_CAP + 3).toString()}; i++) idles.push({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
       idles.push({ type: 'session.idle', properties: { sessionID: 'ses_2' } });
       idles.push({ type: 'session.updated', properties: { sessionID: 'ses_3' } });
       const ctx = {
         location: { directory: ${JSON.stringify(dir)} },
         tool: { hook: async () => {} },
         event: { subscribe: () => (async function* () { for (const e of idles) yield e; })() },
         session: { prompt: async (req) => { prompts.push(req); } },
       };
       const cleanup = await def.setup(ctx);
       await new Promise((r) => setTimeout(r, 800));
       if (cleanup) await cleanup();
       const ses1 = prompts.filter((p) => p.sessionID === 'ses_1').length;
       console.log(JSON.stringify({ ses1, total: prompts.length, first: prompts[0] }));`,
    );
    expect(r['ses1']).toBe(OPENCODE_IDLE_BELL_CAP);
    expect(r['total']).toBe(OPENCODE_IDLE_BELL_CAP + 1);
    expect(r['first']).toEqual({ sessionID: 'ses_1', text: 'musterd: a huddle turn is yours' });
  });

  it('V2 server() and the named export register the rail exactly once between them', () => {
    const dir = tmpProject();
    const r = runV2(
      dir,
      'musterd: hello',
      `const first = await def.server({ client: {}, directory: ${JSON.stringify(dir)} });
       const { MusterdInterrupt } = await import(${JSON.stringify(pathToFileURL(join(dir, 'musterd-plugin.mjs')).href)});
       const second = await MusterdInterrupt({ client: {}, directory: ${JSON.stringify(dir)} });
       const third = await def.server({ client: {}, directory: ${JSON.stringify(dir)} });
       console.log(JSON.stringify({
         first: Object.keys(first).sort(),
         second: Object.keys(second),
         third: Object.keys(third),
       }));`,
    );
    expect(r['first']).toEqual(['event', 'tool.execute.after']);
    expect(r['second']).toEqual([]);
    expect(r['third']).toEqual([]);
  });

  it('marker constant matches the header the doctor greps for', () => {
    expect(opencodePluginHeader()).toContain(`// ${OPENCODE_PLUGIN_MARKER} v`);
  });
});
