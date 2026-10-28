import { Marked, type Tokens } from 'marked';

/**
 * A wiki page's markdown to HTML for the overlay (ADR 747). The page comes from a Team's repo, so it
 * is treated as untrusted: raw HTML is shown as text and never parsed, and a link is followed only to
 * `http`, `https` or `mailto`. Links are sorted three ways:
 *
 * - another page in the wiki folder → `data-wiki-page`, which the overlay opens in place;
 * - anything else in the repo (an ADR, a source file) → the file on its host at the read commit,
 *   when the host is one we know how to link to; plain text otherwise;
 * - an absolute web link → itself, in a new tab.
 */

export interface WikiLinkContext {
  repo: string;
  /** The wiki folder in the repo, e.g. `docs/wiki` (empty: the repo root). */
  folder: string;
  commit: string;
  /** The page being rendered, relative to the folder. */
  page: string;
  /** Every page in the index, relative to the folder. */
  pages: ReadonlySet<string>;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** `https://host/owner/repo` for a GitHub, GitLab or Codeberg remote, else null. */
export function repoWebBase(repo: string): { base: string; kind: 'github' | 'gitlab' | 'codeberg' } | null {
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(repo);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(repo);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!path.includes('/')) return null;
  const kind =
    host === 'github.com'
      ? 'github'
      : host === 'gitlab.com'
        ? 'gitlab'
        : host === 'codeberg.org'
          ? 'codeberg'
          : null;
  return kind ? { base: `https://${host}/${path}`, kind } : null;
}

/** The web URL of one repo file at a commit, or null for a host we cannot link into. */
export function repoFileUrl(repo: string, commit: string, file: string): string | null {
  const web = repoWebBase(repo);
  if (!web) return null;
  const f = file.split('/').map(encodeURIComponent).join('/');
  if (web.kind === 'github') return `${web.base}/blob/${commit}/${f}`;
  if (web.kind === 'gitlab') return `${web.base}/-/blob/${commit}/${f}`;
  return `${web.base}/src/commit/${commit}/${f}`;
}

export type ResolvedLink =
  | { kind: 'page'; page: string; hash: string }
  | { kind: 'out'; href: string }
  | { kind: 'none' };

/** Where a link in a wiki page goes (see the module comment). */
export function resolveWikiLink(href: string, ctx: WikiLinkContext): ResolvedLink {
  const raw = href.trim();
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: 'out', href: raw };
  // Any other scheme (javascript:, data:, file:, …) or a protocol-relative URL goes nowhere.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return { kind: 'none' };
  if (raw.startsWith('#')) return { kind: 'page', page: ctx.page, hash: raw.slice(1) };
  const folder = ctx.folder === '' ? '' : `${ctx.folder}/`;
  const here = new URL(`https://wiki.invalid/${folder}${ctx.page}`);
  let target: URL;
  try {
    target = new URL(raw, here);
  } catch {
    return { kind: 'none' };
  }
  const file = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const hash = target.hash.replace(/^#/, '');
  if (file.startsWith(folder) && ctx.pages.has(file.slice(folder.length))) {
    return { kind: 'page', page: file.slice(folder.length), hash };
  }
  const url = repoFileUrl(ctx.repo, ctx.commit, file);
  return url ? { kind: 'out', href: url + (target.hash || '') } : { kind: 'none' };
}

export function renderWikiPage(markdown: string, ctx: WikiLinkContext): string {
  const md = new Marked({ gfm: true, async: false });
  md.use({
    renderer: {
      // Comments vanish, as in any markdown viewer (the wiki's `<!-- claim: … -->` markers); every
      // other tag is shown as the text it is.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text.replace(/<!--[\s\S]*?-->/g, ''));
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        const to = resolveWikiLink(href, ctx);
        if (to.kind === 'page') {
          return `<a href="#" data-wiki-page="${escapeHtml(to.page)}" data-wiki-hash="${escapeHtml(to.hash)}"${t}>${inner}</a>`;
        }
        if (to.kind === 'out') {
          return `<a href="${escapeHtml(to.href)}" target="_blank" rel="noopener noreferrer"${t}>${inner}</a>`;
        }
        return `<span class="lc-wiki__deadlink"${t}>${inner}</span>`;
      },
      // Images are not fetched from a page's links (they would leave the daemon's origin on every
      // open); the alt text links to the image where the host can show it.
      image({ href, text }: Tokens.Image) {
        const to = resolveWikiLink(href, ctx);
        const label = escapeHtml(text || 'image');
        return to.kind === 'out'
          ? `<a href="${escapeHtml(to.href)}" target="_blank" rel="noopener noreferrer">[${label}]</a>`
          : `[${label}]`;
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = slugify(inner.replace(/<[^>]+>/g, ''));
        return `<h${depth} id="wiki-${id}">${inner}</h${depth}>\n`;
      },
    },
  });
  return md.parse(markdown) as string;
}

/** GitHub-style heading anchors, so `page.md#some-heading` lands. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}
