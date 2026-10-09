# Research radar full-text automation

- Status: design and durable-retry amendment approved in conversation
- Date: 2026-10-09
- Goal: `research-fulltext-automation`

## Intent

Automate the existing weekly research radar so each new candidate that passes its current source and keyword filters is assessed using the full original source, with the full Exploring Next episode transcript required for every Exploring Next item. The user asked for continuous research and specifically for the original article to be read in full. The existing weekly LaunchAgent only performs a dry sweep and posts a status update; triage and digest emission are still manual.

Success means a scheduled run retrieves and processes every matching candidate (up to the existing 50-candidate run limit), including the complete article body and, for Exploring Next episodes, the complete episode script. A candidate is never triaged from only its title, feed description, abstract, or audio summary. A reviewable weekly digest and ledger change are proposed through a draft PR. A human still decides whether any finding changes musterd's research foundation or becomes an ADR.

## Chosen approach

Run a dedicated weekly GitHub Actions workflow, independent of the laptop LaunchAgent. Reuse the existing synchronous radar sweep, deduplication, two-tier triage, and digest conventions. Add full-text retrieval for the candidate URL through Exa's Contents API, and retrieve the full script for Exploring Next episodes through its existing read-only REST API. Use the existing Anthropic Messages integration for triage. Do not add a runtime package dependency. The endpoint, credential, pacing, and retention boundary follow [ADR 556](../../decisions/556-exploring-next-full-script-api.md).

Exa is preferred over a custom HTML/PDF extractor because radar candidates span article pages and research-paper pages; Exa returns extracted page text for known URLs and reports retrieval status. Direct fetching remains a possible fallback only if implementation proves the current Exa integration cannot read an in-scope source reliably; it must not silently produce a shorter or partial substitute.

The workflow uses `ANTHROPIC_API_KEY`, `EXA_API_KEY`, `EXPLORING_API_KEY`, and the repo's fine-grained `STEWARD_TOKEN` (or an equivalent app token with contents and pull-request write). It creates or updates a draft PR for the weekly digest and ledger. It never merges automatically. If required secrets are absent, the workflow reports the missing secret names in the Actions summary, makes no ledger change, and exits visibly as not configured.

## Pipeline

1. At the existing weekly cadence (Monday 08:00 UTC), run arXiv, HF Papers, and the read-only Exploring Next feed; keep the current date window, source filters, and cross-source deduplication. Process up to 50 fresh candidates and up to 50 oldest pending candidates per run; report either cap if it truncates the eligible set.
2. Preserve Exploring Next episode IDs and source URLs through cross-source deduplication. If an Exploring Next row is merged into a canonical arXiv/HF candidate, its episode reference must remain attached so the full script is still retrieved. For every candidate that survives those filters, retrieve the full original article body. For every attached Exploring Next episode, retrieve the full script with `GET https://ingest.sandrise.io/v1/episodes/{idOrNumber}/script` and bearer credential `EXPLORING_API_KEY`; pace requests at least 700 ms apart, honor `Retry-After` on 429, and retry boundedly. The API returns ordered speaker/text segments. Process each complete body in ordered chunks that fit the model context; collect chunk-level evidence and combine it before candidate-level ranking. Every chunk must be processed. No summarization, truncation, failed chunk, or missing full-text response may be treated as a complete read.
3. Run the existing tier-1 filter over the complete-read evidence for all candidates. Run tier-2 scoring on the existing shortlist (maximum 10), using the same complete-read evidence. Preserve the current verdicts, relevance dimensions, prompt versioning, and human graduation gate.
4. Emit the weekly digest with the existing verdict groups and scores, plus source links, an explicit full-text read status, prompt/model versions, and a count of candidates deferred because a complete read failed. Do not include article bodies, transcript bodies, or long verbatim passages in the digest.
5. Add a metadata-only `pending` array to `seen.json`, preserving its existing `arxiv`, `hf`, and `exn` arrays. It records each failed candidate's source ID, canonical ID, title, URL, published date, attached Exploring Next episode IDs, first/last attempt dates, and concise failure category; it never stores abstracts, article text, or transcript text. Each weekly run retries up to 50 oldest pending candidates regardless of the source's date window. Full-text retrieval and triage success moves the candidate IDs into the existing seen arrays and removes its pending row. Retrieval, model, or write failures keep or add the affected row. A partial run may emit successful candidates while listing failed candidate IDs and their source links in the Actions summary.
6. Write digest and ledger through a staged, atomic publication step so a failed write cannot leave only one of the pair updated. Open/update a weekly draft PR using the established PAT-authored PR pattern so required CI checks run. The PR remains human-reviewed and is never auto-merged.

## Data and privacy boundaries

