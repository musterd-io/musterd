import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, toHex } from './sha256';

describe('sha256', () => {
  it('matches Node createHash, including the empty digest', () => {
    const samples = [
      new Uint8Array(),
      Uint8Array.from([0]),
      new Uint8Array(32),
      Uint8Array.from(Buffer.from('musterd-app/v1 pair', 'utf8')),
      Uint8Array.from(Buffer.from('a pairing code ∥ keys', 'utf8')),
      Uint8Array.from({ length: 200 }, (_, i) => i & 0xff),
    ];
    for (const sample of samples) {
      const ours = Buffer.from(sha256(sample));
      const node = createHash('sha256').update(sample).digest();
      expect(ours.equals(node)).toBe(true);
      expect(toHex(sha256(sample))).toBe(node.toString('hex'));
    }
  });

  it('is the published empty-string digest', () => {
    expect(toHex(sha256(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
