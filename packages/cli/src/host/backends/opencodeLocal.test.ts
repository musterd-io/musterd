import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, readLocalServing, type LocalServingIo } from './opencodeLocal.js';

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
