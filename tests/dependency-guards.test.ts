import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve the actual dependencies Expo consumes, including pnpm's installed patches.
const mobileRequire = createRequire(new URL('../packages/mobile/package.json', import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
const configRequire = createRequire(expoRequire.resolve('@expo/config/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const merge = configRequire('deepmerge') as (
  target: object,
  source: object,
) => Record<string, unknown>;

type LegacySchema = {
  safeParse(value: unknown): { success: boolean };
  safeParseAsync(value: unknown): Promise<{ success: boolean }>;
};
type LegacyZod = {
  unknown(): unknown;
  number(): unknown;
  preprocess(fn: (value: unknown) => unknown, schema: unknown): unknown;
  array(
    schema: unknown,
  ): LegacySchema & { max(n: number): LegacySchema; length(n: number): LegacySchema };
};

describe('installed dependency guards', () => {
  it.each(['source', 'target'] as const)(
    'keeps %s keys from changing a merged prototype',
    (side) => {
      const supplied = JSON.parse(
        '{"__proto__":{"unexpected":true},"nested":{"value":1}}',
      ) as object;
      const result = side === 'source' ? merge({}, supplied) : merge(supplied, {});
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result['unexpected']).toBeUndefined();
      expect(result['nested']).toEqual({ value: 1 });
      expect(merge({ list: [1], nested: { a: 1 } }, { list: [2], nested: { b: 2 } })).toEqual({
        list: [1, 2],
        nested: { a: 1, b: 2 },
      });
    },
  );

  it.each([false, true])(
    'rejects oversized legacy arrays before parsing elements (async=%s)',
    async (async) => {
      const z = cliRequire('zod') as LegacyZod;
      let visited = 0;
      const schema = z
        .array(
          z.preprocess((value) => {
            visited++;
            return value;
          }, z.unknown()),
        )
        .max(2);
      const result = async
        ? await schema.safeParseAsync(Array(1000).fill(1))
        : schema.safeParse(Array(1000).fill(1));
      expect(result.success).toBe(false);
      expect(visited).toBe(0);
      expect(schema.safeParse([1, 2]).success).toBe(true);
    },
  );

  it.each(['cjs', 'esm'] as const)(
    'bounds legacy array failures through the %s entry point',
    async (entry) => {
      const z = (
        entry === 'cjs'
          ? cliRequire('zod')
          : await import(pathToFileURL(cliRequire.resolve('zod').replace(/\.cjs$/, '.js')).href)
      ) as LegacyZod;
      let visited = 0;
      const schema = z.array(
        z.preprocess((value) => {
          visited++;
          return value;
        }, z.number()),
      );
      expect(schema.safeParse(Array(1000).fill('invalid')).success).toBe(false);
      expect(visited).toBe(1);
      visited = 0;
      expect((await schema.safeParseAsync(Array(1000).fill('invalid'))).success).toBe(false);
      expect(visited).toBe(1);
      visited = 0;
      expect(schema.length(2).safeParse(Array(1000).fill(1)).success).toBe(false);
      expect(visited).toBe(0);
      expect((await schema.safeParseAsync([1, 2])).success).toBe(true);
    },
  );

  it('preserves safe own keys for null-prototype sources and nested targets', () => {
    const source = Object.create(null) as Record<string, unknown>;
    source['__proto__'] = { unexpected: true };
    const symbol = Symbol('kept');
    Object.defineProperty(source, symbol, { enumerable: true, value: 42 });
    const result = merge(Object.create(null) as object, source);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result['unexpected']).toBeUndefined();
    expect(Reflect.get(result, symbol)).toBe(42);
    const nested = merge({ nested: JSON.parse('{"__proto__":{"unexpected":true}}') }, {});
    expect(Object.getPrototypeOf(nested['nested'])).toBe(Object.prototype);
  });

  it('bounds validation errors from Expo plugin command lists', () => {
    const { PluginSchema } = cliRequire('./build/src/start/server/DevToolsPlugin.schema.js') as {
      PluginSchema: {
        safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } };
      };
    };
    const plugin = {
      packageName: 'dependency-control',
      packageRoot: '/synthetic',
      cliExtensions: {
        description: 'control',
        entryPoint: 'index.js',
        commands: Array.from({ length: 1000 }, () => ({
          name: '',
          title: '',
          environments: ['cli'],
        })),
      },
    };
    const result = PluginSchema.safeParse(plugin);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(2);
    plugin.cliExtensions.commands = [{ name: 'check', title: 'Check', environments: ['cli'] }];
    expect(PluginSchema.safeParse(plugin).success).toBe(true);
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
