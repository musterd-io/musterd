# CLI latency — measurement log (lane 01M61VTB701HJHPQMFGKP0T5P4)

Probe: `scripts/bench-cli-start.ts` (`pnpm bench:cli-start [--runs N]`). Spawns the built CLI
(`packages/cli/dist/bin.js`) N times per probe (default 15) and reports median + p90 wall time.
Numbers are environment-dependent (machine load, daemon state); report them, never assert them
in CI. A machine at load average 44 measured `--version` at 1.4–2.4 s (2026-10-01).

## 2026-10-28 — cold-start + read/write paths on the live daemon (wallow, build e4054a2)

Machine: wallow's seat, daemon on localhost:4849 (schema 134), 15 runs per probe, NO_COLOR.

| probe | median | p90 | notes |
| --- | --- | --- | --- |
| node -e 0 (floor) | 24 ms | 26 ms | process spawn floor |
| musterd --version | 33 ms | 36 ms | no daemon contact |
| musterd help | 70 ms | 79 ms | local render only |
| musterd help <cmd> | 69 ms | 72 ms | local render only |
| musterd (first paint) | 40 ms | 44 ms | `MUSTERD_PAINT_PROBE=1` |
| musterd whoami | 229 ms | 263 ms | one daemon round-trip |
| musterd status | 209 ms | 221 ms | roster + health + sync + holds |
| musterd next | 300 ms | 315 ms | orientation brief (heaviest read) |
| musterd status (daemon down) | 150 ms | — | connection refused, exit 7 |

**Bottlenecks.** The local probes (help, --version, first paint) sit at 33–70 ms and are dominated
by Node startup (24 ms floor) plus module load — cheap. The daemon round-trips (whoami, status,
next) are 5–8× slower and scale with what the daemon reads: `next` is the slowest at 300 ms (it
assembles the orientation brief — carried work, shipped work, open lanes, inbox). `status` is 209 ms
(roster + health + sync + holds). An unreachable daemon fails fast (150 ms, exit 7).

**No invented targets.** These are baselines, not budgets. The lane asks for reproducible evidence;
`pnpm bench:cli-start` is the reproducible instrument. Tail latency on a loaded or slow daemon
(machine at load average 44) can be 10× these numbers, so a single run is not a verdict.

Falsify: re-run on a quiet machine and find `next` under 200 ms, or find `help` over 200 ms.
EOF
echo written