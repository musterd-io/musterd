import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { displayModel, modelBadge } from './modelBadge';

const m = (over: Record<string, unknown> = {}, presence: Record<string, unknown> | null = {}) =>
  ({
    id: 'm_a',
    name: 'a',
    kind: 'agent',
    presence: 'online',
    capabilities: {},
    presences: presence ? [{ status: 'online', surface: 'claude-code', ...presence }] : [],
    ...over,
  }) as unknown as MemberSummary;

describe('displayModel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['gpt-6-luna', 'GPT 6'],
    ['grok-5', 'Grok 5'],
    [null, ''],
  ])('%s → %s', (id, out) => expect(displayModel(id)).toBe(out));
});

describe('modelBadge', () => {
  it('observed model → provider + readable label', () => {
    const b = modelBadge(m({}, { model: 'claude-opus-5-5', model_source: 'observed' }));
    expect(b).toMatchObject({ label: 'Opus 5.5', full: 'claude-opus-5-5', source: 'observed' });
    expect(b.provider.id).toBe('claude');
  });

  it('a model the agent only declared is marked declared, never passed off as observed', () => {
    expect(modelBadge(m({}, { model: 'gpt-6-luna', model_source: 'binding' })).source).toBe(
      'declared',
    );
    expect(modelBadge(m({}, { model: 'gpt-6-luna', model_source: 'environment' })).source).toBe(
      'declared',
    );
  });

  it('a model with no tier is unverified — a different fact from a declaration (ADR 236)', () => {
    expect(modelBadge(m({}, { model: 'gpt-6-luna', model_source: null })).source).toBe(
      'unverified',
    );
    expect(modelBadge(m({}, { model: 'gpt-6-luna' })).source).toBe('unverified');
  });

  it('no model → "model unknown", never a guess (falsifier 2)', () => {
    expect(modelBadge(m({}, { model: null }))).toMatchObject({
      label: 'model unknown',
      source: 'unknown',
    });
    expect(modelBadge(m({}, null))).toMatchObject({ label: 'model unknown', source: 'unknown' });
  });

  it('a human is a human, whatever session they drive (Review Focus 2)', () => {
    const b = modelBadge(
      m({ kind: 'human' }, { model: 'claude-opus-5-5', model_source: 'observed' }),
    );
    expect(b).toMatchObject({ label: 'human', source: 'human' });
  });

  it('an unparseable id keeps its provider and puts the raw id in `full` (Review Focus 3)', () => {
    const b = modelBadge(m({}, { model: 'foo-bar-baz-1', model_source: 'observed' }));
    expect(b.label).not.toBe('');
    expect(b.full).toBe('foo-bar-baz-1');
  });

  it('reads the live attachment, not a stale one', () => {
    const b = modelBadge({
      ...m(),
      presences: [
        { status: 'offline', model: 'grok-5', model_source: 'observed' },
        { status: 'online', model: 'claude-opus-5-5', model_source: 'observed' },
      ],
    } as unknown as MemberSummary);
    expect(b.label).toBe('Opus 5.5');
  });
});
