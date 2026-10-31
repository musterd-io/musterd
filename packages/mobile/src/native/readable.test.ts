import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocks, plain, summary } from './readable';

/** Shared with `logic-check.swift`: the extension's `Readable` must give the same lines. */
const FIXTURES: { input: string; plain: string; summary: string }[] = [
  {
    input:
      '[lane] acceptance requested for `01M653W2N4GNXM0STPSZYH2NEE`: **merge it?**\n\n- tests pass\n- docs updated',
    plain: 'acceptance requested for 01M653W2N4: merge it? • tests pass • docs updated',
    summary: 'acceptance requested for 01M653W2N4: merge it? • tests pass • docs updated',
  },
  {
    input:
      'Can I run the hub migration on the shared daemon now? It restarts it for about 30 seconds, and every live session reconnects on its own afterwards without anyone doing anything.',
    plain:
      'Can I run the hub migration on the shared daemon now? It restarts it for about 30 seconds, and every live session reconnects on its own afterwards without anyone doing anything.',
    summary: 'Can I run the hub migration on the shared daemon now?',
  },
  {
    input:
      '## Deploy\nShip build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the glass pass',
    plain:
      'Deploy Ship build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the glass pass',
    summary:
      'Deploy Ship build 34 to TestFlight with the notification fix and the readable asks change and the pairing copy and the…',
  },
];

describe('plain and summary', () => {
  for (const f of FIXTURES) {
    it(`reads ${JSON.stringify(f.input.slice(0, 30))}…`, () => {
      expect(plain(f.input)).toBe(f.plain);
      expect(summary(f.input, 120)).toBe(f.summary);
    });
  }

  it('runs the same fixtures as the extension’s logic-check.swift', () => {
    const swift = readFileSync(
      new URL('../../modules/musterd-keys/logic-check.swift', import.meta.url),
      'utf8',
    );
    for (const f of FIXTURES)
      for (const line of [f.input, f.plain, f.summary])
        expect(swift).toContain(JSON.stringify(line));
  });

  it('keeps the words on a code fence line: only the marks go', () => {
    expect(plain('```bash rm -rf build\n```')).toBe('bash rm -rf build');
  });

  it('leaves short text alone', () => {
    expect(summary('Ship it?')).toBe('Ship it?');
  });
});

describe('blocks', () => {
  it('keeps paragraphs and bullets and turns marks into styles', () => {
    expect(
      blocks(
        '[lane] Merge **#3632** now?\nIt clears `seen` asks.\n\n- tests pass\n2. docs updated',
      ),
    ).toEqual([
      {
        kind: 'para',
        spans: [
          { text: 'Merge ' },
          { text: '#3632', style: 'bold' },
          { text: ' now? It clears ' },
          { text: 'seen', style: 'code' },
          { text: ' asks.' },
        ],
      },
      { kind: 'bullet', spans: [{ text: 'tests pass' }] },
      { kind: 'bullet', spans: [{ text: 'docs updated' }] },
    ]);
  });

  it('shortens a full id inside code too', () => {
    expect(blocks('see `01M653W2N4GNXM0STPSZYH2NEE`')[0]!.spans[1]).toEqual({
      text: '01M653W2N4',
      style: 'code',
    });
  });
});
