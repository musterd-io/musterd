# Family-correlation tooling

The scripts behind [the family-correlation manifest](../../../docs/research/family-correlation-manifest.md)
(lane `01M60BGSV7`, goal `family-correlation`). The manifest is the authority: the prompt,
sampling, hit rules, keep rule and verdict rules are pinned there, and these scripts implement
them. Change the manifest first.

| Step | Script | Where | Model calls |
| --- | --- | --- | --- |
| 1. Seed candidate mutants | `items.py seed` | anywhere, on a CooperBench `63b9d44` clone | none |
| 2. Keep or drop each mutant | `keep.py` | `musterd-cooperbench` (needs docker and the task images) | none |
| 3. Draw pilot and main items | `items.py draw` | anywhere | none |
| 4. Review | `review.py --stage pilot`, then `--stage main` | anywhere, with `OPENROUTER_API_KEY` | yes |
| 5. Score, gate, compute `D` | `analyze.py --stage pilot`, then `--stage main` | anywhere | none |

`patchlib.py` parses and numbers diffs; `mutate.py` holds the four operators. `models.json`
lists the six reviewers (two per family) by OpenRouter id. Tests: `python3
tests/test_family_correlation.py` (or pytest).

The run directory (`--out`/`--run`) holds `candidates/`, `candidates.jsonl`, `kept.jsonl`,
`items.jsonl` and `reviews.jsonl`. It is copied into `docs/research/family-correlation/` with the
finding.
