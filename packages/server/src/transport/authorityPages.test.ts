import { describe, expect, it } from 'vitest';
import { passkeyApprovePage, passkeyEnrollPage } from './authorityPages.js';

/** The ceremony pages are served as strings; these read the script a browser would run. */
describe('passkey pages on a non-secure origin (lane 01M6Q1X9J0)', () => {
  const guard =
    "const insecure = !(window.isSecureContext && navigator.credentials && typeof navigator.credentials.get === 'function');";

  it('both pages test for WebAuthn before anything can call it, and say where to go instead', () => {
    for (const page of [passkeyApprovePage, passkeyEnrollPage]) {
      const at = page.indexOf(guard);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(page.indexOf('navigator.credentials.'));
      expect(page).toContain('Passkeys only work on https or localhost');
      expect(page).toContain("fetch('/health')");
      expect(page).toContain('j.browser_origin');
      expect(page).toContain('location.pathname + location.search + location.hash');
    }
  });

  it('keeps the approve button off even after the descriptor loads, and both clicks bail out', () => {
    expect(passkeyApprovePage).toContain(
      "document.getElementById('go').disabled = insecure || passkeys.length === 0;",
    );
    expect(passkeyApprovePage.match(/if \(insecure\) return;/g)).toHaveLength(1);
    expect(passkeyEnrollPage.match(/if \(insecure\) return;/g)).toHaveLength(1);
  });
});
