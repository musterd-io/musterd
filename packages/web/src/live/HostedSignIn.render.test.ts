import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostedSignIn } from './HostedSignIn';

/**
 * The hosted team's signed-out card (ADR 722, unified sign-in §5): one way in, and nothing to
 * paste. Strings are sign-in copy spec §4's, verbatim.
 */
describe('HostedSignIn', () => {
  const render = (notice: string | null = null) =>
    renderToStaticMarkup(createElement(HostedSignIn, { notice }));

  it('is one link to the team’s own start route, labelled as the copy spec says', () => {
    const html = render();
    expect(html).toContain('href="/live/signin/start"');
    expect(html).toContain('>Sign in with musterd<');
  });

  it('has no credential or seat field to paste into', () => {
    const html = render();
    expect(html).not.toContain('<input');
    expect(html).not.toMatch(/credential|mscr_/i);
  });

  it('says why when a session ended elsewhere', () => {
    expect(render('You were signed out. Sign in again to keep going.')).toContain(
      'You were signed out. Sign in again to keep going.',
    );
    expect(render()).not.toContain('role="status"');
  });
});
