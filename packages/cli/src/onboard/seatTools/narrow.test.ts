import { describe, expect, it } from 'vitest';
import { memoryFs } from '../reconcile/context.js';
import { SEAT_TOOLS_CACHE_REL } from './cache.js';
import { narrowNewHumanTools } from './narrow.js';

const ROOT = '/w/s';
const SETTINGS = `${ROOT}/.claude/settings.local.json`;
const env = { HOME: '/h' };
const cache = JSON.stringify({
  claude_plugins: ['superpowers@claude-plugins-official'],
  codex_plugins: [],
  skills: ['impeccable'],
  mcp_servers: [],
  readAt: 5,
});

describe('narrowNewHumanTools (ADR 794 §2, SessionStart)', () => {
  it('SessionStart recompute disables a plugin enabled since the last reconcile', () => {
    const fs = memoryFs({
      '/h/.claude/settings.json': JSON.stringify({
        enabledPlugins: {
          'superpowers@claude-plugins-official': true,
          'posthog@claude-plugins-official': true,
        },
      }),
      '/h/.claude/skills/impeccable/SKILL.md': 'x',
      '/h/.claude/skills/newskill/SKILL.md': 'x',
      [`${ROOT}/${SEAT_TOOLS_CACHE_REL}`]: cache,
      [SETTINGS]: JSON.stringify({
        enabledPlugins: { 'superpowers@claude-plugins-official': true },
        statusLine: { command: 'x' },
      }),
    });
    const closed = narrowNewHumanTools(ROOT, fs, env);
    expect(closed).toEqual(['posthog@claude-plugins-official', 'Skill(newskill)']);
    const s = JSON.parse(fs.readFile(SETTINGS)!);
    expect(s.enabledPlugins).toEqual({
      'superpowers@claude-plugins-official': true,
      'posthog@claude-plugins-official': false,
    });
    expect(s.permissions.deny).toEqual(['Skill(newskill)']);
    expect(s.statusLine).toEqual({ command: 'x' });
    // A second run has nothing new to close and writes nothing.
    expect(narrowNewHumanTools(ROOT, fs, env)).toEqual([]);
  });

  it('never enables or un-denies anything, even a declared tool', () => {
    const fs = memoryFs({
      '/h/.claude/settings.json': JSON.stringify({
        enabledPlugins: { 'superpowers@claude-plugins-official': true },
      }),
      [`${ROOT}/${SEAT_TOOLS_CACHE_REL}`]: cache,
      [SETTINGS]: JSON.stringify({
        enabledPlugins: { 'superpowers@claude-plugins-official': false },
        permissions: { deny: ['Skill(impeccable)'] },
      }),
    });
    expect(narrowNewHumanTools(ROOT, fs, env)).toEqual([]);
    const s = JSON.parse(fs.readFile(SETTINGS)!);
    expect(s.enabledPlugins['superpowers@claude-plugins-official']).toBe(false);
    expect(s.permissions.deny).toEqual(['Skill(impeccable)']);
  });

  it('does nothing in a folder never reconciled under ADR 794 (no cache)', () => {
    const fs = memoryFs({
      '/h/.claude/settings.json': JSON.stringify({
        enabledPlugins: { 'posthog@claude-plugins-official': true },
      }),
      [SETTINGS]: '{}',
    });
    expect(narrowNewHumanTools(ROOT, fs, env)).toEqual([]);
    expect(fs.readFile(SETTINGS)).toBe('{}');
  });
});
