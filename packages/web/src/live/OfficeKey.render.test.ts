import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfficeKey } from './OfficeKey';

describe('OfficeKey — how to read the office (ADR 464 §3.4)', () => {
  it('names the four postures and offers a close', () => {
    const html = renderToStaticMarkup(createElement(OfficeKey));
    for (const line of [
      'at a desk',
      'working',
      'on the couch',
      'between tasks',
      'carrying a box',
      'handing off',
      'asking a human',
    ]) {
      expect(html).toContain(line);
    }
    expect(html).toContain('aria-label="Close the key"');
    expect(html).toContain('data-open="true"');
  });
});
