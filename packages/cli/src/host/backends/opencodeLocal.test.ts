import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLoopbackUrl,
  localServingNotes,
  readLocalServing,
  type LocalServingIo,
} from './opencodeLocal.js';

const WS = '/ws';
const DOT = join(WS, '.opencode', 'opencode.json');
const ROOT = join(WS, 'opencode.json');

function io(files: Record<string, unknown>): LocalServingIo {
  return {
    exists: (p) => p in files,
    read: (p) => {
      const v = files[p];
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  };
}

const ollama = (baseURL = 'http://127.0.0.1:11434/v1', model = 'ollama/qwen3:4b') => ({
  model,
  provider: { ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL } } },
  mcp: { musterd: { type: 'local', command: ['musterd', 'mcp'] } },
});

describe('readLocalServing (ADR 663): three signals, all at spawn', () => {
  it('all three agree: the snapshot names provider, bare model and base URL', () => {
    expect(readLocalServing(WS, { local: true }, io({ [DOT]: ollama() }))).toEqual({
      provider: 'ollama',
      model: 'qwen3:4b',
      base_url: 'http://127.0.0.1:11434/v1',
    });
  });

  it('llama.cpp’s llama-server counts as local-serving', () => {
    const cfg = {
      model: 'llama.cpp/dory-4b',
      provider: { 'llama.cpp': { options: { baseURL: 'http://localhost:8080/v1' } } },
    };
    expect(readLocalServing(WS, { local: true }, io({ [ROOT]: cfg }))?.provider).toBe('llama.cpp');
  });

  it('the binding without the provider: not local', () => {
    const cfg = {
      model: 'anthropic/claude-opus-5-5',
      provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:9999' } } },
    };
    expect(readLocalServing(WS, { local: true }, io({ [DOT]: cfg }))).toBeNull();
  });

  it('the provider without loopback: not local', () => {
    expect(
      readLocalServing(WS, { local: true }, io({ [DOT]: ollama('http://gpu-box.lan:11434/v1') })),
    ).toBeNull();
  });

  it('loopback without the binding: not local', () => {
    expect(readLocalServing(WS, {}, io({ [DOT]: ollama() }))).toBeNull();
    expect(readLocalServing(WS, null, io({ [DOT]: ollama() }))).toBeNull();
  });

  it('two workspace files that disagree on the model or the base URL: not local', () => {
    expect(
      readLocalServing(
        WS,
        { local: true },
        io({ [DOT]: ollama(), [ROOT]: ollama(undefined, 'ollama/gemma3:4b') }),
      ),
    ).toBeNull();
    expect(
      readLocalServing(
        WS,
        { local: true },
        io({ [DOT]: ollama(), [ROOT]: ollama('http://127.0.0.1:11435/v1') }),
      ),
    ).toBeNull();
  });

  it('a jsonc beside either file, or an unparseable file: not local', () => {
    expect(
      readLocalServing(WS, { local: true }, io({ [DOT]: ollama(), [`${ROOT}c`]: '{}' })),
    ).toBeNull();
    expect(readLocalServing(WS, { local: true }, io({ [DOT]: '{ not json' }))).toBeNull();
  });

  it('no pinned model, or a model with no provider prefix: not local', () => {
    const { model: _m, ...unpinned } = ollama();
    expect(readLocalServing(WS, { local: true }, io({ [DOT]: unpinned }))).toBeNull();
    expect(
      readLocalServing(WS, { local: true }, io({ [DOT]: ollama(undefined, 'qwen3:4b') })),
    ).toBeNull();
  });
});

describe('localServingNotes: a local-declared seat whose wakes will not read local', () => {
  // OpenCode 2.1's replacement for `provider`; where its base URL goes is undocumented (2026-10-26).
  const newShape = {
    model: 'ollama/qwen3.5:4b',
    providers: { ollama: { settings: { baseURL: 'http://127.0.0.1:11434/v1' } } },
  };

  it('silent when the seat is not declared local, or when the read answers local', () => {
    expect(localServingNotes(WS, {}, io({ [DOT]: newShape }))).toEqual([]);
    expect(localServingNotes(WS, null, io({}))).toEqual([]);
    expect(localServingNotes(WS, { local: true }, io({ [DOT]: ollama() }))).toEqual([]);
    // Both keys, and the `provider` block alone carries the loopback URL: the read answers local.
    expect(
      localServingNotes(
        WS,
        { local: true },
        io({ [DOT]: { ...newShape, provider: ollama().provider } }),
      ),
    ).toEqual([]);
  });

  it('names the `providers` shape when that is the only provider block', () => {
    const notes = localServingNotes(WS, { local: true }, io({ [ROOT]: newShape }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('`providers`');
    expect(notes[0]).toContain('harness_price_unverified');
  });

  it('any other miss gets the general reason, never the `providers` one', () => {
    for (const files of [
      {},
      { [DOT]: ollama('http://gpu-box.lan:11434/v1') },
      { [DOT]: { ...newShape, provider: ollama('http://gpu-box.lan:11434/v1').provider } },
      { [DOT]: '{ not json' },
    ]) {
      const notes = localServingNotes(WS, { local: true }, io(files));
      expect(notes).toHaveLength(1);
      expect(notes[0]).not.toContain('`providers`');
      expect(notes[0]).toContain('loopback');
    }
  });
});

describe('the snapshot never carries a credential (hard rule 5)', () => {
  it('drops userinfo, query and fragment from the base URL', () => {
    const snap = readLocalServing(
      WS,
      { local: true },
      io({ [DOT]: ollama('http://user:sk-secret@127.0.0.1:11434/v1?key=sk-secret#frag') }),
    );
    expect(snap?.base_url).toBe('http://127.0.0.1:11434/v1');
    expect(JSON.stringify(snap)).not.toContain('sk-secret');
  });
});

describe('isLoopbackUrl', () => {
  it('accepts loopback hosts over http(s) only', () => {
    for (const u of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:8080',
      'http://[::1]:11434',
      'https://127.4.5.6/v1',
    ])
      expect(isLoopbackUrl(u), u).toBe(true);
    for (const u of [
      'http://192.168.1.10:11434',
      'http://localhost.evil.com',
      'http://127.0.0.1.nip.io',
      'file:///tmp/x',
      'not a url',
    ])
      expect(isLoopbackUrl(u), u).toBe(false);
  });
});
