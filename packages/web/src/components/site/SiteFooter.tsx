import { Footer } from '../Footer';

/**
 * The public-site footer. The existing landing Footer is already surface-generic (wordmark +
 * SPEC/DOCS links; the GitHub link is in the nav since ADR 565), so this is an alias that gives content routes a site-scoped name —
 * if the footers ever diverge, they diverge here rather than in every route.
 */
export function SiteFooter() {
  return <Footer />;
}
