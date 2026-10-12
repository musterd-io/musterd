import { readFileSync } from 'node:fs';
import { seenPath } from './config.ts';
import type { RadarCandidate, SeenLedger } from './types.ts';

export function loadSeen(path = seenPath): SeenLedger {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeenLedger>;
  return {
    arxiv: Array.isArray(raw.arxiv) ? raw.arxiv.map(String) : [],
    hf: Array.isArray(raw.hf) ? raw.hf.map(String) : [],
    exn: Array.isArray(raw.exn) ? raw.exn.map(String) : [],
    ...(Array.isArray(raw.pending) ? { pending: raw.pending } : {}),
  };
}

export function partitionBySeen(
  candidates: RadarCandidate[],
  seen: SeenLedger,
): { fresh: RadarCandidate[]; alreadySeen: RadarCandidate[] } {
  const arxiv = new Set(seen.arxiv);
  const hf = new Set(seen.hf);
  const exn = new Set(seen.exn);
  const fresh: RadarCandidate[] = [];
  const alreadySeen: RadarCandidate[] = [];
  const seenPair = new Set<string>();
  for (const c of candidates) {
    const key = `${c.source}:${c.id}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    // Cross-source: an HF paper with the same arXiv id already in the arxiv ledger counts as
    // seen (exn ids are uuids, so they can never collide with the paper ledgers).
    if (arxiv.has(c.id) || hf.has(c.id) || exn.has(c.id)) alreadySeen.push(c);
    else fresh.push(c);
  }
  return { fresh, alreadySeen };
}

/** Merge + dedupe candidates by id (prefer arxiv over hf when both present). */
export function mergeCandidates(groups: RadarCandidate[][]): RadarCandidate[] {
  const byId = new Map<string, RadarCandidate>();
  for (const group of groups) {
    for (const c of group) {
      const prev = byId.get(c.id);
      if (!prev || (prev.source === 'hf' && c.source === 'arxiv')) {
        byId.set(c.id, { ...c, relatedExn: unionEpisodes(prev?.relatedExn ?? [], c.relatedExn) });
      } else if (prev) {
        byId.set(c.id, { ...prev, relatedExn: unionEpisodes(prev.relatedExn, c.relatedExn) });
      }
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.published < b.published ? 1 : a.published > b.published ? -1 : 0,
  );
}

function unionEpisodes(
  left: RadarCandidate['relatedExn'],
  right: RadarCandidate['relatedExn'],
): RadarCandidate['relatedExn'] {
  const ids = new Set<string>();
  return [...left, ...right].filter(({ episodeId }) => {
    if (ids.has(episodeId)) return false;
    ids.add(episodeId);
    return true;
  });
}

/** Select the oldest retries and a bounded fresh batch; old pending rows do not expire by date. */
export function partitionRadarCandidates(
  fresh: RadarCandidate[],
  seen: SeenLedger,
  retryLimit: number,
  freshLimit = 50,
): { ready: RadarCandidate[]; deferred: NonNullable<SeenLedger['pending']>; truncated: boolean } {
  const pending = [...(seen.pending ?? [])].sort(
    (a, b) =>
      a.firstAttempt.localeCompare(b.firstAttempt) || a.canonicalId.localeCompare(b.canonicalId),
  );
  const pendingLimit = Math.max(0, Math.min(50, Math.floor(retryLimit)));
  const selected = pending.slice(0, pendingLimit).map(
    (item): RadarCandidate => ({
      source:
        item.sourceIds.find(({ source }) => source !== 'exn')?.source ??
        item.sourceIds[0]?.source ??
        'arxiv',
      id: item.canonicalId,
      title: item.title,
      url: item.url,
      published: item.published,
      relatedExn: item.episodeIds.map((episodeId) => ({ episodeId })),
    }),
  );
  const pendingIds = new Set(pending.map(({ canonicalId }) => canonicalId));
  const genuinelyFresh = fresh.filter(({ id }) => !pendingIds.has(id));
  const selectedFresh = genuinelyFresh.slice(0, Math.min(50, freshLimit));
  return {
    ready: mergeCandidates([selected, selectedFresh]),
    deferred: pending.slice(pendingLimit),
    truncated: pending.length > pendingLimit || genuinelyFresh.length > selectedFresh.length,
  };
}
