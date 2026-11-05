import { describe, expect, it } from 'vitest';
import { memoryFs } from '../reconcile/context.js';
import { connectorPrefix, readClaudeHumanLayer } from './claudeHumanLayer.js';

const env = { HOME: '/h' };
const bucket = '/h/.claude/plugins/synced/b1';

function fixture(extra: Record<string, string> = {}) {
  return memoryFs({
    '/h/.claude/settings.json': JSON.stringify({
      enabledPlugins: {
        'posthog@claude-plugins-official': true,
        'supabase@claude-plugins-official': false,
        'superpowers@claude-plugins-official': true,
      },
    }),
    [`${bucket}/design/plugin.json`]: '{}',
    [`${bucket}/langfuse~g2/plugin.json`]: '{}',
    '/h/.claude/skills/impeccable/SKILL.md': 'x',
    '/h/.claude/skills/wrangler/SKILL.md': 'x',
    '/h/.claude/skills/synced/b1/caveman/SKILL.md': 'x',
    '/h/.claude.json': JSON.stringify({
      claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Superhuman Docs'],
      mcpServers: { localdb: { command: 'x' } },
    }),
    ...extra,
  });
}

describe('readClaudeHumanLayer (ADR 794)', () => {
  it('lists enabled plugins only, not ones set false, plus the synced ones', () => {
    const layer = readClaudeHumanLayer(fixture(), env);
    expect(layer.plugins).toEqual([
      'design@synced',
      'langfuse@synced',
      'posthog@claude-plugins-official',
      'superpowers@claude-plugins-official',
    ]);
  });

  it('lists personal and synced skills by directory name', () => {
    expect(readClaudeHumanLayer(fixture(), env).skills).toEqual([
      'anthropic-skills:caveman',
      'impeccable',
      'wrangler',
    ]);
  });

  it('lists user MCP servers and connectors as their tool prefixes', () => {
    const layer = readClaudeHumanLayer(fixture(), env);
    expect(layer.mcpServers).toEqual(['claude_ai_Gmail', 'claude_ai_Superhuman_Docs', 'localdb']);
    expect(layer.complete).toBe(true);
    expect(connectorPrefix('claude.ai Cloudflare Developer Platform')).toBe(
      'claude_ai_Cloudflare_Developer_Platform',
    );
  });

  it('normalizes punctuation in user servers and connector names', () => {
    const fs = fixture({
      '/h/.claude.json': JSON.stringify({
        mcpServers: { 'local+db': { command: 'x' } },
        claudeAiMcpEverConnected: ['claude.ai Research & Docs'],
      }),
    });
    expect(readClaudeHumanLayer(fs, env).mcpServers).toEqual([
      'claude_ai_Research___Docs',
      'local_db',
    ]);
  });

  it('records distinct server names that normalize to the same prefix', () => {
    const fs = fixture({
      '/h/.claude.json': JSON.stringify({
        mcpServers: { 'a+b': {}, a_b: {} },
      }),
    });
    expect(readClaudeHumanLayer(fs, env).ambiguousMcpServers).toEqual(['a_b']);
  });

  it('an unreadable settings file gives complete false and empty plugins from it', () => {
    const layer = readClaudeHumanLayer(fixture({ '/h/.claude/settings.json': '{broken' }), env);
    expect(layer.complete).toBe(false);
    expect(layer.plugins).toEqual(['design@synced', 'langfuse@synced']);
  });

  it('a machine with none of these files is complete and empty', () => {
    expect(readClaudeHumanLayer(memoryFs(), env)).toEqual({
      plugins: [],
      skills: [],
      mcpServers: [],
      complete: true,
    });
  });

  it('honors CLAUDE_CONFIG_DIR', () => {
    const fs = memoryFs({
      '/c/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true } }),
      '/c/.claude.json': JSON.stringify({ mcpServers: { s: {} } }),
    });
    const layer = readClaudeHumanLayer(fs, { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
    expect(layer.plugins).toEqual(['a@m']);
    expect(layer.mcpServers).toEqual(['s']);
  });
});
