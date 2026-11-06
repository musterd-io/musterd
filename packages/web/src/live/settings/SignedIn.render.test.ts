import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SignInRow } from './signIns';
import { SignedInList } from './SignedIn';

/** "Where you're signed in" (sign-in copy spec §6), rendered as the other render tests do. */
const NOW = 1_800_000_000_000;
const row = (over: Partial<SignInRow>): SignInRow => ({
  key: 'browser:s1',
  kind: 'browser',
  id: 's1',
  device: 'This browser',
  how: 'Browser',
  lastUsedAt: NOW,
  current: true,
  action: 'Sign out',
  ...over,
});
const noop = () => undefined;
const render = (rows: SignInRow[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(SignedInList, {
      team: 'revive',
      member: 'nick',
      rows,
      now: NOW,
      busy: null,
      confirming: false,
      done: null,
      failed: null,
      onSignOut: noop,
      onAskAll: noop,
      onCancelAll: noop,
      onConfirmAll: noop,
      ...over,
    }),
  );

describe('SignedInList', () => {
  it('heads and ledes as the copy spec says', () => {
    const html = render([
      row({}),
      row({
        key: 'client:c1',
        kind: 'client',
        id: 'c1',
        device: 'Connected app',
        how: 'Claude',
        current: false,
        lastUsedAt: NOW - 5 * 60_000,
      }),
    ]);
    expect(html).toContain('Where you&#x27;re signed in');
    expect(html).toContain('Every device and app signed in to revive as nick.');
    expect(html).toContain('This browser');
    expect(html).toContain('· Claude · 5m ago');
    expect(html).toContain('aria-label="Sign out Connected app"');
    expect(html).toContain('Sign out everywhere on revive');
  });

  it('says so when this browser is the only one', () => {
    const html = render([row({})]);
    expect(html).toContain('Only this browser is signed in.');
    expect(html).not.toContain('aria-label="Sign out This browser"');
  });

  it('asks before signing out everywhere, naming this one too', () => {
    const html = render(
      [
        row({}),
        row({
          key: 'phone:p1',
          kind: 'phone',
          id: 'p1',
          device: 'Phone',
          how: 'Phone',
          current: false,
        }),
      ],
      { confirming: true },
    );
    expect(html).toContain('This signs out every device and app on revive, this one too.');
    expect(html).toContain('>Sign out everywhere<');
    expect(html).toContain('>Cancel<');
    expect(html).not.toContain('Sign out everywhere on revive');
  });

  it('announces what it just did in a polite live region', () => {
    const html = render([row({})], { done: 'Phone is signed out.' });
    expect(html).toMatch(/role="status" aria-live="polite">Phone is signed out\./);
  });
});
