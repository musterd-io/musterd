import { plainTerminalText as safe } from '../render/plainText.js';
import { theme } from '../render/theme.js';
import type { PlannedLane } from './check.js';
import type { Diagnostic } from './rows.js';
import type { SaveResult } from './save.js';
import { isTrackerStage, rerunCommand, STAGE_TTL_MS, type ImportStage } from './stage.js';
import type { SyncAction } from './trackers/sync.js';

const n = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function renderPreview(stage: ImportStage): string {
  const out: string[] = [];
  const where = theme.meta(`(team ${stage.team}, project ${stage.project})`);
  if (isTrackerStage(stage)) {
    out.push(`${theme.accent(`import ${stage.id}`)} — from ${stage.source.path} ${where}`);
    const sync = stage.sync ?? { actions: [], unchanged: 0 };
    const count = (k: SyncAction['kind']) => sync.actions.filter((a) => a.kind === k).length;
    const warnings = stage.diagnostics.filter((d) => d.level === 'warning').length;
    const parts = [
      stage.lanes.length ? `new ${String(stage.lanes.length)}` : null,
      count('rename') ? `renamed ${String(count('rename'))}` : null,
      count('abandon') ? `closed upstream: abandon ${String(count('abandon'))}` : null,
      count('adopt') ? `adopted ${String(count('adopt'))}` : null,
      warnings ? n(warnings, 'warning') : null,
    ].filter(Boolean);
    const errors = stage.diagnostics.some((d) => d.level === 'error');
    if (parts.length === 0 && !errors) {
      out.push(
        '',
        `nothing to change — the board matches ${stage.source.path} (${String(sync.unchanged)} unchanged)`,
      );
      return out.join('\n');
    }
    out.push(
      '',
      parts.join(' · ') +
        (sync.unchanged ? theme.meta(` · ${String(sync.unchanged)} unchanged`) : ''),
      '',
    );
  } else {
    out.push(
      `${theme.accent(`import ${stage.id}`)} — ${n(stage.goals.length, 'goal')}, ${n(stage.lanes.length, 'lane')} ` +
        `from ${base(stage.source.path)} ${where}`,
      '',
    );
  }
  const titleOf = new Map(stage.lanes.map((l) => [l.ref, l.title]));
  const laneLine = (l: PlannedLane) => {
    const bits = [
      l.stakes ? l.stakes : null,
      l.depends_on.length
        ? `after: ${l.depends_on.map((d) => (d.kind === 'staged' ? safe(titleOf.get(d.ref) ?? d.ref) : d.id)).join(', ')}`
        : null,
    ].filter(Boolean);
    return `    ○ ${safe(l.title)}${bits.length ? theme.meta(`  · ${bits.join(' · ')}`) : ''}`;
  };
  for (const g of stage.goals) {
    out.push(`◆ ${g.id}  ${safe(g.title)} ${theme.meta('(new)')}`);
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
  const actions = stage.sync?.actions ?? [];
  const renames = actions.filter((a) => a.kind === 'rename');
  const abandons = actions.filter((a) => a.kind === 'abandon');
  if ((renames.length || abandons.length) && out.at(-1) !== '') out.push('');
  for (const a of renames)
    out.push(`↻ renamed: "${safe(a.from ?? a.lane_id)}" → "${safe(a.title ?? '')}"`);
  for (const a of abandons)
    out.push(`✕ abandon: ${safe(a.from ?? a.lane_id)} ${theme.meta(`(${safe(a.ref)})`)}`);
  if (stage.diagnostics.length) out.push('', ...stage.diagnostics.map(renderDiagnostic));
  // A tracker stage ends its sections with a blank line of its own; never print two in a row.
  for (let i = out.length - 1; i > 0; i -= 1)
    if (out[i] === '' && out[i - 1] === '') out.splice(i, 1);
  const errors = stage.diagnostics.filter((d) => d.level === 'error').length;
  out.push(
    '',
    errors > 0
      ? `${theme.err('✗')} ${n(errors, 'error')} — fix ${isTrackerStage(stage) ? 'the issues' : 'the file'} and re-run \`${rerunCommand(stage)}\``
      : `next: musterd import save ${stage.id}`,
  );
  return out.join('\n');
}

function renderDiagnostic(d: Diagnostic): string {
  const mark = d.level === 'error' ? theme.err('✗') : theme.warn('⚠');
  // A row-less diagnostic is about the source as a whole: no `file:` label (a tracker has none).
  return `${mark} ${d.row === null ? '' : `line ${String(d.row)}: `}${safe(d.message)}`;
}

export function renderSaved(stage: ImportStage, r: SaveResult, liveUrl: string): string {
  const resumed = [...r.goals, ...r.lanes].filter((x) => x.resumed).length;
  const lines = [
    `${theme.ok('✓')} ${n(r.goals.length, 'goal')}, ${n(r.lanes.length, 'lane')} saved from import ${stage.id}` +
      (resumed ? theme.meta(` (${String(resumed)} already created by an earlier run)`) : ''),
    ...r.goals.map((g) => `  ◆ ${g.id}`),
    ...r.lanes.map((l) =>
      l.adopted
        ? `  ↺ ${l.id}  ${safe(l.title)} ${theme.meta('(already on the board)')}`
        : `  ○ ${l.id}  ${safe(l.title)}`,
    ),
    ...r.sync.map(renderSyncResult),
    '',
    `see them: ${liveUrl}  ·  musterd next`,
  ];
  if (stage.linked_goals.length)
    lines.splice(1, 0, theme.meta(`  linked to existing: ${stage.linked_goals.join(', ')}`));
  return lines.join('\n');
}

const SYNC_DONE: Record<SyncAction['kind'], [string, string]> = {
  rename: ['↻', 'renamed'],
  abandon: ['✕', 'abandoned'],
  adopt: ['↺', 'adopted (source_ref recorded)'],
};

function renderSyncResult(s: SaveResult['sync'][number]): string {
  const [mark, verb] = SYNC_DONE[s.kind];
  if (!s.ok) return `  ${theme.warn('⚠')} ${s.lane_id} not ${verb.split(' ')[0]!}: ${s.note ?? ''}`;
  return `  ${mark} ${s.lane_id} ${verb}${s.note ? theme.meta(` (${s.note})`) : ''}`;
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
