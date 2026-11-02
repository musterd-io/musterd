import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveFetchError } from './client';
import { Refusal, refusalOf } from './Refusal';

describe('Refusal, rendered (lane 01M6EPXA6Z)', () => {
  it("says the person's line as an alert and keeps the daemon's words behind a details disclosure", () => {
    const e = new LiveFetchError(
      'authority refused (no_signature): human answers to privileged asks require an A2 device signature (ADR 662)',
      'forbidden',
      403,
    );
    const html = renderToStaticMarkup(createElement(Refusal, { refusal: refusalOf(e) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('This needs your passkey. Press Approve again and confirm with your passkey.');
    expect(html).toContain('<details');
    expect(html).toContain('forbidden: authority refused (no_signature)');
    // The line itself never carries the code or the ADR.
    const line = /lc-refusal__line">([^<]*)</.exec(html)![1]!;
    expect(line).not.toMatch(/ADR|no_signature|descriptor/);
  });

  it('an unknown error renders its words with no disclosure', () => {
    const html = renderToStaticMarkup(createElement(Refusal, { refusal: refusalOf(new Error('boom')) }));
    expect(html).toContain('boom');
    expect(html).not.toContain('<details');
  });
});
