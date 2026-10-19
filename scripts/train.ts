/*
 * The release train's tooling (ADR 669).
 *   pnpm train status [--version X.Y.Z]                — every surface, red/green (default: the CLI's version)
 *   pnpm train notes --version X.Y.Z [vPREV..HEAD]     — draft docs/releases/vX.Y.Z.md (default range: last tag..HEAD)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardGoalOf,
  commitsIn,
  groupByGoal,
  latestTag,
  parseSubject,
  renderNotes,
  userVisible,
} from './train/notes.ts';
import { realIo, renderStatus, trainStatus } from './train/status.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cliVersion(): string {
  return (
    JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const version = flag('--version') ?? cliVersion();
    const results = await trainStatus(version, realIo);
    process.stdout.write(`${renderStatus(version, results)}\n`);
    return results.some((r) => r.verdict === 'missing') ? 1 : 0;
  }
  if (cmd === 'notes') {
    const version = flag('--version');
    if (!version) {
      process.stderr.write(
        'train notes: --version X.Y.Z is required (the version these notes are for)\n',
      );
      return 2;
    }
    const range = process.argv.slice(3).find((a) => a.includes('..')) ?? `${latestTag()}..HEAD`;
    const commits = commitsIn(range);
    const visible = commits.filter(userVisible);
    const groups = groupByGoal(
      visible.map((c) => parseSubject(c.subject)),
      boardGoalOf,
    );
    const out = join(root, 'docs', 'releases', `v${version}.md`);
    if (existsSync(out) && !process.argv.includes('--force')) {
      process.stderr.write(
        `train notes: ${out} exists — it may already be edited; pass --force to overwrite\n`,
      );
      return 1;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderNotes(version, range, groups, commits.length - visible.length));
    process.stdout.write(
      `train notes: ${visible.length} of ${commits.length} commits in ${range} → docs/releases/v${version}.md (draft)\n`,
    );
    return 0;
  }
  process.stderr.write(
    'usage: pnpm train <status [--version X.Y.Z] | notes --version X.Y.Z [vPREV..HEAD] [--force]>\n',
  );
  return 2;
}

process.exit(await main());
