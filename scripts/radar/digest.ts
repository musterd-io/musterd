/**
 * Radar M4 — the emit rail: weekly digest + seen-ledger append (research-radar-plan §4.5, §5).
 *
 * A digest is a TRIAGE artifact — emitting an untriaged sweep is refused, because a bare candidate
 * list has no verdicts for a human to act on. The seen ledger gains EVERY candidate that entered
 * triage, not only the surfaced ones the plan first sketched: marking only surfaced ids would
 * re-pay tier-1 for the same ignores every single week (the fetch window overlaps the cadence).
 * A same-week re-emit refuses rather than overwriting — the first digest is data.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadSeen } from './dedup.ts';
import { isoWeekString } from './fetch.ts';
import type {
  PendingCandidate,
  RadarCandidate,
  SeenLedger,
  SweepReport,
  Tier2Result,
  TriageVerdict,
} from './types.ts';

/** ISO-8601 week of an ISO date/timestamp string, e.g. 2026-W35. */
export function isoWeek(dateISO: string): string {
  return isoWeekString(new Date(`${dateISO.slice(0, 10)}T00:00:00Z`));
}

const VERDICT_ORDER: readonly TriageVerdict[] = ['consider-ADR', 'record-as-evidence'];

export function renderDigest(report: SweepReport): string {
  const t = report.triage;
  if (t === undefined) {
    throw new Error('cannot emit a digest without triage — run with --triage');
  }
  const week = isoWeek(report.generated);
  const lines: string[] = [
    '---',
    `week: ${week}`,
    `generated: ${report.generated.slice(0, 10)}`,
    `prompt_version: ${t.prompt_version}`,
    `tier1_model: ${t.tier1_model}`,
    `tier2_model: ${t.tier2_model}`,
    // What was judged, not what was fetched — the digest reports on the triaged set.
    `candidates_seen: ${report.printed}`,
    `shortlisted: ${t.shortlisted}`,
    '---',
    '',
    `# Research radar — ${week}`,
    '',
    `Swept the last ${report.since_days} days: ${report.candidates_fetched} fetched, ` +
      `${report.already_seen} already seen, ${report.new_count} new, ${report.printed} triaged.`,
    '',
  ];
  for (const verdict of VERDICT_ORDER) {
    const entries = t.surfaced.filter((r) => r.verdict === verdict);
    if (entries.length === 0) continue;
    lines.push(`## ${verdict}`, '');
    for (const r of entries) lines.push(...renderEntry(r));
  }
  if (t.surfaced.length === 0) {
    lines.push('_No papers surfaced this week — everything scored below the relevance floor._', '');
  }
  const dropped = t.tier1.filter((h) => !h.keep).length;
  const ignored = t.shortlisted - t.surfaced.length;
  lines.push(
    `— tier-1 dropped ${dropped}, tier-2 ignored ${ignored}, relevance floor ${t.relevance_floor}.`,
  );
  for (const w of [...report.warnings, ...t.warnings]) lines.push(`⚠ ${w}`);
  lines.push('');
  return lines.join('\n');
}

function renderEntry(r: Tier2Result): string[] {
  return [
    `- **[${r.title}](${r.url})** — score ${r.score.toFixed(2)}, confidence ${r.confidence.toFixed(2)} (\`${r.id}\`)`,
    `  - what: ${r.one_line}`,
    `  - why musterd: ${r.why_musterd}`,
    `  - gut: ${r.gut_check}`,
    '',
  ];
}

export interface EmitResult {
  digestPath: string;
  appended: { arxiv: number; hf: number; exn: number };
  pending: number;
}

export interface RadarReadFailure {
  candidateId: string;
  failure: string;
}

