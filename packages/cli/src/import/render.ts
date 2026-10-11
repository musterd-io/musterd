import { theme } from '../render/theme.js';
import type { PlannedLane } from './check.js';
import type { Diagnostic } from './rows.js';
import type { SaveResult } from './save.js';
import { STAGE_TTL_MS, type ImportStage } from './stage.js';

const n = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function renderPreview(stage: ImportStage): string {
  const out: string[] = [];
  out.push(
    `${theme.accent(`import ${stage.id}`)} — ${n(stage.goals.length, 'goal')}, ${n(stage.lanes.length, 'lane')} ` +
      `from ${base(stage.source.path)} ${theme.meta(`(team ${stage.team}, project ${stage.project})`)}`,
    '',
  );
  const titleOf = new Map(stage.lanes.map((l) => [l.ref, l.title]));
  const laneLine = (l: PlannedLane) => {
    const bits = [
      l.stakes ? l.stakes : null,
      l.depends_on.length
        ? `after: ${l.depends_on.map((d) => (d.kind === 'staged' ? (titleOf.get(d.ref) ?? d.ref) : d.id)).join(', ')}`
        : null,
    ].filter(Boolean);
    return `    ○ ${l.title}${bits.length ? theme.meta(`  · ${bits.join(' · ')}`) : ''}`;
  };
  for (const g of stage.goals) {
    out.push(`◆ ${g.id}  ${g.title} ${theme.meta('(new)')}`);
    for (const l of stage.lanes.filter((x) => x.goal_id === g.id)) out.push(laneLine(l));
  }
  const planned = new Set(stage.goals.map((g) => g.id));
  const others = [
    ...new Set(
      stage.lanes.map((l) => l.goal_id).filter((id): id is string => !!id && !planned.has(id)),
    ),
  ];
  for (const id of others) {
    const linked = stage.linked_goals.includes(id);
    out.push(
      `◆ ${id} ${theme.meta(linked ? '(on the board — linked, not re-declared)' : '(on the board)')}`,
    );
    for (const l of stage.lanes.filter((x) => x.goal_id === id)) out.push(laneLine(l));
  }
  const loose = stage.lanes.filter((l) => !l.goal_id);
  if (loose.length) {
    out.push(theme.meta('no goal'));
    for (const l of loose) out.push(laneLine(l));
  }
  if (stage.diagnostics.length) out.push('', ...stage.diagnostics.map(renderDiagnostic));
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  out.push(
    '',
    errors > 0
      ? `${theme.err('✗')} ${n(errors, 'error')} — fix the file and re-run \`musterd import ${base(stage.source.path)}\``
      : `next: musterd import save ${stage.id}`,
  );
  return out.join('\n');
}

function renderDiagnostic(d: Diagnostic): string {
  const mark = d.level === 'error' ? theme.err('✗') : theme.warn('⚠');
  return `${mark} ${d.row === null ? 'file' : `line ${String(d.row)}`}: ${d.message}`;
}

export function renderSaved(stage: ImportStage, r: SaveResult, liveUrl: string): string {
  const resumed = [...r.goals, ...r.lanes].filter((x) => x.resumed).length;
  const lines = [
    `${theme.ok('✓')} ${n(r.goals.length, 'goal')}, ${n(r.lanes.length, 'lane')} saved from import ${stage.id}` +
      (resumed ? theme.meta(` (${String(resumed)} already created by an earlier run)`) : ''),
    ...r.goals.map((g) => `  ◆ ${g.id}`),
    ...r.lanes.map((l) => `  ○ ${l.id}  ${l.title}`),
    '',
    `see them: ${liveUrl}  ·  musterd next`,
  ];
  if (stage.linked_goals.length)
    lines.splice(1, 0, theme.meta(`  linked to existing: ${stage.linked_goals.join(', ')}`));
  return lines.join('\n');
}

export function renderList(stages: ImportStage[], now: number): string {
  if (stages.length === 0)
    return theme.meta('no staged imports in this workspace — `musterd import <file>` stages one');
  return stages
    .map((s) => {
      const errors = s.diagnostics.filter((d) => d.level === 'error').length;
      const state =
        s.saved_at !== null
          ? 'saved'
          : errors > 0
            ? `${n(errors, 'error')}`
            : now - s.created_at > STAGE_TTL_MS
              ? 'expired — re-run'
              : 'ready to save';
      return `${s.id}  ${base(s.source.path)} · ${n(s.goals.length, 'goal')}, ${n(s.lanes.length, 'lane')} · ${state}`;
    })
    .join('\n');
}
