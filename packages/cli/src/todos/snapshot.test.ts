import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, Lane, UpdateLane } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../client.js';
import { readDelta, snapshotTodos, targetLane } from './snapshot.js';

function lane(id: string, state: Lane['state'], updated_at: number, owner = 'dolly'): Lane {
  return {
    id,
    team: 'revive',
    project: 'p',
    title: id,
    detail: null,
    owner_seat: owner,
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal',
    stakes_provenance: 'declared',
    merged: null,
    state,
    created_by: owner,
    created_at: 0,
    claimed_at: null,
    resolved_at: null,
    updated_at,
  };
}

const todoWrite = (todos: { content: string; status: string }[]) =>
  JSON.stringify({
    message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos } }] },
  }) + '\n';

function fakeHttp(lanes: Lane[]) {
  const patches: { id: string; patch: UpdateLane }[] = [];
  const http = {
    laneBoard: async () => ({ lanes, warnings: [] }),
    updateLane: async (_team: string, id: string, patch: UpdateLane) => {
      patches.push({ id, patch });
      return { lane: lanes[0]!, warnings: [] };
    },
  } as unknown as HttpClient;
  return { http, patches };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'todos-'));
  mkdirSync(join(dir, '.musterd'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, '');
  return { dir, transcript };
}

const binding = { team: 'revive', claim: { mode: 'seat', name: 'dolly' } } as unknown as Binding;

describe('targetLane — the seat’s most recently updated live lane', () => {
  it('skips terminal, parked and other seats’ lanes', () => {
    const lanes = [
      lane('old', 'active', 1),
      lane('new', 'claimed', 5),
      lane('done', 'done', 9),
      lane('parked', 'parked', 9),
      lane('theirs', 'active', 9, 'fifty'),
    ];
    expect(targetLane(lanes, 'dolly')?.id).toBe('new');
    expect(targetLane([lane('done', 'done', 9)], 'dolly')).toBeNull();
  });
});

describe('readDelta', () => {
  it('returns only complete lines and the offset past them', () => {
    const { transcript } = workspace();
    writeFileSync(transcript, 'a\nb\npartial');
    expect(readDelta(transcript, 0)).toEqual({ text: 'a\nb\n', end: 4 });
    expect(readDelta(transcript, 4)).toEqual({ text: '', end: 4 });
  });
});

describe('snapshotTodos (ADR 487 §5.2)', () => {
  it('writes the unfinished list once, then only when it changes', async () => {
    const { dir, transcript } = workspace();
    const { http, patches } = fakeHttp([lane('L1', 'active', 1)]);
    const run = () =>
      snapshotTodos({ binding, dir, harness: 'claude-code', transcriptPath: transcript, http });

    appendFileSync(transcript, todoWrite([{ content: 'wire the hook', status: 'pending' }]));
    await run();
    await run();
    appendFileSync(transcript, todoWrite([{ content: 'wire the hook', status: 'completed' }]));
    await run();
    expect(patches).toEqual([
      { id: 'L1', patch: { unfinished_todos: ['wire the hook'] } },
      { id: 'L1', patch: { unfinished_todos: [] } },
    ]);
  });

  it('never calls the daemon when no to-do tool was used', async () => {
    const { dir, transcript } = workspace();
    const { http, patches } = fakeHttp([lane('L1', 'active', 1)]);
    appendFileSync(transcript, JSON.stringify({ message: { content: [] } }) + '\n');
    await snapshotTodos({ binding, dir, harness: 'claude-code', transcriptPath: transcript, http });
    expect(patches).toEqual([]);
  });

  it('writes nothing for a seat with no live lane — no seat-memory fallback', async () => {
    const { dir, transcript } = workspace();
    const { http, patches } = fakeHttp([lane('L1', 'done', 1)]);
    appendFileSync(transcript, todoWrite([{ content: 'x', status: 'pending' }]));
    await snapshotTodos({ binding, dir, harness: 'claude-code', transcriptPath: transcript, http });
    expect(patches).toEqual([]);
  });

  it('ignores harnesses it cannot read', async () => {
    const { dir, transcript } = workspace();
    const { http, patches } = fakeHttp([lane('L1', 'active', 1)]);
    appendFileSync(transcript, todoWrite([{ content: 'x', status: 'pending' }]));
    await snapshotTodos({ binding, dir, harness: 'cursor', transcriptPath: transcript, http });
    expect(patches).toEqual([]);
  });
});
