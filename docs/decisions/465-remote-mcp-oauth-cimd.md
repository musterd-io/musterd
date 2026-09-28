# 465 — Remote MCP OAuth with generic CIMD and retained DCR

## Observability & Evaluation

- **Traces:** No new trace events. Resolver failures map to generic OAuth errors; raw client URLs, fetched documents, and exception text are not retained.
- **Eval:** Dataset: OAuth HTTP cases for retained DCR and the Claude and ChatGPT CIMD document shapes, including redirect, mismatch, cache, and code/refresh cases. Baseline: current DCR-only authorization coverage. Success: both CIMD clients resolve on authorization while DCR behavior remains and code/refresh exchange performs no metadata fetch.
- **Experiment:** Exercise the published Claude identity and ChatGPT Developer Mode on an eligible account; no production A/B treatment.
