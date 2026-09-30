import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectArtifactDrift } from './doctor.js';
import { installMusterdCursorHooks } from './harnesses/cursor.js';
import { renderOpencodePlugin } from './harnesses/opencodePlugin.js';
import { defaultSelfHealDeps, selfHealWorkspace } from './selfHeal.js';

/**
 * The self-heal's cheap inspection against the REAL harness adapters (lane 01M3NMZ94D).
 *
 * On 2026-09-28 a Grok folder with no `.grok/hooks/musterd.json` and an OpenCode folder carrying a
 * v1 doorbell plugin under a v2 build both read `hooks: 0` in `drift.json`, while `init --check`
 * named every defect: the inspection asked Claude Code alone, so the heal had nothing to repair.
 * Only `config.js` is mocked, so the repair round-trips to disk.
 */
const h = vi.hoisted(() => ({ folderBinding: null as { team: string } | null }));

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findBinding: vi.fn(() => h.folderBinding),
  findWorkspaceSpec: vi.fn(() => null),
}));

let cwd: string;
let globalDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-artifact-drift-'));
  globalDir = mkdtempSync(join(tmpdir(), 'musterd-artifact-drift-global-'));
  process.env['CLAUDE_CONFIG_DIR'] = globalDir; // never touch the real ~/.claude
  h.folderBinding = { team: 'revive' };
});

afterEach(() => {
  delete process.env['CLAUDE_CONFIG_DIR'];
  rmSync(cwd, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

const grokFolder = () => {
  mkdirSync(join(cwd, '.grok'), { recursive: true });
  writeFileSync(
    join(cwd, '.grok', 'config.toml'),
    '[mcp_servers.musterd]\ncommand = "musterd-mcp"\n',
  );
};

const staleOpencodeFolder = () => {
  mkdirSync(join(cwd, '.opencode', 'plugins'), { recursive: true });
  writeFileSync(join(cwd, '.opencode', 'opencode.json'), '{"mcp":{"musterd":{"type":"local"}}}\n');
  writeFileSync(
    join(cwd, '.opencode', 'plugins', 'musterd.js'),
    renderOpencodePlugin().replace(
      /musterd-opencode-interrupt v\d+/,
      'musterd-opencode-interrupt v1',
    ),
  );
};

/** A Cursor folder whose hooks file lost one musterd hook (wanderer, 2026-09-30: lane 01M3T7J6BE). */
const cursorFolderMissingOne = () => {
  mkdirSync(join(cwd, '.cursor'), { recursive: true });
  writeFileSync(join(cwd, '.cursor', 'mcp.json'), '{"mcpServers":{"musterd":{"command":"x"}}}\n');
  installMusterdCursorHooks(cwd);
  const path = join(cwd, '.cursor', 'hooks.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown[]> };
  delete file.hooks['preToolUse'];
  writeFileSync(path, JSON.stringify(file, null, 2));
};

describe('inspectArtifactDrift — every provisioned harness, not Claude Code alone', () => {
  it('a Cursor folder missing a musterd hook reads it as drift', () => {
    cursorFolderMissingOne();
    expect(inspectArtifactDrift(cwd).hooks).toEqual([expect.stringContaining('preToolUse')]);
  });

  it('a Grok folder with no hooks file reads its missing hooks as drift', () => {
    grokFolder();
    const hooks = inspectArtifactDrift(cwd).hooks;
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.every((l) => l.includes('.grok/hooks/musterd.json'))).toBe(true);
  });

  it('a stale OpenCode doorbell plugin reads as drift', () => {
    staleOpencodeFolder();
    expect(inspectArtifactDrift(cwd).hooks).toEqual([expect.stringContaining('STALE')]);
  });

  it('a folder provisioned for neither stays silent — no drift invented from absence', () => {
    expect(inspectArtifactDrift(cwd).hooks).toEqual([]);
  });

  it.each([
    ['Grok', grokFolder],
    ['OpenCode', staleOpencodeFolder],
    ['Cursor', cursorFolderMissingOne],
  ])('the self-heal repairs %s hook drift and the re-inspection reads clean', (_name, setup) => {
    setup();
    const out = selfHealWorkspace(cwd, defaultSelfHealDeps('test'));
    expect(out.ran).toBe(true);
    expect(out.report?.repaired.hooks).toBeGreaterThan(0);
    expect(out.report?.remaining.hooks).toBe(0);
    expect(inspectArtifactDrift(cwd).hooks).toEqual([]);
  });

  it('the repaired OpenCode plugin is exactly what this build writes', () => {
    staleOpencodeFolder();
    selfHealWorkspace(cwd, defaultSelfHealDeps('test'));
    expect(readFileSync(join(cwd, '.opencode', 'plugins', 'musterd.js'), 'utf8')).toBe(
      renderOpencodePlugin(),
    );
  });
});
