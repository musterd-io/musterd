# 564 — Radar original paper targets

- Status: accepted (2026-10-12, gptbot; correction to the approved full-text requirement)
- Date: 2026-10-12
- Lane: `01M4RP5KW89M2EH7S7F7KB1PR6`

## Context

The [approved radar design](../superpowers/specs/2026-10-09-research-radar-fulltext-design.md)
requires the original article in full before triage. Configured workflow run
[38290925924](https://github.com/SandRiseStudio/musterd/actions/runs/38290925924) created draft
#2377 with 22 reported complete reads. Five Hugging Face URLs produced only 2046–2952 characters;
an arXiv abstract URL produced 2171. Those targets identify papers but expose landing-page text.
Exa retrieval success confirms the requested page was extracted; it does not establish that the
page was the original paper.

## Problem

Passing a paper index URL to Contents can rank an abstract and then mark its candidate seen.
The green run and complete manifest therefore overstate the approved original-source read.

## Decision

1. Resolve recognized Hugging Face paper URLs and arXiv abstract, HTML, and PDF URLs to the
   original `https://arxiv.org/pdf/<id>` before requesting Exa Contents. Preserve a supplied
   version and support the existing legacy arXiv identifier form. Publisher article URLs stay
   direct. Validate the submitted URL before resolving it; match exact known hosts.
2. Match Exa results and statuses against the requested PDF. A result pointing back to an
   index/abstract page fails retrieval and remains pending. Record the extracted PDF URL in the
   source manifest; keep candidate URLs and canonical IDs unchanged.
3. Correct the unreviewed, unmerged draft #2377 by restoring its digest/ledger artifacts to the
   pre-run state and reprocessing with this reader. Retain the failed run as evidence. This
   correction does not change the rule that reviewed or merged weekly artifacts are immutable.

## Consequences

No new dependency, protocol change, or credential is needed. Existing source-size limits,
chunk processing, and metadata-only failures remain in force. Unavailable original PDFs stay
pending. Using the original PDF avoids an arbitrary minimum text length that could reject a
legitimate short paper. PDF extraction still depends on Exa; source identity and provider success
are observable, while completeness of the provider's extraction needs sampled comparison.

Follows-up: `01M4RP5KW89M2EH7S7F7KB1PR6`

## Observability & Evaluation

**Traces.** The digest records original PDF URLs and their character/chunk counts.

**Eval.** Dataset: the HF/arXiv URLs from run 38290925924 plus versioned and legacy IDs.
Baseline: six regression cases fail on the reader used by that run. Regression cases assert
HF, arXiv abstract/HTML, versioned and legacy IDs request the PDF, and a redirect back to a landing
page cannot be accepted. Re-dispatch the same week's unreviewed draft and compare its manifests
and retry ledger with run 38290925924.

**Experiment.** n/a — this corrects source identity required by the approved full-text spec.

A known paper URL producing a landing-page manifest or a
landing-page result becoming seen falsifies the correction.
