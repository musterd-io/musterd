import { describe, expect, it } from 'vitest';
import { seatAddress, serverHost } from './address.js';
import { harnessLabel, LAUNCHABLE_HARNESSES } from './labels.js';

describe('seat addresses (ADR 491)', () => {
  it('is team/project/member, host-qualified only when asked', () => {
    expect(seatAddress('revive', 'agents', 'stanley')).toBe('revive/agents/stanley');
    expect(seatAddress('revive', 'agents', 'stanley', 'musterd.io')).toBe(
      'revive@musterd.io/agents/stanley',
    );
  });

  it('serverHost keeps the port and passes a non-URL through', () => {
    expect(serverHost('http://127.0.0.1:4849')).toBe('127.0.0.1:4849');
    expect(serverHost('https://musterd.io/')).toBe('musterd.io');
    expect(serverHost('not a url')).toBe('not a url');
  });
});

describe('harness labels', () => {
  it('says the word a person types', () => {
    expect(harnessLabel('claude-code')).toBe('claude');
    expect(harnessLabel('codex')).toBe('codex');
    expect(harnessLabel('shell')).toBe('shell');
    expect(harnessLabel('something-new')).toBe('something-new');
  });

  it('lists the launchable harnesses in registry order', () => {
    expect(LAUNCHABLE_HARNESSES).toEqual(['claude-code', 'cursor', 'codex', 'opencode', 'grok']);
  });
});
