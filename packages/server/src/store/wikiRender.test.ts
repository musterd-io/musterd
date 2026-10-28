import { repoFileUrl } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { renderWikiPage, resolveWikiLink, type WikiLinkContext } from './wiki.js';

const ctx: WikiLinkContext = {
  repo: 'https://github.com/musterd-io/musterd',
  folder: 'docs/wiki',
  commit: 'abc123',
  page: 'amending-an-adr.md',
  pages: new Set(['amending-an-adr.md', 'wake-leases.md', 'ops/rotation.md']),
};

describe('wiki rendering (ADR 747)', () => {
  it('shows raw HTML as text, never as markup', () => {
    const html = renderWikiPage(
      '<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)>',
      ctx,
    );
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('follows only http, https and mailto out; drops javascript and data', () => {
    expect(renderWikiPage('[x](javascript:alert(1))', ctx)).not.toMatch(/href="javascript/);
    expect(renderWikiPage('[x](data:text/html,hi)', ctx)).not.toMatch(/href="data/);
    expect(renderWikiPage('[x](https://example.com)', ctx)).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
  });

  it('opens another wiki page in place, with its anchor', () => {
    expect(resolveWikiLink('wake-leases.md#the-rule', ctx)).toEqual({
      kind: 'page',
      page: 'wake-leases.md',
      hash: 'the-rule',
    });
    expect(resolveWikiLink('./ops/rotation.md', ctx)).toMatchObject({ page: 'ops/rotation.md' });
    expect(resolveWikiLink('#top', ctx)).toEqual({
      kind: 'page',
      page: 'amending-an-adr.md',
      hash: 'top',
    });
  });

  it('sends the rest of the repo to its host at the read commit', () => {
    expect(resolveWikiLink('../decisions/259-wiki.md', ctx)).toEqual({
      kind: 'out',
      href: 'https://github.com/musterd-io/musterd/blob/abc123/docs/decisions/259-wiki.md',
    });
    expect(resolveWikiLink('missing.md', { ...ctx, repo: 'https://git.example.com/a/b' })).toEqual({
      kind: 'none',
    });
  });

  it('links GitLab, Codeberg and scp-form remotes', () => {
    expect(repoFileUrl('git@gitlab.com:acme/app.git', 'c1', 'a b.md')).toBe(
      'https://gitlab.com/acme/app/-/blob/c1/a%20b.md',
    );
    expect(repoFileUrl('https://codeberg.org/acme/app', 'c1', 'x.md')).toBe(
      'https://codeberg.org/acme/app/src/commit/c1/x.md',
    );
  });

  it('drops HTML comments, as a markdown viewer does', () => {
    const html = renderWikiPage('## The rule <!-- claim: other -->\n\n<!-- note -->\ntext', ctx);
    expect(html).not.toMatch(/claim|note|&lt;!--/);
    expect(html).toContain('id="wiki-the-rule"');
  });

  it('gives headings anchors', () => {
    expect(renderWikiPage('## The rule and its bad summary', ctx)).toContain(
      'id="wiki-the-rule-and-its-bad-summary"',
    );
  });
});
