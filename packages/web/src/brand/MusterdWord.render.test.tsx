import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MusterdWord } from './MusterdWord';

/**
 * The lockup carries the address only where it is asked to. This is not a style preference: the
 * office mark is stamped on every frame that leaves the app, for a viewer with no address bar, and
 * the site's own nav and footer are read by someone already at that address. One component, two
 * jobs, and the default must stay the quiet one — a `domain` that leaked into SiteNav would put the
 * URL in the corner of the page it points at.
 */
describe('MusterdWord', () => {
  it('is the bare wordmark by default', () => {
    const html = renderToStaticMarkup(<MusterdWord />);
    expect(html).toContain('aria-label="musterd"');
    expect(html).not.toContain('.io');
  });

  it('carries the address when asked, as its own span after the wordmark', () => {
    const html = renderToStaticMarkup(<MusterdWord domain />);
    expect(html).toContain('aria-label="musterd"');
    expect(html).toMatch(/<\/svg><span class="brand__tld">\.io<\/span>/);
  });

  it('sizes the plate from chipSize, so old chip sizes keep their footprint', () => {
    expect(renderToStaticMarkup(<MusterdWord chipSize={16} />)).toContain('height="28"');
    expect(renderToStaticMarkup(<MusterdWord chipSize={15} />)).toContain('height="26"');
  });
});
