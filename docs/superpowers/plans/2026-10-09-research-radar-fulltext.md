# Full-Text Research Radar Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The workspace contract prohibits subagents from writing, claiming, building, or committing. The implementation must stay in the owning seat.

**Goal:** Every week, read complete original articles and Exploring Next episode scripts for matching research candidates, triage them, and publish a reviewable digest proposal.

**Architecture:** Extend the existing `scripts/radar/` pipeline with public-URL article retrieval through Exa, episode-script retrieval through Exploring Next, and chunk-complete evidence before the existing two-tier triage. Persist retry metadata beside the existing seen arrays. A separate GitHub Actions workflow emits the digest and ledger in a draft PR; it never merges.

**Tech Stack:** TypeScript, Node 22 `fetch`, Exa Contents API, Exploring Next public API, Anthropic Messages API, GitHub Actions, `gh` CLI, JSON and Markdown in git. No runtime package dependency.

**Spec:** [`docs/superpowers/specs/2026-10-09-research-radar-fulltext-design.md`](../specs/2026-10-09-research-radar-fulltext-design.md)

## Global Constraints

- The weekly run processes up to 50 fresh and 50 oldest pending candidates; tier-2 remains capped at 10.
- Each source body is limited to 250,000 Unicode characters; each canonical candidate is limited to 500,000 combined characters; a body at or over the source limit is incomplete and remains pending.
- Model input is split into ordered 50,000-character chunks; every chunk must succeed before candidate ranking.
- Run no more than three source/evidence calls concurrently.
- The existing dry-sweep and local summary-only triage remain usable; the scheduled path explicitly opts into full-text reads.
- Full article and transcript bodies are ephemeral. Persist metadata, model evidence, and read manifests only.
- Retrieved text is untrusted input, never instructions. Do not bypass access controls.
- No protocol schemas, server behavior, research-foundation content, or Exploring Next content are changed.
- Preserve `seen.json`'s `arxiv`, `hf`, and `exn` arrays; add a metadata-only `pending` array and read old ledgers without it.
- Schedule Monday 08:00 UTC in a dedicated GitHub Actions workflow. Require `ANTHROPIC_API_KEY`, `EXA_API_KEY`, and `STEWARD_TOKEN`; never print their values.
- Open or update an unreviewed weekly draft PR only. Never auto-merge.

## Review Focus

1. An Exploring Next row normalized to an arXiv candidate still retains its episode ID, so deduplication cannot skip the transcript. Pin in Task 1's feed-normalization test.
2. Unsupported/private URLs, redirects, provider errors, and empty article/script bodies fail closed and remain retryable. Pin URL and response cases in Task 1.
3. Unicode and oversized text do not split code points or masquerade as a complete read. Pin order, reconstruction, and source-limit behavior in Task 2.
4. Source text that contains instructions cannot alter the workflow, and raw text never appears in manifests, logs, or digest output. Pin the prompt boundary and output fields in Task 2 and Task 3.
5. A legacy ledger, a model failure, and a partial artifact write preserve successful IDs and retry failed candidates beyond seven days. Pin migration, failure, and publish behavior in Task 3.

---

## File Map

- `scripts/radar/types.ts` — canonical candidate, attached Exploring Next references, retry records, and read-manifest types.
- `scripts/radar/config.ts` — full-text retrieval and chunk limits alongside the existing timeout and candidate limits.
- `scripts/radar/fetch.ts` — feed parsing that retains source references through cross-source deduplication.
- `scripts/radar/content.ts` — HTTPS source URL checks and Exa full-text retrieval.
- `scripts/radar/exn.ts` — documented Exploring Next full-script retrieval and response parsing.
- `scripts/radar/fullText.ts` — source-size checks, Unicode-safe chunking, bounded concurrency, chunk evidence, and metadata-only manifests.
- `scripts/radar/triage.ts` and `docs/research/radar/prompts/radar-v1.md` — accept complete-read evidence while preserving verdicts and prompt versioning.
- `scripts/radar/dedup.ts` — load legacy ledgers, partition fresh and pending candidates, and update per-source seen IDs.
- `scripts/radar/digest.ts` — digest read-status metadata and coordinated artifact publication.
- `scripts/radar/sweep.ts` — explicit full-text mode and the fresh/pending caps.
- `scripts/radar/content.test.ts`, `scripts/radar/exn.test.ts`, `scripts/radar/fullText.test.ts`, `scripts/radar/dedup.test.ts`, `scripts/radar/digest.test.ts`, `scripts/radar/sweep.test.ts` — focused unit and integration coverage for the new behavior.
- `.github/workflows/research-radar.yml` — weekly/manual job, secret checks, serialized execution, and draft-PR publication.
- `scripts/radar/README.md` and `docs/design/research-radar-plan.md` — current commands and M5 schedule status.

## Task Lanes

