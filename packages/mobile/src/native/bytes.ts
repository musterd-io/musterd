/**
 * UTF-8 and base64url for a runtime that has neither.
 *
 * The app runs on Hermes, where `Buffer` does not exist and `TextEncoder` / `TextDecoder` are
 * not installed globals (React Native ships no encoding polyfill and Expo's WinterCG runtime
 * installs the `*Stream` variants only) — yet the delivery composition needs exactly two
 * conversions: the canonical-JSON route to HPKE's AAD bytes, and base64url halves on the wire
 * (`SealedBody.enc` / `.ct`, the inner `{p,s}`, raw keys, the bytes the daemon signed).
 *
 * So the two codecs live here, small and dependency-free, with their parity against Node's
 * `Buffer` held by `bytes.test.ts` — this file's output must be byte-identical to what the
 * daemon produces with `Buffer.toString('base64url')` / `Buffer.from(s, 'utf8')`, or a body
 * sealed one way refuses to open the other.
 */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** UTF-8 bytes of `text`, encoding a lone surrogate as U+FFFD — what `TextEncoder` does. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * `text` from its UTF-8 bytes. Invalid bytes decode to U+FFFD and never throw — the caller
 * (a schema parse) fails closed on the result anyway, and everything signed was valid UTF-8.
 * Ill-formed sequences consume their *maximal subpart* (the bytes that matched before the
 * failure), the same rule TextDecoder and Node's Buffer follow, so parity holds on prefixes.
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    }
    // A 2-byte lead must cover a real 0x80..0x7FF range (0xC0/0xC1 are overlong); 0xF5..0xFF
    // would encode above U+10FFFF. Anything else starts a replacement character of its own.
    const need =
      b0 >= 0xc2 && b0 <= 0xdf
        ? 1
        : b0 >= 0xe0 && b0 <= 0xef
          ? 2
          : b0 >= 0xf0 && b0 <= 0xf4
            ? 3
            : 0;
    if (need === 0) {
      out += '\uFFFD';
      continue;
    }
    let code = b0 & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    let taken = 0;
    while (taken < need && i + taken < bytes.length) {
      const b = bytes[i + taken]!;
      if (b < 0x80 || b > 0xbf) break;
      code = (code << 6) | (b & 0x3f);
      taken++;
    }
    // The lead plus the continuations that matched is the maximal subpart; the byte that broke
    // the pattern stays for the next pass to judge.
    i += taken;
    const min = need === 1 ? 0x80 : need === 2 ? 0x800 : 0x10000;
    if (taken === need && code >= min && !(code >= 0xd800 && code <= 0xdfff) && code <= 0x10ffff) {
      out += String.fromCodePoint(code);
    } else {
      out += '\uFFFD';
    }
  }
  return out;
}

/** `bytes` as unpadded base64url — exactly `Buffer.toString('base64url')`. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]! +
      B64URL_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * The inverse, strict: only the base64url alphabet, no padding, canonical trailing bits —
 * `null` on anything else. The daemon's encoder emits only canonical forms, so every honest
 * input decodes, and a wire oddity fails closed instead of being guessed at (unlike Node's
 * lenient `Buffer.from(s, 'base64url')`, which skips characters it dislikes).
 */
export function b64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of text) {
    const idx = B64URL_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  // Bits left over must be zero — the sign of a canonical encoding, refused otherwise.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return out.subarray(0, o);
}
