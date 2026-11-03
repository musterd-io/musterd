import { describe, expect, it } from 'vitest';
import { claudeComplement } from './claudeComplement.js';
import type { HumanLayer } from './claudeHumanLayer.js';
import { emptyDeclaredSet, type DeclaredSet } from './resolve.js';

const human: HumanLayer = {
  plugins: ['figma@claude-plugins-official', 'posthog@claude-plugins-official'],
  skills: ['anthropic-skills:caveman', 'impeccable'],
  mcpServers: ['claude_ai_Gmail', 'claude_ai_Slack'],
  complete: true,
};
const declared = (over: Partial<DeclaredSet>): DeclaredSet => ({
  ...emptyDeclaredSet(),
  source: 'server',
  readAt: 1,
  ...over,
});

describe('claudeComplement (ADR 794 §2)', () => {
  it('declared plugins are enabled, undeclared human plugins are disabled', () => {
    const out = claudeComplement(
      declared({
        claude_plugins: ['figma@claude-plugins-official', 'github@claude-plugins-official'],
      }),
      human,
    );
    expect(out.enabledPlugins).toEqual({
      'figma@claude-plugins-official': true,
      'github@claude-plugins-official': true,
      'posthog@claude-plugins-official': false,
    });
  });

  it('an undeclared personal skill is denied, a granted one is not', () => {
    const out = claudeComplement(declared({ skills: ['impeccable'] }), human);
    expect(out.deny).toContain('Skill(anthropic-skills:caveman)');
    expect(out.deny).not.toContain('Skill(impeccable)');
    expect(out.undeny).toContain('Skill(impeccable)');
  });

  it('an undeclared connector is denied, a granted mcp_servers name is not', () => {
    const out = claudeComplement(declared({ mcp_servers: ['claude_ai_Slack'] }), human);
    expect(out.deny).toContain('mcp__claude_ai_Gmail');
    expect(out.deny).not.toContain('mcp__claude_ai_Slack');
    expect(out.undeny).toContain('mcp__claude_ai_Slack');
  });

  it('with no declared set, everything in the human layer is off', () => {
    const out = claudeComplement(emptyDeclaredSet(), human);
    expect(Object.values(out.enabledPlugins)).toEqual([false, false]);
    expect(out.deny).toEqual([
      'Skill(anthropic-skills:caveman)',
      'Skill(impeccable)',
      'mcp__claude_ai_Gmail',
      'mcp__claude_ai_Slack',
    ]);
  });

  it('a floor-denied skill is never in undeny', () => {
    const out = claudeComplement(
      declared({ skills: ['superpowers:dispatching-parallel-agents'] }),
      human,
    );
    expect(out.undeny).not.toContain('Skill(superpowers:dispatching-parallel-agents)');
  });
});