- Full article and transcript text is ephemeral workflow input. Do not write it to the checkout, Actions artifacts, logs, PR descriptions, digest files, or `seen.json`.
- Exploring Next script text is processed under its API access and attribution terms; do not archive or redistribute full scripts. Digest entries link to the source episode. Any displayed or quoted Exploring Next material attributes and links to Exploring Next (ADR 556).
- Logs and workflow summaries contain candidate IDs, source URLs, stable failure categories/status codes, and counts; they do not contain article text, transcript text, API keys, or authorization headers.
- Treat retrieved page and transcript text as untrusted data, never as instructions. Keep it in clearly delimited content fields and prevent it from changing tools, prompts, URLs, or workflow actions.
- Only fetch the candidate's HTTPS source URL after parsing and validating it. Reject non-HTTPS URLs, credentials in URLs, loopback/private/link-local destinations, and redirects to those destinations. Bound redirects, response sizes, and request time; do not bypass paywalls or access controls.
- Send source URLs and extracted text to Exa and Anthropic respectively; this third-party processing is part of the workflow's configured data path.
- The radar stays a source, not a sink: it does not post candidates into Exploring Next, update research-foundation.md, or author/merge ADRs.

## Failure, retry, and idempotency

- Exa non-success status, missing/empty extracted text, missing ExN script, incomplete chunk processing, or a failed model call is a candidate failure. Record a concise failure category in the workflow summary; do not fall back to the feed's short description or audio summary as the article read.
- Retry transient retrieval failures with bounded backoff, reusing the radar's existing timeout/retry policy where it applies. Permanent/unavailable sources remain unseen for the next run.
- Serialize scheduled and manually dispatched runs. Use one weekly digest path and one weekly PR branch; a repeat run must not silently overwrite a digest that has already been reviewed. It may update the same open draft PR only while the PR has no review or approval and the weekly artifact remains unmerged. If it has been reviewed, report the retryable items and leave the reviewed artifact untouched for the next week.
- Enforce the 50-fresh-candidate cap, 50-pending-retry cap, and 10-item tier-2 cap. Report truncation explicitly. Process every selected candidate through complete retrieval before ranking.

## Interfaces and compatibility

- No `@musterd/protocol` schema or musterd server changes.
- Extend the existing `scripts/radar/` pipeline and add a separate workflow file. Keep the current hand-run dry sweep and local triage path usable; the new full-text path is the scheduled automated path.
- Keep the existing source candidate IDs, seen-ledger arrays, digest path, verdict ladder, and no-auto-merge rule; add only the metadata-only `pending` array to the seen ledger. Retain each successfully read Exploring Next episode ID in the existing `exn` ledger even when cross-source deduplication uses a paper ID as the canonical candidate. Add read-status metadata to the digest without storing source bodies.
- Update `scripts/radar/README.md` and `docs/design/research-radar-plan.md` to describe the new scheduled full-text path and the revised M5 scheduling status; those files currently say weekly triage/emit remain manual.
- Do not change the LaunchAgent's service identity or make it perform secret-bearing LLM work; it remains a local dry-sweep/status signal unless a later decision retires it.

## Security and operational limits

Article URLs are untrusted input, so retrieval must defend against SSRF, redirect tricks, oversized responses, and prompt injection. The GitHub workflow gets only the write permissions needed to update the digest PR. Secret values never enter logs. Exa's current listed Contents pricing is per page; actual model cost varies with full-text size and the number of candidates. The run must stop visibly at configured size/token limits rather than silently dropping article sections.

## Acceptance criteria

1. A scheduled run fetches the full article body for every new candidate in the capped weekly set and the complete script for each Exploring Next episode before triage.
2. Each candidate's read manifest accounts for every article and attached episode-script chunk; missing, partial, or failed source text cannot become a normal candidate verdict or a seen-ledger entry, and the metadata-only pending row survives beyond the 7-day source window.
3. The digest records links, read status, models/prompt version, and counts without containing source bodies; the Actions summary lists retryable failures without source text.
4. A failed publish cannot leave a digest and `seen.json` inconsistent; rerunning a partial week retries failed candidates without duplicating successfully reviewed items.
5. The weekly workflow is independently schedulable, serializes overlapping runs, opens or updates a draft PR, and never merges it.
6. No path updates thesis documents or publishes into Exploring Next.
7. URL validation, response bounds, redirect checks, and prompt-injection boundaries are covered at the retrieval seam.

## Open implementation detail

The exact bounded body/chunk/token limits are selected in the implementation plan and must be recorded in the workflow summary when a run reaches them. The Exploring Next endpoint and response shape were verified against its current API documentation; implementation details are in ADR 556.
