# 556 — Exploring Next full-script API credential

- Status: accepted
- Date: 2026-10-09
- Deciders: nick (approved the research-radar automation plan, 2026-10-09)
- Lane: `01M4GQJSP8AQND8S8N6A82H0T8`
- Builds on: the approved full-text research radar design and plan

## Context

The research radar reads the complete original article for each candidate and requires the full
Exploring Next script for every attached episode. The existing feed contains an episode UUID and
article URL. The source adapter already uses an Exploring Next credential for its metadata feed.

The official [Exploring Next API documentation](https://sandrise.io/exploring-next/api) documents
`GET https://ingest.sandrise.io/v1/episodes/{idOrNumber}/script`. The path accepts an episode UUID
or episode number. It requires a bearer API key named `EXPLORING_API_KEY` and returns episode
metadata, chapters, and ordered `{speaker, text}` dialogue segments. This endpoint is subject to a
120-requests-per-minute limit; the provider's existing snapshot client paces requests at least
700 ms apart and retries boundedly.

## Problem

The approved design and implementation plan named an unverified `get_episode_script` operation,
omitted its required credential, and did not carry over the provider's request pacing. A workflow
without the key cannot satisfy the complete-script requirement, and ignoring rate limits can turn
a normal batch into avoidable failures.

## Decision

1. Fetch each attached episode script from the documented REST endpoint using the episode UUID
   already carried by the radar candidate and `Authorization: Bearer $EXPLORING_API_KEY`.
2. Require `EXPLORING_API_KEY` alongside the existing three workflow secrets. Missing credentials
   fail visibly before files are written; never log the key or authorization header.
3. Space Exploring Next script requests at least 700 ms apart, honor `Retry-After` on HTTP 429, and
   use bounded retries. A missing, empty, or unavailable script remains a retryable candidate
   failure; never substitute the feed summary or transcript excerpt.
4. Treat the response as ephemeral input. Persist only candidate metadata and derived evidence;
   do not archive or redistribute scripts. Digest findings link to the source episode. Any displayed
   or quoted Exploring Next material must attribute and link to Exploring Next.
5. Keep article retrieval through Exa, the weekly workflow, the existing no-auto-merge rule, and the
   human research-foundation/ADR gate as already approved.

## Consequences

The workflow now depends on a fourth secret and may take longer while respecting provider pacing.
The API is read-only and accessed through its documented endpoint, with the provider's access
control and rate limits intact. Script text remains transient and is not retained in git artifacts.
If credentials or the endpoint are unavailable, the affected candidate stays pending for a later
run instead of receiving a partial-read verdict.

## Observability & Evaluation

**Traces.** Record the candidate ID, episode ID, endpoint outcome/status, attempt count, and elapsed
time in the run summary. Do not record response text, secrets, or authorization headers. Count
complete scripts, failed scripts by stable category, rate-limit responses, and retries.

**Eval.** Dataset: fixture responses for a successful multi-segment script, an empty script, an
unauthorized response, and a 429 with `Retry-After`. Baseline: before this correction the plan used
an unverified operation and had no required script credential or explicit pacing. The adapter must
parse every segment in order, return a complete script only for a successful non-empty response,
and remain within the documented request pacing.

**Experiment.** In a manual workflow dispatch with valid secrets, process one known Exploring Next
episode and confirm all script segments reach chunking, the digest contains only derived findings
and a source link, and the Actions summary contains request counts but no source text. A script
failure must leave that candidate pending. Missing key must fail before any ledger or digest write.
