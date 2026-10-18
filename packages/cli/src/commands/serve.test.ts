import { describe, expect, it } from 'vitest';
import { buildFromFlyImage } from './serve.js';

describe('buildFromFlyImage (a Cloud daemon has no .git)', () => {
  const sha = '6fd7aca44986' + 'a'.repeat(28);

  it('reads the full sha from the label deploy.mjs pushes, with or without a digest', () => {
    expect(buildFromFlyImage(`registry.fly.io/musterd-cloud:git-${sha}`)).toBe(sha);
    expect(
      buildFromFlyImage(`registry.fly.io/musterd-cloud:git-${sha}@sha256:${'b'.repeat(64)}`),
    ).toBe(sha);
  });

  it('reports no build for a short label, a hand-run deploy or no env', () => {
    // A 12-char build would never equal a 40-char adapter stamp: every skew check would cry wolf.
    expect(buildFromFlyImage('registry.fly.io/musterd-cloud:git-6fd7aca44986')).toBeUndefined();
    expect(buildFromFlyImage('registry.fly.io/musterd-cloud:deployment-01J2')).toBeUndefined();
    expect(buildFromFlyImage(undefined)).toBeUndefined();
  });
});
