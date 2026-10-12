# Research radar scripts

Hand-runnable sweep + full-text LLM triage + weekly digest proposal for ADR 056 ingest. Design:
[`docs/design/research-radar-plan.md`](../../docs/design/research-radar-plan.md).

```bash
pnpm radar:sweep                              # print-only dry-sweep
pnpm radar:sweep --json --since 14 --limit 20
pnpm radar:sweep --triage --limit 15          # needs ANTHROPIC_API_KEY
pnpm radar:sweep --full-text --triage --emit --limit 50 --retry-limit 50
```

Sources: arXiv, HF Papers, and the Exploring Next public feed (`exn`, read-only GET — its
hand-curated items feed the radar, never the reverse). The scheduled full-text path retrieves the
complete article through Exa and every attached Exploring Next episode script before triage.
Known Hugging Face paper and arXiv abstract/HTML links resolve to the original arXiv PDF
([ADR 564](../../docs/decisions/564-radar-original-paper-targets.md)); a redirect back to a
landing page is a failed read. The read manifest records the PDF URL, while candidate links keep
their existing identities. It
requires `ANTHROPIC_API_KEY`, `EXA_API_KEY`, and `EXPLORING_API_KEY`. Without `--emit` nothing is
written; with it, successfully triaged canonical and episode IDs enter `seen.json`, while failed
reads remain in its metadata-only pending queue. Full source bodies are not saved. A same-week
digest on `main` is immutable.

GitHub Actions runs this full-text path every Monday at 08:00 UTC and supports manual dispatch. It
checks for `ANTHROPIC_API_KEY`, `EXA_API_KEY`, `EXPLORING_API_KEY`, and `STEWARD_TOKEN` before
processing. The workflow opens or updates one unreviewed weekly **draft PR** containing the digest
and ledger; it never merges. Review the source links and triage before merging.

A repeat run loads the existing unreviewed draft's ledger before reading sources and appends its
retry findings with `--resume-draft`, preserving prior findings and successful IDs. The workflow
checks review state again before publishing. Local emission refuses an existing same-week digest
unless that draft-resume flag is explicitly supplied. Missing model results remain pending;
successful tier-1 drops are retained even when shortlisted triage fails. Digests record source
read manifests; Actions summaries name deferred IDs, links, failure categories and the cap reached.
Recoverable feed or model failures still propose the emitted retry ledger; a failed artifact write
stops publication.

The local LaunchAgent remains a no-key dry-sweep and team summary. Local summary-only triage remains
available with `--triage` when full-text keys are not configured.

Models: tier-1 `claude-haiku-4-5`, tier-2 `claude-sonnet-5` (config constants).
Tests: `pnpm exec vitest run scripts/radar/`.
