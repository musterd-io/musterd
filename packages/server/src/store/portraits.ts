import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PORTRAIT_MAX_BYTES, PORTRAIT_SIZE } from '@musterd/protocol';

/**
 * Member portraits (ADR 797): the 64×64 PNG /live paints from each member's rendered figure, kept so
 * the phone's Seats screen can show the same face. A cache, not a store: the picture is derived from
 * the member's look, so a lost file costs one /live paint. No table, no migration, no sync row.
 *
 * On disk, beside the database: `portraits/<team id>/<digest>.png`, plus `index.json` (member name →
 * digest) per team. A store with no file path (`:memory:`, postgres) keeps them in memory only.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why a candidate portrait was refused, or null when it is a 64×64 PNG within the cap. */
export function portraitProblem(png: Buffer): string | null {
  if (png.length > PORTRAIT_MAX_BYTES) return `a portrait is at most ${PORTRAIT_MAX_BYTES} bytes`;
  // Signature (8), then the IHDR chunk: length (4), type (4), width (4), height (4).
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return 'not a PNG';
  if (png.subarray(12, 16).toString('latin1') !== 'IHDR') return 'not a PNG';
  if (png.readUInt32BE(16) !== PORTRAIT_SIZE || png.readUInt32BE(20) !== PORTRAIT_SIZE)
    return `a portrait is ${PORTRAIT_SIZE}×${PORTRAIT_SIZE}`;
  return null;
}

/** The digest the roster names a portrait by: the first 16 hex characters of its sha256. */
export function portraitDigest(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex').slice(0, 16);
}

export interface PortraitCache {
  /** Keep `png` as `member`'s portrait; answers its digest. The caller has checked it. */
  put(teamId: string, member: string, png: Buffer): string;
  /** Each member's current digest. */
  digests(teamId: string): ReadonlyMap<string, string>;
  /** The PNG for a digest this team holds, or null. */
  get(teamId: string, digest: string): Buffer | null;
}

/** The cache for a daemon whose database lives at `dbPath`. */
export function portraitCache(dbPath: string | undefined): PortraitCache {
  const root =
    !dbPath || dbPath === ':memory:' || dbPath === 'postgres'
      ? null
      : join(dirname(dbPath), 'portraits');
  const indexes = new Map<string, Map<string, string>>();
  const memory = new Map<string, Buffer>();

  const teamDir = (teamId: string) => join(root!, teamId.replace(/[^A-Za-z0-9_-]/g, '_'));

  function index(teamId: string): Map<string, string> {
    let held = indexes.get(teamId);
    if (held) return held;
    held = new Map();
    if (root) {
      try {
        const raw = JSON.parse(
          readFileSync(join(teamDir(teamId), 'index.json'), 'utf8'),
        ) as unknown;
        if (raw && typeof raw === 'object')
          for (const [name, digest] of Object.entries(raw))
            if (typeof digest === 'string' && /^[0-9a-f]{16}$/.test(digest)) held.set(name, digest);
      } catch {
        // No index yet, or an unreadable one: start empty; the next /live paint refills it.
      }
    }
    indexes.set(teamId, held);
    return held;
  }

  return {
    put(teamId, member, png) {
      const digest = portraitDigest(png);
      const held = index(teamId);
      if (root) {
        const dir = teamDir(teamId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${digest}.png`), png);
        held.set(member, digest);
        // Write-then-rename, so a crash mid-write never leaves a torn index.
        const tmp = join(dir, 'index.json.tmp');
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(held)));
        renameSync(tmp, join(dir, 'index.json'));
      } else {
        memory.set(`${teamId}/${digest}`, png);
        held.set(member, digest);
      }
      return digest;
    },
    digests(teamId) {
      return index(teamId);
    },
    get(teamId, digest) {
      if (!/^[0-9a-f]{16}$/.test(digest)) return null;
      if (!root) return memory.get(`${teamId}/${digest}`) ?? null;
      try {
        return readFileSync(join(teamDir(teamId), `${digest}.png`));
      } catch {
        return null;
      }
    },
  };
}

const caches = new Map<string, PortraitCache>();

/** One cache per database path, so every route and the roster read the same index. */
export function portraitsOf(dbPath: string | undefined): PortraitCache {
  const key = dbPath ?? ':memory:';
  let cache = caches.get(key);
  if (!cache) {
    cache = portraitCache(dbPath);
    caches.set(key, cache);
  }
  return cache;
}
