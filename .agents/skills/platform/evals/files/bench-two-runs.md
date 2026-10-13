<!-- Eval input. These two rows are real (docs/perf/daemon-load-baseline.md, cloud runs 32 and 37, 2026-10-13). -->

| run | build | p50 | p95 | p99 | requests (req/s) | /health p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 32 | dc09c35 | 355 ms | 791 ms | 1 203 ms | 66 306 (51.0) | 231 ms |
| 37 | 6fd7aca | 493 ms | 1 226 ms | 1 685 ms | 66 203 (50.9) | 477 ms |

Between dc09c35 and 6fd7aca there are 10 server/protocol commits. Run 37 also changed the bench:
its viewers now reconnect after a closed socket, so they hold the full roster load all run.
