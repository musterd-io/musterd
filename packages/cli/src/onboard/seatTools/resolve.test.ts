import { SeatToolsPolicySchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { FLOOR_DENIED_SKILLS } from '../permissions.js';
import { declaredSetFor } from './resolve.js';

const policy = SeatToolsPolicySchema.parse({
  shared: {
    claude_plugins: ['superpowers@claude-plugins-official', 'github@claude-plugins-official'],
    mcp_servers: ['claude_ai_Slack'],
  },
  roles: {
    designer: {
      claude_plugins: ['figma@claude-plugins-official', 'github@claude-plugins-official'],
      skills: ['impeccable', 'superpowers:dispatching-parallel-agents'],
    },
    ios: { codex_plugins: ['expo@openai-curated'] },
  },
});

describe('declaredSetFor (ADR 794)', () => {
  it('unions shared and every held role, sorted, without duplicates', () => {
    const set = declaredSetFor(policy, ['ios', 'designer']);
    expect(set.claude_plugins).toEqual([
      'figma@claude-plugins-official',
      'github@claude-plugins-official',
      'superpowers@claude-plugins-official',
    ]);
    expect(set.codex_plugins).toEqual(['expo@openai-curated']);
    expect(set.mcp_servers).toEqual(['claude_ai_Slack']);
  });

  it('resolves a role with no grant to the shared set', () => {
    const set = declaredSetFor(policy, ['backend']);
    expect(set.claude_plugins).toEqual([
      'github@claude-plugins-official',
      'superpowers@claude-plugins-official',
    ]);
    expect(set.skills).toEqual([]);
  });

  it('drops a floor-denied skill even when a role grants it, and always denies the floor', () => {
    const set = declaredSetFor(policy, ['designer']);
    expect(set.skills).toEqual(['impeccable']);
    expect(set.deniedSkills).toEqual([...FLOOR_DENIED_SKILLS]);
  });

  it('the default policy gives superpowers only', () => {
    const set = declaredSetFor(SeatToolsPolicySchema.parse({}), ['designer']);
    expect(set.claude_plugins).toEqual(['superpowers@claude-plugins-official']);
    expect(set.codex_plugins).toEqual([]);
  });
});
