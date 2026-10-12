# 566 — Radar fresh paper text

- Status: accepted (2026-10-12, gptbot; correction to the approved full-text requirement)
- Date: 2026-10-12
- Lane: `01M4RP5KW89M2EH7S7F7KB1PR6`

## Context

[ADR 564](564-radar-original-paper-targets.md) directs paper links to original PDFs and requires sampled comparison of extraction completeness. Live run [38298439943](https://github.com/musterd-io/musterd/actions/runs/38298439943) published draft #2377 after the repository token was repaired. Twenty-one PDF extracts contain 30,439–194,158 characters; `2609.37226v1` still contains only 1,920 characters. The original [CorpusMap PDF](https://arxiv.org/pdf/2609.37226v1) has 29 pages, independently inspected on 2026-10-12.

## Problem

Exa Contents defaults to cached extraction, so directing a request to the original PDF does not force the provider to fetch that document anew. The repeated short extraction cannot support the approved full-paper read claim. A length threshold would arbitrarily reject legitimate short papers.

## Decision

Request `maxAgeHours: 0` for article extraction. Exa documents this as fetching fresh content; do not use deprecated `livecrawl`, whose freshness is not guaranteed. Preserve existing target validation, size bounds, chunk processing, provider status checks and metadata-only failure handling.

Correct the unreviewed draft by removing the sampled paper's successful source/episode IDs from its ledger, retaining its metadata as an `article_retrieval` retry, and qualifying its old manifest as incomplete. Reprocess that candidate with fresh extraction before accepting its complete-read claim.

## Consequences

Each attempted article requires a fresh provider fetch, increasing retrieval latency relative to cache hits. A provider fetch failure remains pending. Freshness alone is not proof of complete extraction: compare the sampled paper again before accepting the live outcome. No new dependency or protocol change.

Follows-up: `01M4RP5KW89M2EH7S7F7KB1PR6`

## Observability & Evaluation

**Traces.** Draft manifests record extracted URLs, character counts and processed chunks; the sampled incomplete extraction is recorded before retry.

**Eval.** Dataset: `2609.37226v1` and existing article extraction fixtures. Baseline: its live extract is 1,920 characters for 29 pages, and the fresh-request regression fails with `maxAgeHours` undefined. The regression requires zero cache age; existing retrieval/security tests must pass. Compare the live retry's extraction with the original PDF, and keep it pending if still incomplete.

**Experiment.** n/a — implementing the approved full-original-text requirement, with no score or verdict change.
