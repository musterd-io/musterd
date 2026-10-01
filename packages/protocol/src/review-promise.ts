import { z } from 'zod';

const REPOSITORY_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;
const FULL_COMMIT_SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const LANE_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

const RepositorySchema = z.string().regex(REPOSITORY_SLUG, 'repo must be an owner/name slug');
const CommitPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'path must be repository-relative and contain no . or .. segment',
  );

const HttpsUrlSchema = z.string().superRefine((value, ctx) => {
  const issue = () =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'url must be absolute HTTPS without credentials, query, or fragment',
    });

  if (value.trim() !== value || !/^https:\/\//i.test(value) || /[?#\\]/.test(value)) {
    issue();
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issue();
    return;
  }

  const authority = /^https:\/\/([^/]+)/i.exec(value)?.[1] ?? '';
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    authority.includes('@')
  ) {
    issue();
  }
});

/** A credential-free artifact reference attached to a typed review request (ADR 490, SPEC A.14). */
export const ReviewPromiseReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pr'),
      repo: RepositorySchema,
      number: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('commit'),
      repo: RepositorySchema,
      sha: z.string().regex(FULL_COMMIT_SHA, 'sha must contain 40 or 64 hexadecimal digits'),
      path: CommitPathSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('lane'),
      id: z.string().regex(LANE_ULID, 'id must be a Lane ULID'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('url'),
      url: HttpsUrlSchema,
    })
    .strict(),
]);
export type ReviewPromiseReference = z.infer<typeof ReviewPromiseReferenceSchema>;

/** An open review promise as seen by its owner or requester in `NextBrief`. */
export const ReviewPromiseOpenRowSchema = z
  .object({
    request_id: z.string().min(1),
    requester: z.string().min(1),
    owner: z.string().min(1),
    context: z.string(),
    review: ReviewPromiseReferenceSchema,
    accepted_at: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewPromiseOpenRow = z.infer<typeof ReviewPromiseOpenRowSchema>;

/** A non-owner resolution that remains visible until the owner's inbox cursor crosses it. */
export const ReviewPromiseClosureRowSchema = z
  .object({
    request_id: z.string().min(1),
    resolve_id: z.string().min(1),
    closer: z.string().min(1),
    resolved_at: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewPromiseClosureRow = z.infer<typeof ReviewPromiseClosureRowSchema>;

/** The only supported Team audit query. */
export const ReviewPromisesQuerySchema = z.object({ open: z.literal('1') }).strict();
export type ReviewPromisesQuery = z.infer<typeof ReviewPromisesQuerySchema>;

/** Minimal Team-wide row for the weekly audit; request prose and artifact refs are excluded. */
export const ReviewPromiseAuditRowSchema = z
  .object({
    request_id: z.string().min(1),
    requester: z.string().min(1),
    owner: z.string().min(1),
    accepted_at: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewPromiseAuditRow = z.infer<typeof ReviewPromiseAuditRowSchema>;

/** A supported Team read always includes the array, including when it is empty. */
export const ReviewPromisesResponseSchema = z
  .object({ review_promises: z.array(ReviewPromiseAuditRowSchema) })
  .strict();
export type ReviewPromisesResponse = z.infer<typeof ReviewPromisesResponseSchema>;
