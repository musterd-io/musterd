import { describe, expect, it } from 'vitest';
import { PolicyOverrideSchema, PolicySchema, sparsifyPolicy } from './credentials.js';
import {
  DEFAULT_SHARED_PLUGIN,
  PluginIdSchema,
  SeatToolsPolicySchema,
  SeatToolServerSchema,
} from './seatTools.js';

describe('seat_tools (ADR 794)', () => {
  it('a team that never set seat_tools reads superpowers only, and no role sets', () => {
    expect(PolicySchema.parse({}).seat_tools).toEqual({
      shared: {
        claude_plugins: ['superpowers@claude-plugins-official'],
        codex_plugins: [],
        skills: [],
        mcp_servers: [],
      },
      roles: {},
      servers: {},
    });
    expect(DEFAULT_SHARED_PLUGIN).toBe('superpowers@claude-plugins-official');
  });

  it('refuses a plugin id without @MARKETPLACE', () => {
    expect(() =>
      SeatToolsPolicySchema.parse({ roles: { designer: { claude_plugins: ['figma'] } } }),
    ).toThrow();
  });

  it('accepts a claude.ai-synced plugin id', () => {
    expect(PluginIdSchema.parse('design@synced')).toBe('design@synced');
  });

  it('a sparse override sets one role without dropping the shared default', () => {
    const stored = PolicyOverrideSchema.parse({
      seat_tools: { roles: { designer: { claude_plugins: ['figma@claude-plugins-official'] } } },
    });
    const effective = PolicySchema.parse(stored).seat_tools;
    expect(effective.shared.claude_plugins).toEqual(['superpowers@claude-plugins-official']);
    expect(effective.roles['designer']?.claude_plugins).toEqual(['figma@claude-plugins-official']);
    expect(effective.roles['designer']?.skills).toEqual([]);
  });

  it('a written shared set replaces the default whole (the list is the set)', () => {
    const effective = PolicySchema.parse({
      seat_tools: { shared: { claude_plugins: ['github@claude-plugins-official'] } },
    }).seat_tools;
    expect(effective.shared.claude_plugins).toEqual(['github@claude-plugins-official']);
  });

  it('sparsifyPolicy drops a seat_tools block equal to the default and keeps a role set', () => {
    expect(sparsifyPolicy({ seat_tools: SeatToolsPolicySchema.parse({}) })).toEqual({});
    expect(
      sparsifyPolicy({
        seat_tools: { ...SeatToolsPolicySchema.parse({}), roles: { ios: { skills: ['x'] } } },
      }),
    ).toEqual({
      seat_tools: {
        roles: { ios: { claude_plugins: [], codex_plugins: [], skills: ['x'], mcp_servers: [] } },
      },
    });
  });

  it('a server grant is one transport, and an empty map is the default', () => {
    expect(SeatToolServerSchema.parse({ command: 'fixture' })).toEqual({
      command: 'fixture',
      args: [],
      env: {},
    });
    expect(SeatToolServerSchema.parse({ url: 'https://example.com/mcp' })).toEqual({
      url: 'https://example.com/mcp',
      args: [],
      env: {},
    });
    expect(() =>
      SeatToolServerSchema.parse({ command: 'fixture', url: 'https://example.com/mcp' }),
    ).toThrow(/exactly one transport/);
    expect(() => SeatToolServerSchema.parse({})).toThrow(/exactly one transport/);
  });

  it('sparsifyPolicy keeps a server definition and drops the default map', () => {
    const granted = SeatToolsPolicySchema.parse({
      servers: { warehouse: { command: 'fixture', args: ['--stdio'] } },
    });
    expect(sparsifyPolicy({ seat_tools: granted })).toEqual({
      seat_tools: {
        servers: { warehouse: { command: 'fixture', args: ['--stdio'], env: {} } },
      },
    });
  });
});
