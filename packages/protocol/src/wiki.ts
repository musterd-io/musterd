import { z } from 'zod';
import { WIKI_DEFAULT_PATH, wikiPathProblem, wikiRepoProblem } from './wiki.wire.js';

export {
  WIKI_DEFAULT_PATH,
  WIKI_MAX_PAGE_BYTES,
  WIKI_MAX_PAGES,
  repoFileUrl,
  repoWebBase,
  wikiPathProblem,
  wikiRepoProblem,
} from './wiki.wire.js';

/**
 * ADR 747: where a Team's wiki lives — a folder of its repo's default branch, read by the daemon
 * with `git`. The repo is the single source of truth; the daemon's copy is a disposable cache.
 */

export const WikiSourceSchema = z.object({
  repo: z
    .string()
    .max(500)
    .superRefine((v, ctx) => {
      const problem = wikiRepoProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wiki repo ${problem}` });
    }),
  path: z
    .string()
    .max(200)
    .transform((v) =>
      v
        .trim()
        .replace(/^\.\/+/, '')
        .replace(/\/+$/, ''),
    )
    .superRefine((v, ctx) => {
      const problem = wikiPathProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `wiki path ${problem}` });
    })
    .default(WIKI_DEFAULT_PATH),
});
export type WikiSource = z.infer<typeof WikiSourceSchema>;

/** One page in the index `GET /teams/:team/wiki` returns. */
export const WikiPageEntrySchema = z.object({
  /** Path inside the wiki folder, e.g. `amending-an-adr.md` or `ops/rotation.md`. */
  path: z.string(),
  /** The page's first `# ` heading, else its file name without `.md`. */
  title: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type WikiPageEntry = z.infer<typeof WikiPageEntrySchema>;

export const WikiIndexSchema = z.discriminatedUnion('state', [
  /** No `wiki` knob on the Team's policy. */
  z.object({ state: z.literal('unlinked') }),
  z.object({
    state: z.literal('ready'),
    repo: z.string(),
    path: z.string(),
    /** The default-branch commit the index was read at. */
    commit: z.string(),
    /** The branch name the remote's HEAD points at, for links out to the host. */
    branch: z.string(),
    pages: z.array(WikiPageEntrySchema),
    /** The folder held more than {@link WIKI_MAX_PAGES} pages and the list was cut. */
    truncated: z.boolean(),
    /** The freshness check failed; this is the last good read. */
    stale: z.boolean(),
  }),
  /** The first fetch failed and there is no cache to fall back on. `detail` is git's first line. */
  z.object({ state: z.literal('failed'), repo: z.string(), path: z.string(), detail: z.string() }),
]);
export type WikiIndex = z.infer<typeof WikiIndexSchema>;

export const WikiPageSchema = z.object({
  path: z.string(),
  commit: z.string(),
  markdown: z.string(),
  /**
   * ADR 754: the page rendered to HTML by the daemon (raw HTML escaped, links vetted and sorted —
   * ADR 747's rules), so no viewer ships a markdown parser. Absent from an older daemon: show the
   * markdown as text.
   */
  html: z.string().optional(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;
