# 596 — Radar provider diagnostics

- Status: accepted (2026-10-14, gptbot; bounded diagnosis of the approved radar path)
- Date: 2026-10-14
- Lane: `01M4YDWAJVZR5ADW5FYJZVNS12`

## Context

[Run 38657232565](https://github.com/musterd-io/musterd/actions/runs/38657232565) used the landed [ADR 566](566-radar-fresh-paper-text.md) reader. CorpusMap extraction grew from 1,920 to 81,716 characters and was processed in two chunks, with its episode script processed separately. Tier-2 again reported only `provider_or_response_error`, leaving ten candidates pending.

## Problem

The generic failure cannot distinguish an HTTP rejection, a response cut off at its token budget, or invalid JSON. Extraction length alone also cannot establish that the sampled PDF's later sections were present. Repository secrets are available only to Actions in this session.

## Decision

Run one bounded, read-only diagnostic from a draft branch, through the existing manually dispatched radar workflow. The diagnostic reads the current unreviewed weekly retry ledger, processes at most ten pending candidates through the existing reader and triage functions, and separately probes the sampled original PDF. It uses the existing provider clients and emits only source character counts, known section-presence booleans, numeric HTTP failure status, requested/output token counts and JSON-validity booleans. Provider error bodies, text, prompts, evidence and secrets are never printed or saved.

The diagnostic job has read-only repository permissions, no publication step, and a fifteen-minute timeout. An explicit boolean input selects it while skipping the publication job; the scheduled path retains its existing behavior. Remove the temporary diagnostic implementation before merging this record. Any resulting production fix requires its own evidence-backed decision.

## Consequences

The probe pays for at most ten pending source reads and one sampled article retrieval. No source bodies become artifacts and no digest or ledger is modified. This record retains the question and observed result; diagnostic tooling is temporary.

Follows-up: `01M4YDWAJVZR5ADW5FYJZVNS12`

## Observability & Evaluation

**Traces.** Metadata-only JSON in the diagnostic run log, with candidate read manifests and bounded provider measurements.

**Eval.** Dataset: the ten pending candidates from the unreviewed W42 ledger and `2609.37226v1`. Baseline: run 38657232565 has no tier-2 results and a generic failure. A provider status separates HTTP rejection from a model response; output tokens and JSON validity distinguish truncation from a complete structured response. Sample section booleans compare extraction against the independently inspected 29-page original PDF. A logged source body, a publication step, or a modification to the ledger falsifies the read-only claim.

**Experiment.** n/a — a bounded failure reproduction, with no agent comparison or score change.
