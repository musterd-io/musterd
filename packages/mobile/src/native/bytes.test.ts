import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, utf8Decode, utf8Encode } from './bytes';

/**
 * Parity against Node's Buffer: the daemon produces every one of these bytes with
 * `Buffer.toString('base64url')` / `Buffer.from(s, 'utf8')`, so the app's own codecs must
 * agree with it exactly or a body sealed one way refuses to open the other. Buffer is this
 * test's oracle — the phone runtime has neither Buffer nor TextEncoder.
 */

describe('utf8Encode', () => {
  it.each([
    ['ascii', 'musterd/v1 signed'],
    ['empty', ''],
    ['two-byte', 'café — naïve'],
    ['three-byte', '日本語 テスト 🚀'],
    ['astral pair', '👩‍💻 𝔘𝔫𝔦𝔠𝔬𝔡𝔢'],
    ['mix', 'lane 01M done ✓ — 「受け取り」 ①②③'],
  ])('%s matches Buffer.from(s, "utf8")', (_name, text) => {
    expect(Array.from(utf8Encode(text))).toEqual(Array.from(Buffer.from(text, 'utf8')));
  });

  it('encodes a lone surrogate as U+FFFD, like TextEncoder', () => {
    const loneHigh = 'before\uD800after';
    const loneLow = 'before\uDC00after';
    expect(Array.from(utf8Encode(loneHigh))).toEqual(Array.from(Buffer.from(loneHigh, 'utf8')));
    expect(Array.from(utf8Encode(loneLow))).toEqual(Array.from(Buffer.from(loneLow, 'utf8')));
    // A high surrogate at end-of-string is lone too, never half of a pair.
    expect(Array.from(utf8Encode('tail\uD800'))).toEqual(
      Array.from(Buffer.from('tail\uFFFD', 'utf8')),
    );
  });

  it('round-trips through utf8Decode', () => {
    for (const text of ['plain', 'naïve 日本', '🚀👩‍💻', '', 'a\u{10FFFF}z']) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
  });
});

describe('utf8Decode', () => {
  it('matches Buffer.toString("utf8") on valid bytes', () => {
    const bytes = Array.from(Buffer.from('héllo — 🌍 over every length', 'utf8'));
    for (let cut = 0; cut <= bytes.length; cut++) {
      const slice = bytes.slice(0, cut);
      expect(utf8Decode(Uint8Array.from(slice))).toBe(Buffer.from(slice).toString('utf8'));
    }
  });

  it('replaces invalid bytes instead of throwing', () => {
    // A bare continuation byte, an overlong 2-byte form, a truncated 3-byte sequence, and a
    // 5-byte (never valid) lead — all must come back as replacement text, not an exception.
    for (const raw of [
      [0x80],
      [0xc0, 0xaf],
      [0xe3, 0x81],
      [0xf8, 0x88, 0x80, 0x80, 0x80],
      [0xed, 0xa0, 0x80], // UTF-16 surrogate half, illegal in UTF-8
    ]) {
      expect(() => utf8Decode(Uint8Array.from(raw))).not.toThrow();
      expect(utf8Decode(Uint8Array.from(raw))).toContain('\uFFFD');
    }
  });
});

describe('b64urlEncode', () => {
  it('matches Buffer.toString("base64url") at every length around a quantum boundary', () => {
    for (let len = 0; len <= 17; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      expect(b64urlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('sweeps every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(b64urlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('uses the url-safe alphabet with no padding', () => {
    expect(b64urlEncode(Uint8Array.from([251, 255, 190]))).toBe('-_--');
    expect(b64urlEncode(new Uint8Array(0))).toBe('');
    expect(b64urlEncode(Uint8Array.from([0]))).toBe('AA'); // no '=' padding
  });
});

describe('b64urlDecode', () => {
  it('is the exact inverse of Buffer for canonical input', () => {
    for (let len = 0; len <= 17; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 91 + 3) & 0xff);
      const encoded = Buffer.from(bytes).toString('base64url');
      const decoded = b64urlDecode(encoded);
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded!)).toEqual(Array.from(bytes));
    }
  });

  it('returns null where Buffer would guess instead of refusing', () => {
    expect(b64urlDecode('A')).toBeNull(); // leftover bits Buffer silently drops
    expect(b64urlDecode('AB')).toBeNull(); // non-canonical trailing bits
    expect(b64urlDecode('AA=')).toBeNull(); // padding
    expect(b64urlDecode('a+b/c')).toBeNull(); // standard base64, not base64url
    expect(b64urlDecode('AA A')).toBeNull(); // stray character Buffer would skip
    expect(b64urlDecode('!')).toBeNull();
  });

  it('decodes the empty string to empty bytes', () => {
    expect(Array.from(b64urlDecode('') ?? [])).toEqual([]);
  });
});