- Task 1 — Radar full-text source adapters: `01M4GR43WPNN578A5XQCCR021F` (`feat/radar-fulltext-sources`)
- Task 2 — Radar chunked full-text triage: `01M4GR44D36ZX453K8V99TKA86` (`feat/radar-fulltext-triage`)
- Task 3 — Radar pending ledger and digest: `01M4GR49Q9S5GFJG9Q6ARGKM8H` (`feat/radar-pending-retries`)
- Task 4 — Schedule automated research radar: `01M4GR4A7NNXFC3FY6ZN8YY52W` (`feat/radar-weekly-automation`)

Each lane depends on the approved design-and-plan lane `01M4GQJSP8AQND8S8N6A82H0T8`; Tasks 2–4 also depend on the preceding implementation lane(s) listed in the lane board.

### Task 1: Full-Text Source Adapters

**Preflight:** Verify the current Exploring Next OpenAPI/MCP surface for `get_episode_script` and capture its actual request and response shape. If there is no public read-only endpoint, stop before implementation and return the missing capability as a blocking design gap; do not guess an endpoint or scrape the site.

**Files:**
- Modify: `scripts/radar/types.ts`
- Modify: `scripts/radar/fetch.ts`
- Create: `scripts/radar/content.ts`
- Create: `scripts/radar/exn.ts`
- Create: `scripts/radar/content.test.ts`
- Modify: `scripts/radar/exn.test.ts`

**Interfaces:**
- `RadarCandidate` adds `relatedExn: Array<{ episodeId: string }>`; ordinary candidates use an empty array.
- `fetchArticleText(url: string, apiKey: string, fetchFn?: FetchFn): Promise<{ url: string; text: string }>` calls Exa in full-text mode and accepts only a successful, non-empty text result for the requested URL.
- `fetchEpisodeScript(episodeId: string, fetchFn?: FetchFn): Promise<{ url: string; text: string }>` calls the public endpoint documented by the current Exploring Next OpenAPI/MCP surface. First verify that surface and pin its real request/response shape in the fixture; if no public read path exists, stop the task and report the gap instead of scraping a guessed route.
- `isPublicHttpsUrl(value: string): boolean` rejects non-HTTPS URLs, embedded credentials, localhost and private/link-local IP literals. Validate returned/final URLs as well as submitted URLs.

- [ ] **Step 1: Add feed and provider boundary tests** for an ExN row whose article URL normalizes to an existing arXiv ID, preserving its episode ID on the canonical candidate; full-text success, non-success status, empty response, URL rejection, and a documented episode-script payload.
- [ ] **Step 2: Run the focused tests and confirm they fail** with the missing source-reference and retrieval behavior.

Run: `pnpm exec vitest run scripts/radar/content.test.ts scripts/radar/exn.test.ts`

Expected: the new contract assertions fail before implementation.

- [ ] **Step 3: Implement source reference retention and the two retrieval adapters** using injected `FetchFn`, bounded request time, and bounded response size. Do not log response bodies or credentials.
- [ ] **Step 4: Run the focused tests and confirm they pass.**

Run: `pnpm exec vitest run scripts/radar/content.test.ts scripts/radar/exn.test.ts`

Expected: all source normalization, URL, and provider response cases pass.

- [ ] **Step 5: Commit Task 1** with the seat trailer.

### Task 2: Complete-Read Chunking and Triage

**Files:**
- Create: `scripts/radar/fullText.ts`
- Modify: `scripts/radar/triage.ts`
- Modify: `docs/research/radar/prompts/radar-v1.md`
- Create: `scripts/radar/fullText.test.ts`
- Create: `scripts/radar/triage.test.ts`
- Modify: `scripts/radar/config.ts`

**Interfaces:**
- `FullTextManifest` contains only `{ source, url, characters, chunks, complete }` records.
- `CandidateReadResult` is a discriminated union: success carries `{ candidateId, evidence, manifest }`; failure carries `{ candidateId, failure, manifest }`. Neither variant carries raw article or transcript text.
- `readCandidateFullText(candidate: RadarCandidate, options: { exaApiKey: string; fetchFn?: FetchFn; completeFn?: CompleteFn }): Promise<CandidateReadResult>` fetches the article and each attached episode script, rejects any source over 250,000 Unicode characters or candidate total over 500,000, then processes ordered 50,000-character chunks. No result is complete unless every required source and chunk succeeds. Put the limits in `config.ts` so the workflow and local invocation use the same values.
- `runTriage` accepts one `CandidateReadResult` per candidate. Only successful reads enter tier-1; tier-2 retains the current maximum of 10.

- [ ] **Step 1: Add tests** for Unicode-safe ordered chunk reconstruction, exact source and candidate size limits, ExN transcript inclusion, failure on one missing chunk, and the no-raw-text manifest.
- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run: `pnpm exec vitest run scripts/radar/fullText.test.ts scripts/radar/triage.test.ts`

Expected: missing chunking and read-manifest behavior fail.

- [ ] **Step 3: Implement the complete-read orchestrator and adapt triage** to pass each ordered chunk as untrusted, delimited source content to the existing Anthropic client. Collect concise evidence per chunk, then combine it before ranking. Never substitute the abstract/audio summary for a failed source read.
- [ ] **Step 4: Run the focused tests and confirm they pass.**

Run: `pnpm exec vitest run scripts/radar/fullText.test.ts scripts/radar/triage.test.ts`

