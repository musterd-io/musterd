import type { ExecFileException } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexQueue, codexQueueResult, type CodexSessionView } from './codexQueue.js';
import { injectAdapterFor } from './inject.js';

const THREAD = '11111111-2222-4333-8444-555555555555';

function session(over: Partial<CodexSessionView> = {}): CodexSessionView {
  const row: CodexSessionView = { harness: over.harness ?? 'codex', id: over.id ?? THREAD };
  if (over.ended_at !== undefined) row.ended_at = over.ended_at;
  return row;
}

describe('codex queue inject (ADR 558 §6)', () => {
  it('an empty directory is no-thread and does not ask for a version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-q-'));
    let versions = 0;
    const adapter = codexQueue(dir, {
      versionText: () => {
        versions += 1;
        return 'codex-cli 0.162.1';
      },
      queue: () => Promise.reject(new Error('queued')),
    });
    expect(adapter.probe()).toEqual({ ready: false, reason: 'no-thread' });
    expect(await adapter.inject('x')).toEqual({ ok: false, reason: 'no-thread' });
    expect(versions).toBe(0);
  });

  it('injectAdapterFor on an empty directory is no-thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-deaf-'));
    expect(injectAdapterFor('codex', {}, dir).probe()).toEqual({
      ready: false,
      reason: 'no-thread',
    });
    expect(await injectAdapterFor('codex', {}, dir).inject('x')).toEqual({
      ok: false,
      reason: 'no-thread',
    });
  });

  it('a dead, foreign, or unsafe id is no-thread', async () => {
    const cases: Array<CodexSessionView | undefined> = [
      undefined,
      session({ ended_at: 1 }),
      session({ harness: 'claude-code' }),
      session({ id: 'not a thread' }),
      session({ id: '-rf' }),
      session({ id: 'abc/def' }),
      session({ id: '' }),
    ];
    for (const row of cases) {
      let queued = false;
      const adapter = codexQueue('unused', {
        readSession: () => row,
        versionText: () => 'codex-cli 0.162.1',
        queue: () => {
          queued = true;
          return Promise.resolve({ ok: true });
        },
      });
      expect(adapter.probe()).toEqual({ ready: false, reason: 'no-thread' });
      expect(await adapter.inject('x')).toEqual({ ok: false, reason: 'no-thread' });
      expect(queued).toBe(false);
    }
  });

  it('gates on the version and caches it', () => {
    let reads = 0;
    const adapter = codexQueue('unused', {
      readSession: () => session(),
      versionText: () => {
        reads += 1;
        return 'codex-cli 0.162.1';
      },
    });
    expect(adapter.probe()).toEqual({ ready: true });
    expect(adapter.probe()).toEqual({ ready: true });
    expect(reads).toBe(1);

    expect(
      codexQueue('unused', {
        readSession: () => session(),
        versionText: () => 'codex-cli 0.149.0',
      }).probe(),
    ).toEqual({ ready: true });
    expect(
      codexQueue('unused', {
        readSession: () => session(),
        versionText: () => 'codex-cli 0.148.9',
      }).probe(),
    ).toEqual({ ready: false, reason: 'below-0.149' });
    expect(
      codexQueue('unused', {
        readSession: () => session(),
        versionText: () => undefined,
      }).probe(),
    ).toEqual({ ready: false, reason: 'no-codex' });
    expect(
      codexQueue('unused', {
        readSession: () => session(),
        versionText: () => 'codex-cli 0.162',
      }).probe(),
    ).toEqual({ ready: false, reason: 'no-codex' });
  });

  it('queues only after the probe is ready, and the reason omits the line', async () => {
    const calls: string[][] = [];
    const ready = codexQueue('unused', {
      readSession: () => session(),
      versionText: () => 'codex-cli 0.162.1',
      queue: (args) => {
        calls.push([...args]);
        return Promise.resolve({ ok: true });
      },
    });
    expect(await ready.inject('line-one')).toEqual({ ok: true });
    expect(calls).toEqual([['queue', '--thread', THREAD, '--message', 'line-one']]);

    let queued = false;
    const old = codexQueue('unused', {
      readSession: () => session(),
      versionText: () => 'codex-cli 0.100.0',
      queue: () => {
        queued = true;
        return Promise.resolve({ ok: true });
      },
    });
    const refused = await old.inject('SECRET-LINE');
    expect(refused).toEqual({ ok: false, reason: 'below-0.149' });
    expect(JSON.stringify(refused)).not.toContain('SECRET-LINE');
    expect(queued).toBe(false);
  });

  it('maps queue failures to stable reasons', () => {
    const asErr = (value: Partial<ExecFileException>): ExecFileException =>
      value as ExecFileException;
    expect(codexQueueResult(null)).toEqual({ ok: true });
    expect(codexQueueResult(asErr({ code: 1 }))).toEqual({ ok: false, reason: 'queue-rejected' });
    expect(codexQueueResult(asErr({ code: 'ETIMEDOUT', killed: true }))).toEqual({
      ok: false,
      reason: 'timeout',
    });
    expect(codexQueueResult(asErr({ code: 'ENOENT' }))).toEqual({
      ok: false,
      reason: 'spawn-failed',
    });
    const noisy = asErr({
      code: 'ENOENT',
      message: 'spawn codex ENOENT SECRET-LINE /tmp/secret',
    });
    expect(JSON.stringify(codexQueueResult(noisy))).not.toContain('SECRET-LINE');
    expect(JSON.stringify(codexQueueResult(noisy))).not.toContain('/tmp/secret');
  });
});
