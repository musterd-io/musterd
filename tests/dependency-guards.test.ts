import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Resolve the actual dependencies Expo consumes, including pnpm's installed patches (patches/).
const mobileRequire = createRequire(new URL('../packages/mobile/package.json', import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));

describe('installed dependency guards', () => {
  // Expo SDK 58.0.23 dropped both packages the old local patches guarded (GHSA-mrhx-c7xc-m3w5,
  // GHSA-gcqx-w48m-w2h4). If either comes back, it comes back unpatched: fail here first.
  it('the lockfile resolves neither legacy zod nor deepmerge', () => {
    // The lockfile, not module resolution: a global NODE_PATH can answer for a package the repo
    // no longer installs.
    const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    expect(lock).not.toMatch(/^ {2}'?zod@[0-3]\./m);
    expect(lock).not.toMatch(/^ {2}'?deepmerge@/m);
  });

  // TestFlight build 52 (2026-11-05) crashed on open: the expo 58.0.23 bump left expo-constants and
  // expo-font pinned below the SDK, so the lockfile held two copies of each. CocoaPods links one
  // native version while expo's own JS loads the other. An app native module resolves once.
  it('the lockfile resolves each Expo native module at one version', () => {
    const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    const versions = new Map<string, Set<string>>();
    for (const m of lock.matchAll(/^ {2}'?(expo(?:-[a-z-]+)?)@(\d+\.\d+\.\d+)/gm)) {
      const seen = versions.get(m[1]!) ?? new Set<string>();
      seen.add(m[2]!);
      versions.set(m[1]!, seen);
    }
    const duplicated = [...versions]
      .filter(([, v]) => v.size > 1)
      .map(([name, v]) => `${name}@${[...v].join('|')}`);
    expect(versions.get('expo-constants')?.size).toBe(1);
    expect(duplicated).toEqual([]);
  });

  // TestFlight build 54 (2026-11-05) still died at launch: dyld could not find
  // _OBJC_CLASS_$_RCTStatusBarAppearance, which ExpoModulesCore 58.0.30 links against and only
  // react-native 0.88.1 defines — the app pinned 0.88.0. expo doctor reported the mismatch, but the
  // TestFlight build does not fail on it. Every native module the SDK pins must meet its floor.
  it('the app declares every SDK-pinned native module at or above the SDK floor', () => {
    // The floors come from the installed expo, so a stale install would judge against an old SDK:
    // name that first (scripts/check-dist-freshness.ts gates the same thing before typecheck).
    const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
    const lockedExpo = /^ {2}expo@(\d+\.\d+\.\d+):/m.exec(lock)?.[1];
    const installedExpo = (expoRequire('./package.json') as { version: string }).version;
    expect(installedExpo, 'stale install: run `pnpm install`').toBe(lockedExpo);

    const app = JSON.parse(
      readFileSync(new URL('../packages/mobile/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const bundled = expoRequire('./bundledNativeModules.json') as Record<string, string>;
    const parse = (range: string) => range.replace(/^[~^]/, '').split('.').map(Number);
    // Below the floor fails; ahead of it (a newer patch or minor) is the app's call, not a crash.
    const below = Object.entries(app.dependencies)
      .filter(([name]) => bundled[name] !== undefined)
      .filter(([name, declared]) => {
        const [want, have] = [parse(bundled[name]!), parse(declared)];
        for (let i = 0; i < 3; i++) {
          if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) < (want[i] ?? 0);
        }
        return false;
      })
      .map(([name, declared]) => `${name}: ${declared} < ${bundled[name]}`);
    expect(below).toEqual([]);
  });

  it('accepts valid RSA signatures and rejects extra digest algorithm elements', () => {
    // reason: node-forge ships no types; this fixture uses its public ASN.1/RSA API.
    const forge: any = cliRequire('node-forge');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const key = forge.pki.privateKeyFromPem(privateKey);
    const verifier = forge.pki.publicKeyFromPem(publicKey);
    const digest = forge.md.sha256.create().update('dependency control');
    expect(verifier.verify(digest.digest().bytes(), key.sign(digest))).toBe(true);
    const a = forge.asn1;
    for (const extras of [1, 2]) {
      const algorithm = [
        a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.oids.sha256).getBytes()),
        ...Array.from({ length: extras + 1 }, () =>
          a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''),
        ),
      ];
      const info = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, algorithm),
        a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest.digest().bytes()),
      ]);
      const signature = key.sign(a.toDer(info).getBytes(), 'NONE');
      expect(() => verifier.verify(digest.digest().bytes(), signature)).toThrow(/DigestInfo/);
    }
  });
});