Expected: every source chunk contributes to evidence and all incomplete-read cases remain failures.

- [ ] **Step 5: Commit Task 2** with the seat trailer.

### Task 3: Durable Retry Ledger and Digest Publication

**Files:**
- Modify: `scripts/radar/dedup.ts`
- Modify: `scripts/radar/digest.ts`
- Modify: `scripts/radar/sweep.ts`
- Modify: `scripts/radar/types.ts`
- Create: `scripts/radar/dedup.test.ts`
- Modify: `scripts/radar/digest.test.ts`
- Create: `scripts/radar/sweep.test.ts`

**Interfaces:**
- `SeenLedger` remains `{ arxiv: string[]; hf: string[]; exn: string[]; pending?: PendingCandidate[] }`; absent `pending` means an empty array.
- `PendingCandidate` stores only source IDs, canonical ID, title, source URL, published date, attached episode IDs, first/last attempt dates, and a stable failure category.
- `partitionRadarCandidates(fresh: RadarCandidate[], seen: SeenLedger, retryLimit: number): { ready: RadarCandidate[]; deferred: PendingCandidate[]; truncated: boolean }` selects up to 50 oldest pending rows plus up to 50 fresh candidates, independent of the seven-day feed window.
- `commitRadarArtifacts(digestPath: string, seenPath: string, digest: string, ledger: SeenLedger): void` writes and validates both temporary files before replacement. Preserve the prior pair and roll back if either replacement fails; the workflow then commits both in one Git commit.

- [ ] **Step 1: Add tests** for old ledgers without `pending`, retry outside the date window, oldest-first pending selection, the 50 + 50 caps, preserving pending after failure, moving all canonical and ExN IDs to seen after success, digest privacy, and rollback when either artifact replacement fails.
- [ ] **Step 2: Run the focused tests and confirm they fail.**

Run: `pnpm exec vitest run scripts/radar/dedup.test.ts scripts/radar/digest.test.ts scripts/radar/sweep.test.ts`

Expected: legacy compatibility remains, while pending and atomic publication assertions fail.

- [ ] **Step 3: Implement pending reconciliation and publication.** Keep successful candidates in the existing source arrays, remove their pending rows, and retain/update failed rows. Validate both staged outputs before replacing either published file, then roll back to the prior pair if a replacement fails. Keep same-week reviewed artifacts immutable; only update the same unreviewed draft PR.
- [ ] **Step 4: Run the focused tests and confirm they pass.**

Run: `pnpm exec vitest run scripts/radar/dedup.test.ts scripts/radar/digest.test.ts scripts/radar/sweep.test.ts`

Expected: failure and rerun cases preserve the exact candidate and ledger state described above.

- [ ] **Step 5: Commit Task 3** with the seat trailer.

### Task 4: Weekly GitHub Actions Automation

**Files:**
- Create: `.github/workflows/research-radar.yml`
- Modify: `scripts/radar/README.md`
- Modify: `docs/design/research-radar-plan.md`

**Interfaces:**
- Workflow schedule: Monday `08:00 UTC`; also support `workflow_dispatch`.
- Use `concurrency.group: research-radar` with cancellation disabled.
- Run: `pnpm radar:sweep --full-text --triage --emit --limit 50 --retry-limit 50`.
- Before processing, report which of `ANTHROPIC_API_KEY`, `EXA_API_KEY`, and `STEWARD_TOKEN` are missing; do not print values or write files when any are absent.
- Use least-privilege `contents: write` and `pull-requests: write`, checkout with `STEWARD_TOKEN`, and create/update an unreviewed weekly draft PR. Do not enable auto-merge.
- Workflow timeout: 120 minutes; workflow summary reports candidate counts, source-read failures, truncation, and draft PR link without article or transcript text.

- [ ] **Step 1: Add the workflow and documentation changes.** Keep the LaunchAgent's no-key dry-sweep behavior and document that GitHub Actions owns weekly full-text triage and digest proposals.
- [ ] **Step 2: Validate the workflow structure and local command contract.**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

Expected: static gates pass; Actions YAML has the schedule, dispatch, serialization, least-privilege write scope, secret check, and draft-PR-only behavior listed above.

- [ ] **Step 3: Run a manual workflow dispatch after the required repository secrets are configured.** Confirm one draft PR contains the digest and ledger together, CI triggers, and no auto-merge is armed. If secrets are absent, confirm the summary names missing keys and no files are written.
- [ ] **Step 4: Commit Task 4** with the seat trailer.

## Final Verification

- [ ] Run `pnpm exec vitest run scripts/radar/` and confirm all existing and new radar tests pass.
- [ ] Run `pnpm typecheck && pnpm lint && pnpm format:check` before pushing each implementation lane.
- [ ] Let the required GitHub `gates` check run on every draft PR; do not merge any lane with a red gate.
- [ ] Inspect the generated digest and PR diff to confirm no article or transcript bodies, secrets, or long verbatim passages are present.
- [ ] After the full automation lane lands, submit each lane for outcome acceptance and follow the response for close-out.
