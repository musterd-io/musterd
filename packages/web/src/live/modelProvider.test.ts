import { describe, expect, it } from 'vitest';
import { modelProvider } from './modelProvider';
import { providerIconHtml } from './modelProviderIcon';

describe('modelProvider', () => {
  it('maps Claude families (including fable) to claude chip colors', () => {
    for (const id of ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      const p = modelProvider(id);
      expect(p.id).toBe('claude');
      expect(p.border).toBe('#D97757');
      expect(p.fill).toBe('#FCEEE8');
      expect(p.ink).toBe('#5C2E1F');
    }
  });

  it('maps gpt / o-series to openai', () => {
    expect(modelProvider('gpt-5.6-terra-medium').id).toBe('openai');
    expect(modelProvider('o3-pro').id).toBe('openai');
    expect(modelProvider('gpt-5.6-luna-medium').border).toBe('#10A37F');
  });

  it('maps gemini, grok, llama, mistral, qwen, deepseek, kimi, minimax, glm, nova', () => {
    expect(modelProvider('gemini-3.2-pro').id).toBe('gemini');
    expect(modelProvider('grok-4.5').id).toBe('xai');
    expect(modelProvider('llama-4-maverick').id).toBe('meta');
    expect(modelProvider('mistral-large-3').id).toBe('mistral');
    expect(modelProvider('qwen-3.5').id).toBe('qwen');
    expect(modelProvider('deepseek-v4-pro').id).toBe('deepseek');
    expect(modelProvider('kimi-k3').id).toBe('kimi');
    expect(modelProvider('moonshot-v1').id).toBe('kimi');
    expect(modelProvider('minimax-m3').id).toBe('minimax');
    expect(modelProvider('glm-5.2').id).toBe('glm');
    expect(modelProvider('zai-glm').id).toBe('glm');
    expect(modelProvider('amazon-nova-2-pro').id).toBe('nova');
  });

  it('maps muse-spark to meta (not unknown)', () => {
    // Live defect: ghost's plate rendered the "?" mark because only 'llama' mapped to meta.
    const p = modelProvider('muse-spark-1.3-contributor-free');
    expect(p.id).toBe('meta');
    expect(p.border).toBe('#0668E1');
    const html = providerIconHtml(p);
    expect(html).toContain('<svg');
    expect(html).toContain('#0668E1');
  });

  it('returns unknown for missing / unknown / empty', () => {
    expect(modelProvider(null).id).toBe('unknown');
    expect(modelProvider('unknown').id).toBe('unknown');
    expect(modelProvider('').id).toBe('unknown');
  });

  it('maps CatJam models to a cat mark (not unknown)', () => {
    const p = modelProvider('cat-jam-free');
    expect(p.id).toBe('catjam');
    expect(p.border).toBe('#7C3AED');
    const html = providerIconHtml(p);
    expect(html).toContain('<svg');
    expect(html).toContain('#7C3AED');
  });
});

describe('providerIconHtml', () => {
  it('returns an svg for claude and openai', () => {
    const claude = providerIconHtml(modelProvider('claude-opus-5'));
    expect(claude).toContain('<svg');
    expect(claude).toContain('#D97757');

    const openai = providerIconHtml(modelProvider('gpt-5.6'));
    expect(openai).toContain('<svg');
    expect(openai).toContain('#10A37F');
  });

  it.each([
    ['glm-5.2', 'glm'],
    ['step-5-preview-free', 'stepfun'],
    ['longcat-2.5-preview-free', 'longcat'],
    ['ling-3.1-flash-free', 'ant'],
    ['moonshotai/kimi-k3', 'kimi'],
  ])('%s wears its lab logo (%s)', (id, provider) => {
    const p = modelProvider(id);
    expect(p.id).toBe(provider);
    expect(providerIconHtml(p, id)).toMatch(/<svg[\s\S]*path/i);
  });

  it('does not read ordinary words as a lab', () => {
    expect(modelProvider('kling-2').id).toBe('unknown');
    expect(modelProvider('stepper-1').id).toBe('unknown');
  });

  // nick, 2026-10-19: "No more question mark logos." A lab with no logo (opencode's stealth models)
  // wears the model's initial; a seat with no model at all wears an empty ring.
  it.each([
    ['beam-free', 'B'],
    ['fledge-alpha-free', 'F'],
    ['space-bunny-free', 'S'],
  ])('%s → a %s monogram, never "?"', (id, letter) => {
    const html = providerIconHtml(modelProvider(id), id);
    expect(html).toContain(`>${letter}<`);
    expect(html).not.toContain('?');
  });

  it('no model at all → an empty ring, never "?"', () => {
    for (const html of [
      providerIconHtml(modelProvider(null)),
      providerIconHtml(modelProvider('unknown'), 'unknown'),
    ]) {
      expect(html).toContain('<svg');
      expect(html).not.toContain('?');
    }
  });
});
