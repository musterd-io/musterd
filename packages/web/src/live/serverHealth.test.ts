import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HealthBanner } from './HealthBanner';
import { healthPollAfter, healthReason } from './serverHealth';

/** Cloud spec §7: database down → `/health` is 503 with a stable sentence, and `/live` says so. */
describe('healthReason', () => {
  it('a Cloud 503 with a stable sentence is the banner text', () => {
    expect(healthReason(503, { ok: false, reason: 'database unreachable' })).toBe(
      'database unreachable',
    );
  });

  it('healthy answers — Cloud or self-hosted — show nothing', () => {
    expect(healthReason(200, { ok: true })).toBeNull();
    expect(healthReason(200, { ok: true, v: 'musterd/0.3', epoch: 14 })).toBeNull();
  });

  it('a 503 that is not ours (a proxy page, no reason) shows nothing rather than a guess', () => {
    expect(healthReason(503, '<html>bad gateway</html>')).toBeNull();
    expect(healthReason(503, { ok: false })).toBeNull();
  });

  it('polls quickly while down, so the banner clears soon after recovery', () => {
    const down = healthPollAfter(503, { ok: false, reason: 'database unreachable' });
    const up = healthPollAfter(200, { ok: true });
    expect(down).not.toBeNull();
    expect(up).not.toBeNull();
    expect(down!).toBeLessThan(up!);
  });

  it('stops polling a self-hosted daemon — its detailed /health is costly and can never be the Cloud 503', () => {
    expect(
      healthPollAfter(200, { ok: true, v: 'musterd/0.3', epoch: 14, connections: 3 }),
    ).toBeNull();
  });

  it('keeps polling when it cannot tell (a network failure or a proxy page)', () => {
    expect(healthPollAfter(0, null)).not.toBeNull();
    expect(healthPollAfter(502, '<html>bad gateway</html>')).not.toBeNull();
  });
});

describe('HealthBanner', () => {
  it('renders the sentence verbatim as an alert', () => {
    const html = renderToStaticMarkup(
      createElement(HealthBanner, { reason: 'database unreachable' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('database unreachable');
  });

  it('renders nothing when healthy', () => {
    expect(renderToStaticMarkup(createElement(HealthBanner, { reason: null }))).toBe('');
  });
});
