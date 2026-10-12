import { describe, expect, it } from 'vitest';
import { renderPreview, renderSaved } from './render.js';
import type { ImportStage } from './stage.js';

/* eslint-disable no-control-regex -- stripping ANSI colour to read the words */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const lane = (n: number) => ({ ref: `lane@${String(n)}`, row: n, title: `New ${String(n)}`, depends_on: [], source_ref: `acme/app#${String(n)}` });
const stage = (extra: Partial<ImportStage> = {}): ImportStage => ({
  version: 1,
  id: 's1',
  team: 'dawn',
  project: 'app',
  created_at: 0,
  source: { path: 'github acme/app', sha256: 'ab', format: 'github' },
  goals: [],
  lanes: [lane(1), lane(2), lane(3), lane(4)],
  linked_goals: [],
  diagnostics: [],
  created: {},
  saved_at: null,
  ...extra,
});

describe('renderPreview — a tracker re-sync', () => {
  it('prints one count line, then renames and abandons', () => {
    const actions = [
      { kind: 'rename' as const, lane_id: 'R1', ref: 'acme/app#11', from: 'Old one', title: 'New one' },
      { kind: 'rename' as const, lane_id: 'R2', ref: 'acme/app#12', from: 'Old two', title: 'New two' },
      ...[21, 22, 23].map((n) => ({
        kind: 'abandon' as const,
        lane_id: `A${String(n)}`,
        ref: `acme/app#${String(n)}`,
        from: `Gone ${String(n)}`,
        reason: `closed in GitHub (acme/app#${String(n)})`,
      })),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ kind: 'adopt' as const, lane_id: `D${String(n)}`, ref: `acme/app#${String(30 + n)}` })),
    ];
    const out = plain(
      renderPreview(
        stage({
          sync: { actions, unchanged: 5 },
          diagnostics: [{ level: 'warning', row: null, code: 'not_found', message: 'acme/app#40 not found upstream' }],
        }),
      ),
    );
    expect(out).toContain('import s1 — from github acme/app');
    expect(out).toContain('new 4 · renamed 2 · closed upstream: abandon 3 · adopted 7 · 1 warning');
    expect(out).toContain('↻ renamed: "Old one" → "New one"');
    expect(out).toContain('✕ abandon: Gone 21 (acme/app#21)');
    expect(out).toContain('5 unchanged');
    expect(out).toContain('next: musterd import save s1');
  });

  it('prints tracker text with its control characters stripped', () => {
    const evil = 'Pwn\u001b]0;owned\u0007\u001b[2J me';
    const out = plain(
      renderPreview(
        stage({
          lanes: [{ ...lane(1), title: evil }],
          goals: [{ ref: 'goal:g', row: 1, id: 'g', title: evil, depends_on: [] }],
          sync: {
            actions: [
              { kind: 'rename', lane_id: 'R1', ref: 'acme/app#2', from: evil, title: evil },
              { kind: 'abandon', lane_id: 'A1', ref: 'acme/app#3', from: evil, reason: 'x' },
            ],
            unchanged: 0,
          },
          diagnostics: [{ level: 'warning', row: null, code: 'x', message: evil }],
        }),
      ),
    );
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('Pwn me');
  });

  it('leaves zero counts out, and says when there is nothing to do', () => {
    const out = plain(renderPreview(stage({ lanes: [], sync: { actions: [], unchanged: 9 } })));
    expect(out).not.toMatch(/new 0|renamed 0|abandon 0/);
    expect(out).toContain('nothing to change — the board matches github acme/app (9 unchanged)');
  });

  it('a file stage keeps its old header and no count line', () => {
    const out = plain(
      renderPreview(stage({ source: { path: '/tmp/x.csv', sha256: 'ab', format: 'csv' } })),
    );
    expect(out).toContain('import s1 — 0 goals, 4 lanes from x.csv');
    expect(out).not.toContain('closed upstream');
  });
});

describe('renderSaved — sync rows', () => {
  it('lists what each action did, and the skips with their note', () => {
    const out = plain(
      renderSaved(
        stage(),
        {
          goals: [],
          lanes: [],
          sync: [
            { kind: 'rename', lane_id: 'R1', ok: true },
            { kind: 'abandon', lane_id: 'A1', ok: false, note: 'claimed since the preview — left alone' },
          ],
        },
        'http://x/live',
      ),
    );
    expect(out).toContain('↻ R1 renamed');
    expect(out).toContain('⚠ A1 not abandoned: claimed since the preview — left alone');
  });
});
