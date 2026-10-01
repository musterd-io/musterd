import { describe, expect, it } from 'vitest';
import { NextBriefSchema } from './lanes.js';
import {
  ReviewPromiseAuditRowSchema,
  ReviewPromiseClosureRowSchema,
  ReviewPromiseOpenRowSchema,
  ReviewPromiseReferenceSchema,
  ReviewPromisesQuerySchema,
  ReviewPromisesResponseSchema,
} from './review-promise.js';

const requestId = '01JGFJJZ6R2Q5Z4N8VY7Q5H1KM';
const reference = { kind: 'pr', repo: 'SandRiseStudio/musterd', number: 42 } as const;
const openRow = {
  request_id: requestId,
  requester: 'Ada',
  owner: 'Lin',
  context: 'Please review the protocol change',
  review: reference,
  accepted_at: 1790812800000,
} as const;

describe('ReviewPromiseReferenceSchema', () => {
  it('accepts PR, commit, Lane, and HTTPS URL references', () => {
    expect(ReviewPromiseReferenceSchema.parse(reference)).toEqual(reference);
    expect(
      ReviewPromiseReferenceSchema.parse({
        kind: 'commit',
        repo: 'org/repo',
        sha: '0123456789abcdef0123456789abcdef01234567',
      }).kind,
    ).toBe('commit');
    expect(
      ReviewPromiseReferenceSchema.parse({
        kind: 'commit',
        repo: 'org/repo',
        sha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        path: 'packages/protocol/src/review-promise.ts',
      }).kind,
    ).toBe('commit');
    expect(
      ReviewPromiseReferenceSchema.parse({ kind: 'lane', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).kind,
    ).toBe('lane');
    expect(
      ReviewPromiseReferenceSchema.safeParse({ kind: 'lane', id: 'not-a-lane-id' }).success,
    ).toBe(false);
    expect(
      ReviewPromiseReferenceSchema.parse({
        kind: 'url',
        url: 'https://github.com/org/repo/pull/42',
      }).kind,
    ).toBe('url');
  });

  it('rejects non-positive PR numbers and malformed repository slugs', () => {
    for (const number of [0, -1, 1.5]) {
      expect(ReviewPromiseReferenceSchema.safeParse({ ...reference, number }).success).toBe(false);
    }
    for (const repo of [
      'owner',
      '/repo',
      'owner/',
      'owner/repo/extra',
      'bad owner/repo',
      'owner/..',
    ]) {
      expect(ReviewPromiseReferenceSchema.safeParse({ ...reference, repo }).success, repo).toBe(
        false,
      );
    }
  });

  it('rejects malformed commit hashes and non-repository-relative paths', () => {
    const validSha = '0123456789abcdef0123456789abcdef01234567';
    for (const sha of ['0123456789abcdef', 'g'.repeat(40), 'f'.repeat(41)]) {
      expect(
        ReviewPromiseReferenceSchema.safeParse({ kind: 'commit', repo: 'org/repo', sha }).success,
        sha,
      ).toBe(false);
    }
    for (const path of [
      '../secrets.txt',
      'src/../secrets.txt',
      './src/file.ts',
      'src/./file.ts',
      '/etc/passwd',
    ]) {
      expect(
        ReviewPromiseReferenceSchema.safeParse({
          kind: 'commit',
          repo: 'org/repo',
          sha: validSha,
          path,
        }).success,
        path,
      ).toBe(false);
    }
  });

  it('rejects non-HTTPS URLs, userinfo, query strings, and fragments', () => {
    for (const url of [
      'http://github.com/org/repo/pull/42',
      'ftp://github.com/org/repo/pull/42',
      '/org/repo/pull/42',
      'https://user:password@example.com/review',
      'https://@example.com/review',
      'https://example.com/review?token=secret',
      'https://example.com/review?',
      'https://example.com/review#diff',
      'https://example.com/review#',
    ]) {
      expect(ReviewPromiseReferenceSchema.safeParse({ kind: 'url', url }).success, url).toBe(false);
    }
  });
});

describe('review-promise projection schemas', () => {
  it('validates per-Member open and closure rows with timestamps', () => {
    expect(ReviewPromiseOpenRowSchema.parse(openRow)).toEqual(openRow);
    expect(ReviewPromiseOpenRowSchema.safeParse({ ...openRow, accepted_at: -1 }).success).toBe(
      false,
    );

    const closure = {
      request_id: requestId,
      resolve_id: '01JGFJJZ6R2Q5Z4N8VY7Q5H1KN',
      closer: 'Mira',
      resolved_at: 1790816400000,
    };
    expect(ReviewPromiseClosureRowSchema.parse(closure)).toEqual(closure);
    expect(ReviewPromiseClosureRowSchema.safeParse({ ...closure, resolved_at: -1 }).success).toBe(
      false,
    );
  });

  it('parses legacy briefs without adding absent review arrays', () => {
    const legacy = NextBriefSchema.parse({
      member: 'Ada',
      in_flight: [],
      shipped: [],
      up_next: [],
      why: null,
      next_goal: null,
    });

    expect(legacy).not.toHaveProperty('request_reviews');
    expect(legacy).not.toHaveProperty('requested_reviews');
    expect(legacy).not.toHaveProperty('review_closures');
  });

  it('preserves explicitly supported empty arrays in NextBrief', () => {
    const supported = NextBriefSchema.parse({
      member: 'Ada',
      in_flight: [],
      shipped: [],
      up_next: [],
      why: null,
      next_goal: null,
      request_reviews: [],
      requested_reviews: [],
      review_closures: [],
    });

    expect(supported.request_reviews).toEqual([]);
    expect(supported.requested_reviews).toEqual([]);
    expect(supported.review_closures).toEqual([]);
  });

  it('accepts only the open review-promises query', () => {
    expect(ReviewPromisesQuerySchema.parse({ open: '1' })).toEqual({ open: '1' });
    expect(ReviewPromisesQuerySchema.safeParse({ open: '0' }).success).toBe(false);
    expect(ReviewPromisesQuerySchema.safeParse({}).success).toBe(false);
    expect(ReviewPromisesQuerySchema.safeParse({ open: '1', limit: '20' }).success).toBe(false);
  });

  it('requires minimal audit rows and a required response array', () => {
    const auditRow = {
      request_id: requestId,
      requester: 'Ada',
      owner: 'Lin',
      accepted_at: 1790812800000,
    };
    expect(ReviewPromiseAuditRowSchema.parse(auditRow)).toEqual(auditRow);
    for (const extra of [
      { context: 'private request context' },
      { review: reference },
      { artifact: 'https://example.com/private' },
    ]) {
      expect(ReviewPromiseAuditRowSchema.safeParse({ ...auditRow, ...extra }).success).toBe(false);
    }
    expect(ReviewPromisesResponseSchema.parse({ review_promises: [] })).toEqual({
      review_promises: [],
    });
    expect(ReviewPromisesResponseSchema.safeParse({}).success).toBe(false);
  });
});
