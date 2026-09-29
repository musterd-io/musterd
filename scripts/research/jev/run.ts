/**
 * Run every item through a backend in both framings and append raw answers to results-<backend>.jsonl
 * beside the items (outside the repo). Resumable: rows already present are skipped.
 *
 *   JEV backend  — hosted TypeSafe system_one API; needs TYPESAFE_API_KEY. Sends the REDACTED text
 *                  only (authorized by nick 2026-09-29 for this lane; TypeSafe has no zero retention).
 *   LAYA backend — local, Apache-2.0 weights via @receptron/laya (ONNX, no Python). Installed in a
 *                  scratch dir named by LAYA_DIR, never as a repo dependency (hard rule 6).
 *
 *   node scripts/research/jev/run.ts jev|laya
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Item } from './dataset.ts';
import { frame, type Framing, type TypedQuestion } from './questions.ts';

export interface Answer {
  item: string;
  backend: string;
  framing: Framing;
  /** Canonical-key probabilities (choice) or { yes, no } (noul). */
  probs: Record<string, number>;
  ms: number;
  error?: string;
}

type Raw = { choice?: string; probabilities?: Record<string, number>; noul?: number };
type Call = (
  state: Record<string, unknown>,
  questions: Record<string, TypedQuestion>,
) => Promise<Record<string, Raw>>;

async function jevBackend(): Promise<Call> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set');
  return async (state, questions) => {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.JEV_MODEL ?? 'jev-1.13.0', state, questions }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { answers: Record<string, Raw> }).answers;
  };
}

async function layaBackend(): Promise<Call> {
  const dir = process.env.LAYA_DIR;
  if (!dir) throw new Error('LAYA_DIR is not set (a scratch dir with @receptron/laya installed)');
  const req = createRequire(join(dir, 'package.json'));
  const mod = (await import(req.resolve('@receptron/laya'))) as {
    Laya: { load(): Promise<{ systemOne: Call }> };
  };
  const laya = await mod.Laya.load();
  return async (state, questions) =>
    ((await laya.systemOne(state, questions)) as unknown as { answers: Record<string, Raw> })
      .answers;
}

async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < xs.length) await f(xs[i++]!);
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const backend = process.argv[2];
  if (backend !== 'jev' && backend !== 'laya') throw new Error('usage: run.ts jev|laya');
  const dir = process.env.JEV_OUT ?? join(homedir(), '.musterd', 'research', 'jev');
  const items = readFileSync(join(dir, 'items.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Item);
  const out = join(dir, `results-${backend}.jsonl`);
  const done = new Set(
    existsSync(out)
      ? readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const a = JSON.parse(l) as Answer;
            return a.error ? '' : `${a.item}/${a.framing}`;
          })
      : [],
  );
  const call = backend === 'jev' ? await jevBackend() : await layaBackend();
  const jobs = items
    .flatMap((it) => (['canonical', 'renamed'] as Framing[]).map((f) => ({ it, f })))
    .filter(({ it, f }) => !done.has(`${it.id}/${f}`));
  let n = 0;
  await pool(jobs, backend === 'jev' ? 8 : 1, async ({ it, f }) => {
    const framed = frame(it.question, f, it.id);
    const t0 = Date.now();
    const row: Answer = { item: it.id, backend, framing: f, probs: {}, ms: 0 };
    try {
      const a = (await call({ message: it.text }, { q: framed.question }))['q'] ?? {};
      row.ms = Date.now() - t0;
      if (framed.question.type === 'noul') {
        const p = framed.pYes!(a.noul ?? NaN);
        row.probs = { yes: p, no: 1 - p };
      } else {
        for (const [k, p] of Object.entries(a.probabilities ?? {}))
          row.probs[framed.toCanonical(k)] = p;
      }
    } catch (e) {
      row.error = String(e instanceof Error ? e.message : e);
    }
    appendFileSync(out, JSON.stringify(row) + '\n');
    if (++n % 25 === 0) console.log(`${n}/${jobs.length}`);
  });
  console.log(`done: ${n} calls → ${out}`);
}
