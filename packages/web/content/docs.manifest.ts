/**
 * The ONLY repo files that reach the public /docs section (ADR 302). Entries resolve relative to
 * the REPO ROOT. An explicit list, never a glob: repo docs are written for the team, and each
 * line here is a deliberate publish decision. `gen-site-content.ts` fails the build if a source
 * is missing. `title: null` lifts the title from the file's first `# ` heading.
 */
export interface DocEntry {
  slug: string;
  title: string | null;
  source: string;
}

export const DOCS_MANIFEST: DocEntry[] = [
  // No getting-started/install page: the repository went private on 2026-10-03 and there is nothing
  // public to install. Restore it from git history (packages/web/content/docs/getting-started.md) when
  // musterd opens up.
  { slug: 'concepts', title: null, source: 'packages/web/content/docs/concepts.md' },
  // The protocol spec is designed in the open (MIT, versioned from the first commit) — the one
  // team file that is already written for outside readers.
  { slug: 'spec', title: 'Protocol spec', source: 'SPEC.md' },
];
