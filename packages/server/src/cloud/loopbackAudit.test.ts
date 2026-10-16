import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../config.js';
import { trustsLocalPeer } from './localTrust.js';

/**
 * Spec §5.1 / §8.3, the static half: in cloud mode nothing is trusted for arriving from loopback,
 * because behind Cloudflare + Fly EVERY request arrives from the proxy. That holds only while every
 * loopback-trust decision goes through ONE predicate that cloud mode turns off — so this test reads
 * the source and fails on any other place that consults the peer address.
 */
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

/** Code lines only: a comment that NAMES the peer address is documentation, not a decision. */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(
      ({ text }) => !text.startsWith('*') && !text.startsWith('//') && !text.startsWith('/*'),
    );
}

// The only places allowed to read the peer address, each for a reason that is not trust:
const ALLOWED: Record<string, (text: string) => boolean> = {
  // The predicate itself, and the one wrapper the transports call.
  'config.ts': () => true,
  'cloud/localTrust.ts': () => true,
  // The OAuth rate-limit KEY (who to count), never an authorization: with trustProxy on it is
  // CF-Connecting-IP instead.
  // Admission counter fallback only, never loopback authorization (ADR 634).
  'cloud/teamBudget.ts': (t) =>
    t === 'const address = parsed.success ? parsed.data : req.socket.remoteAddress;',
  'transport/oauth.ts': (t) => t === "return req.socket.remoteAddress ?? 'unknown';",
};

describe('loopback audit — static (1C task 4, spec §8.3)', () => {
  it('no code outside the predicate consults the peer address', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      for (const { line, text } of codeLines(file)) {
        if (!/\bisLocalPeer\(|\bremoteAddress\b/.test(text)) continue;
        if (ALLOWED[rel]?.(text)) continue;
        offenders.push(`${rel}:${line}  ${text}`);
      }
    }
    expect(offenders, 'route the decision through trustsLocalPeer(ctx, req)').toEqual([]);
  });
});

describe('the test issuer stays a test fixture (spec §5.2)', () => {
  it('no runtime module imports cloud/testIssuer', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => /from ['"][./]*(cloud\/)?testIssuer\.js['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(importers).toEqual([]);
  });
});

describe('trustsLocalPeer', () => {
  const req = (remoteAddress: string) => ({ socket: { remoteAddress } }) as IncomingMessage;
  const ctx = (mode: ResolvedConfig['mode'], trustProxy = false) => ({
    config: { mode, trustProxy } as ResolvedConfig,
  });

  it('self-hosted: a loopback peer is local, a remote one is not', () => {
    expect(trustsLocalPeer(ctx('self-hosted'), req('127.0.0.1'))).toBe(true);
    expect(trustsLocalPeer(ctx('self-hosted'), req('::ffff:127.0.0.1'))).toBe(true);
    expect(trustsLocalPeer(ctx('self-hosted'), req('203.0.113.9'))).toBe(false);
  });

  it('cloud: nothing is local, not even 127.0.0.1', () => {
    expect(trustsLocalPeer(ctx('cloud'), req('127.0.0.1'))).toBe(false);
    expect(trustsLocalPeer(ctx('cloud'), req('::1'))).toBe(false);
  });
});
