/**
 * ADR 747, without a validator: the wiki source's bounds and checks, so /live's settings can say a
 * URL is wrong before it posts. `wiki.ts` builds its schema from these.
 */

/** The folder musterd's own guidance tells every Team to keep its wiki in (ADR 259). */
export const WIKI_DEFAULT_PATH = 'docs/wiki';

/** Index ceiling: a folder past this many pages is listed up to it, and says it was cut. */
export const WIKI_MAX_PAGES = 2_000;

/** One page's ceiling, in bytes. A larger file is listed but not served. */
export const WIKI_MAX_PAGE_BYTES = 1_000_000;

/**
 * Why a repo URL is refused, or null. Only `https://`, `ssh://` and scp-form `user@host:path` reach
 * `git`: `file://`, `ext::` and bare paths would let a Team point the daemon at its own disk or at
 * an arbitrary command. A leading `-` would read as a git option.
 */
export function wikiRepoProblem(raw: string): string | null {
  const url = raw.trim();
  if (url === '') return 'is empty';
  if (url.startsWith('-')) return 'may not begin with "-"';
  if (/\s/.test(url)) return 'may not contain spaces';
  if (/^https:\/\/[^/@\s]+(?::\d+)?\/.+/i.test(url)) return null;
  if (/^ssh:\/\/[^/\s]+\/.+/i.test(url)) return null;
  if (/^[\w.-]+@[\w.-]+:(?!\/\/)[^\s]+$/.test(url)) return null;
  return 'must be an https:// or ssh git URL (e.g. https://github.com/acme/app)';
}

/** Why a wiki folder is refused, or null: a relative path inside the repo, never above it. */
export function wikiPathProblem(raw: string): string | null {
  if (raw.startsWith('/')) return 'must be relative to the repo root';
  if (raw.split('/').some((part) => part === '..')) return 'may not contain ".."';
  if (/[\0\\]/.test(raw)) return 'may not contain backslashes';
  return null;
}
