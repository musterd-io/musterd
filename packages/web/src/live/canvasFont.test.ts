import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetCanvasFontCache, canvasFont, preloadCanvasFont } from './canvasFont';

describe('canvasFont', () => {
  afterEach(() => {
    _resetCanvasFontCache();
    vi.unstubAllGlobals();
  });

  it('falls back to a literal DM Sans stack with no DOM (SSR)', () => {
    vi.stubGlobal('document', undefined);
    expect(canvasFont(12)).toBe('700 12px "DM Sans", system-ui, sans-serif');
    expect(canvasFont(11, '--font-mono', 400)).toBe(
      '400 11px "JetBrains Mono", ui-monospace, monospace',
    );
  });

  it('reads the resolved token off the document root when present', () => {
    vi.stubGlobal('document', { documentElement: {}, fonts: undefined });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (p: string) =>
        p === '--font-display' ? " 'DM Sans', ui-sans-serif, system-ui, sans-serif " : '',
    }));
    // trailing/leading whitespace trimmed; weight + px prefixed
    expect(canvasFont(15)).toBe("700 15px 'DM Sans', ui-sans-serif, system-ui, sans-serif");
  });

  it('caches the resolved stack (getComputedStyle called once per token)', () => {
    const spy = vi.fn(() => ({ getPropertyValue: () => "'DM Sans'" }));
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', spy);
    canvasFont(10);
    canvasFont(20);
    canvasFont(30);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('preloadCanvasFont drives document.fonts.load and swallows rejection', async () => {
    const load = vi.fn(() => Promise.reject(new Error('nope')));
    vi.stubGlobal('document', { documentElement: {}, fonts: { load } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => "'DM Sans'" }));
    expect(() => preloadCanvasFont()).not.toThrow();
    expect(load).toHaveBeenCalledWith("700 16px 'DM Sans'");
    await Promise.resolve();
  });

  it('preloadCanvasFont is a no-op without document.fonts', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    expect(() => preloadCanvasFont()).not.toThrow();
  });
});