/** Stage and validate both artifacts, then replace them as one recoverable filesystem operation. */
export function commitRadarArtifacts(
  digestPath: string,
  seenPath: string,
  digest: string,
  ledger: SeenLedger,
  replace: typeof renameSync = renameSync,
): void {
  const suffix = `${process.pid}-${randomUUID()}`;
  const digestTemp = `${digestPath}.${suffix}.tmp`;
  const seenTemp = `${seenPath}.${suffix}.tmp`;
  const digestBackup = `${digestPath}.${suffix}.bak`;
  const seenBackup = `${seenPath}.${suffix}.bak`;
  const hadDigest = existsSync(digestPath);
  const hadSeen = existsSync(seenPath);
  let digestReplaced = false;
  let seenReplaced = false;

  mkdirSync(join(digestPath, '..'), { recursive: true });
  mkdirSync(join(seenPath, '..'), { recursive: true });
  try {
    writeFileSync(digestTemp, digest, { flag: 'wx' });
    const normalized: SeenLedger = {
      arxiv: [...ledger.arxiv],
      hf: [...ledger.hf],
      exn: [...ledger.exn],
      pending: [...(ledger.pending ?? [])],
    };
    writeFileSync(seenTemp, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
    if (readFileSync(digestTemp, 'utf8') !== digest)
      throw new Error('staged digest validation failed');
    const stagedLedger = JSON.parse(readFileSync(seenTemp, 'utf8')) as SeenLedger;
    if (
      !Array.isArray(stagedLedger.arxiv) ||
      !Array.isArray(stagedLedger.hf) ||
      !Array.isArray(stagedLedger.exn)
    ) {
      throw new Error('staged seen ledger validation failed');
    }
    if (hadDigest) copyFileSync(digestPath, digestBackup);
    if (hadSeen) copyFileSync(seenPath, seenBackup);

    replace(digestTemp, digestPath);
    digestReplaced = true;
    replace(seenTemp, seenPath);
    seenReplaced = true;
  } catch (error) {
    if (digestReplaced) {
      if (hadDigest) copyFileSync(digestBackup, digestPath);
      else if (existsSync(digestPath)) unlinkSync(digestPath);
    }
    if (seenReplaced) {
      if (hadSeen) copyFileSync(seenBackup, seenPath);
      else if (existsSync(seenPath)) unlinkSync(seenPath);
    }
    throw error;
  } finally {
    for (const path of [digestTemp, seenTemp, digestBackup, seenBackup]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

function sourceIds(candidate: RadarCandidate): PendingCandidate['sourceIds'] {
  const seen = new Set<string>();
  return [
    { source: candidate.source, id: candidate.id },
    ...candidate.relatedExn.map(({ episodeId }) => ({ source: 'exn' as const, id: episodeId })),
  ].filter(({ source, id }) => {
    const key = `${source}:${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Write a weekly digest and reconcile successful IDs and retryable full-text failures. */
export function emitDigest(
  report: SweepReport,
  radarDir: string,
  readFailures: RadarReadFailure[] = [],
): EmitResult {
  const md = renderDigest(report);
  mkdirSync(radarDir, { recursive: true });
  const digestPath = join(radarDir, `${isoWeek(report.generated)}.md`);
  if (existsSync(digestPath)) {
    throw new Error(`digest already exists for this week: ${digestPath} — not overwriting`);
  }
  const seenFile = join(radarDir, 'seen.json');
  const seen: SeenLedger = existsSync(seenFile)
    ? loadSeen(seenFile)
    : { arxiv: [], hf: [], exn: [], pending: [] };
  const pending = [...(seen.pending ?? [])];
  const byPendingId = new Map(pending.map((item) => [item.canonicalId, item]));
  const failureById = new Map(
    readFailures.map(({ candidateId, failure }) => [candidateId, failure]),
  );
  const successfulIds = new Set(report.triage?.tier1.map(({ id }) => id) ?? []);
  const triageFailed =
    report.triage?.warnings.some(
      (warning) => warning.startsWith('tier-1 failed') || warning.startsWith('tier-2 failed'),
    ) ?? false;
  const appended = { arxiv: 0, hf: 0, exn: 0 };
  const generatedDate = report.generated.slice(0, 10);

  for (const c of report.new) {
    const failure = failureById.get(c.id) ?? (triageFailed ? 'triage_failed' : undefined);
    if (failure || !successfulIds.has(c.id)) {
      const previous = byPendingId.get(c.id);
      const next: PendingCandidate = {
        sourceIds: sourceIds(c),
        canonicalId: c.id,
        title: c.title,
        url: c.url,
        published: c.published,
        episodeIds: c.relatedExn.map(({ episodeId }) => episodeId),
        firstAttempt: previous?.firstAttempt ?? generatedDate,
        lastAttempt: generatedDate,
        failure: failure ?? 'triage_incomplete',
      };
      const index = pending.findIndex((item) => item.canonicalId === c.id);
      if (index >= 0) pending[index] = next;
      else pending.push(next);
      byPendingId.set(c.id, next);
      continue;
    }

    for (const sourceId of sourceIds(c)) {
      const ids = seen[sourceId.source];
      if (ids.includes(sourceId.id)) continue;
      ids.push(sourceId.id);
      appended[sourceId.source]++;
    }
    const index = pending.findIndex((item) => item.canonicalId === c.id);
    if (index >= 0) pending.splice(index, 1);
  }
  seen.pending = pending;
  commitRadarArtifacts(digestPath, seenFile, md, seen);
  return { digestPath, appended, pending: pending.length };
}
