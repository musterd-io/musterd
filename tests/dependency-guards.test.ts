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
