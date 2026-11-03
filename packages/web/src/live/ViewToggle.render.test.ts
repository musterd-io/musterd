import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ViewToggle } from './ViewToggle';

/**
 * The "Outside" button beside the sound toggle (window views inc 3, lane 01M6ENHBPB), rendered with
 * `react-dom/server` as the other `*.render.test.ts` files do. Claims: it names what is outside now
 * and what a click brings, and draws that view's own glyph.
 */
describe('ViewToggle', () => {
  it('names the current view and the next one', () => {
    const html = renderToStaticMarkup(createElement(ViewToggle, { initial: 'coast' }));
    expect(html).toContain('aria-label="Outside: coast — click for mountain"');
    expect(html).toContain('data-view="coast"');
  });

  it('defaults to the city', () => {
    const html = renderToStaticMarkup(createElement(ViewToggle, {}));
    expect(html).toContain('data-view="city"');
  });
});
