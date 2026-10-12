import { createFileRoute } from '@tanstack/react-router';
import officeStill from '../brand/office-still.png?url';
import { breadcrumbNode, pageHead, webPageNode } from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { StartPage } from '../components/site/start/StartPage';
import { START_COPY } from '../components/site/start/startCopy';
import { WATCH_COPY } from '../components/site/watchCopy';

/**
 * The first session's front door (first-run-10-minutes goal).
 *
 * Public and prerendered like /watch, with no daemon behind it — the surfaces the tour runs
 * in (/live, /board) stay off this origin by design (ADR 132, ADR 156). This page is a
 * preview of that session: structure, stills and preview wording. Final copy is alfie's lane
 * 01M4FDBXPX; the homepage block links here (FIRST_TEN_MINUTES_PATH).
 *
 * Every string is preview wording: honest about the private preview, with no state word and
 * no promise of an install date. The share card is the office still — the page is about the
 * picture of the team at work, the same exception /watch claims in siteMeta.ts.
 */
export const Route = createFileRoute('/start')({
  head: () =>
    pageHead({
      title: START_COPY.title,
      description: START_COPY.description,
      path: '/start',
      image: { url: officeStill, alt: WATCH_COPY.stillAlt },
      graph: [
        webPageNode({
          name: START_COPY.h1,
          description: START_COPY.description,
          path: '/start',
        }),
        breadcrumbNode([{ name: 'Start', path: '/start' }]),
      ],
    }),
  component: Start,
});

function Start() {
  return (
    <main className="site-page">
      <SiteNav />
      <StartPage />
      <SiteFooter />
    </main>
  );
}
