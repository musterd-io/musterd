import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import process from 'node:process';

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const dbArg = args.find((a) => a.startsWith('--db='));
const repoArg = args.find((a) => a.startsWith('--repo='));

const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : 150;
const DB_PATH = dbArg ? dbArg.slice('--db='.length) : `${homedir()}/.musterd/musterd.db`;
const REPO = repoArg ? repoArg.slice('--repo='.length) : process.cwd();

const EXCLUDED = new Set(['ROADMAP.md', 'pnpm-lock.yaml', 'docs/implementation-plan.md']);

function git(argsArr: string[]): string {
  return execFileSync('git', ['-C', REPO, ...argsArr], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

interface Lane {
  id: string;
  created: number;
  resolved: number;
  sha: string;
  files: Set<string>;
  ranges: Map<string, Array<[number, number]>>;
}

function parseHunks(diff: string): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      current = m ? m[1] : null;
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (line.startsWith('@@')) {
      if (!current) continue;
      for (const p of line.split(' ')) {
        if (!p.startsWith('+')) continue;
        const body = p.slice(1);
        let start = 0;
        let count = 1;
        if (body.includes(',')) {
          const [s, c] = body.split(',');
          if (!/^\d+$/.test(s)) continue;
          start = Number(s);
          count = /^\d+$/.test(c) ? Number(c) : 1;
        } else {
          if (!/^\d+$/.test(body)) continue;
          start = Number(body);
          count = 1;
        }
        if (count > 0) {
          const arr = out.get(current);
          if (arr) arr.push([start, start + count - 1]);
        }
      }
    }
  }
  return out;
}

const db = new DatabaseSync(DB_PATH);
const rows = db.prepare(
  `SELECT id, created_at, claimed_at, resolved_at, merged_json
   FROM lanes WHERE merged_json IS NOT NULL
   ORDER BY resolved_at DESC LIMIT ?`
).all(LIMIT) as Array<{
  id: string; created_at: number; claimed_at: number | null; resolved_at: number | null; merged_json: string;
}>;

const data: Lane[] = [];
const tStart = Date.now();
let nameOnlyMs = 0;
let hunkMs = 0;

for (const r of rows) {
  let sha = '';
  try { sha = (JSON.parse(r.merged_json) as { sha: string }).sha; } catch { continue; }
  if (!sha) continue;
  const created = r.created_at;
  const resolved = r.resolved_at ?? r.claimed_at ?? r.created_at;

  const t0 = Date.now();
  let files: string[] = [];
  try {
    files = git(['diff', '--name-only', `${sha}^`, sha])
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    try {
      files = git(['show', '--name-only', '--format=', sha])
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { files = []; }
  }
  files = files.filter((f) => !EXCLUDED.has(f));
  const t1 = Date.now();
  nameOnlyMs += t1 - t0;

  const t2 = Date.now();
  let ranges = new Map<string, Array<[number, number]>>();
  try {
    const diff = git(['diff', '--unified=0', `${sha}^`, sha]);
    ranges = parseHunks(diff);
  } catch { ranges = new Map(); }
  const t3 = Date.now();
  hunkMs += t3 - t2;

  data.push({ id: r.id, created, resolved, sha, files: new Set(files), ranges });
}

const totalMs = Date.now() - tStart;

let timeOverlapping = 0;
let sharedFilePairs = 0;
let sharedHunkPairs = 0;

for (let i = 0; i < data.length; i++) {
  for (let j = i + 1; j < data.length; j++) {
    const a = data[i]; const b = data[j];
    if (a.resolved < b.created || b.resolved < a.created) continue;
    timeOverlapping++;
    const common = [...a.files].filter((f) => b.files.has(f));
    if (common.length === 0) continue;
    sharedFilePairs++;
    let clash = false;
    for (const f of common) {
      const ra = a.ranges.get(f) ?? [];
      const rb = b.ranges.get(f) ?? [];
      for (const [s1, e1] of ra) {
        for (const [s2, e2] of rb) {
          if (!(e1 < s2 || e2 < s1)) { clash = true; break; }
        }
        if (clash) break;
      }
      if (clash) break;
    }
    if (clash) sharedHunkPairs++;
  }
}

console.log('branch-overlap measurement (ADR 575 section 3 follow-up)');
console.log('db:', DB_PATH);
console.log('repo:', REPO);
console.log('lanes measured:', data.length);
console.log('total wall time:', totalMs, 'ms');
console.log('  git diff --name-only:', nameOnlyMs, 'ms total,', (nameOnlyMs / data.length).toFixed(1), 'ms/commit');
console.log('  git diff --unified=0  (hunk parse):', hunkMs, 'ms total,', (hunkMs / data.length).toFixed(1), 'ms/commit');
console.log('concurrently-open lane pairs:', timeOverlapping);
console.log('pairs sharing >=1 changed file:', sharedFilePairs,
  `(${(100 * sharedFilePairs / timeOverlapping).toFixed(2)}%)`);
console.log('pairs sharing an overlapping hunk range:', sharedHunkPairs,
  `(${(100 * sharedHunkPairs / timeOverlapping).toFixed(2)}%)`);
if (sharedFilePairs > 0) {
  console.log('hunk tightening: ' + sharedHunkPairs + ' of ' + sharedFilePairs +
    ' file-sharing pairs also clash at hunk range (' +
    (100 * sharedHunkPairs / sharedFilePairs).toFixed(1) + '%); ' +
    (sharedFilePairs - sharedHunkPairs) + ' file-only pairs would be suppressed');
}
db.close();