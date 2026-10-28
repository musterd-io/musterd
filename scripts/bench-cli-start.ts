/*
 * Cold-start bench for the CLI front door (ADR 491) and the read/write paths
 * (lane 01M61VTB701HJHPQMFGKP0T5P4). Spawns the built CLI N times per probe
 * and prints the median and p90 wall time. Report the numbers; never assert them
 * in CI — on 2026-10-01 a machine at load average 44 measured `--version` at
 * 1.4–2.4 s.
 *
 *   pnpm bench:cli-start             # 15 runs per probe
 *   pnpm bench:cli-start --runs 30
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'packages', 'cli', 'dist', 'bin.js');
const at = process.argv.indexOf('--runs');
const RUNS = at > 0 ? Number(process.argv[at + 1]) : 15;

interface Probe {
  name: string;
  argv: string[];
  env?: Record<string, string>;
}

export const PROBES: Probe[] = [
  { name: 'node -e 0 (floor)', argv: ['-e', '0'] },
  { name: 'musterd --version', argv: [BIN, '--version'] },
  { name: 'musterd help', argv: [BIN, 'help'] },
  { name: 'musterd help <cmd>', argv: [BIN, 'help', 'lane'] },
  { name: 'musterd whoami', argv: [BIN, 'whoami'] },
  { name: 'musterd status', argv: [BIN, 'status'] },
  { name: 'musterd next', argv: [BIN, 'next'] },
  { name: 'musterd (first paint)', argv: [BIN], env: { MUSTERD_PAINT_PROBE: '1' } },
];

function once(p: Probe): number {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, p.argv, {
    stdio: 'ignore',
    env: { ...process.env, NO_COLOR: '1', ...p.env },
  });
  if (r.status !== 0) throw new Error(`${p.name}: exit ${r.status}`);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

for (const p of PROBES) {
  const xs = Array.from({ length: RUNS }, () => once(p));
  console.log(
    `${p.name.padEnd(28)} median ${quantile(xs, 0.5).toFixed(0).padStart(5)} ms · p90 ${quantile(xs, 0.9).toFixed(0).padStart(5)} ms`,
  );
}
