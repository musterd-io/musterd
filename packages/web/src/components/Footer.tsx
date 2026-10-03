import './Footer.css';
import { MusterdChip } from '../brand/MusterdWord';

/** On-site links only: the repository is private (2026-10-03), so nothing here may point at github.com. */
const LINKS = [
  { label: 'SPEC', href: '/docs/spec' },
  { label: 'DOCS', href: '/docs' },
];

export function Footer() {
  return (
    <footer className="footer shell">
      <div className="footer__mark">
        <span className="footer__word mono">
          <MusterdChip size={18} className="footer__chip" />
          musterd
        </span>
        <span className="footer__by">a SandRise Studio product</span>
      </div>
      <nav className="footer__links" aria-label="Footer">
        {LINKS.map((l) => (
          <a key={l.label} className="footer__link mono" href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
