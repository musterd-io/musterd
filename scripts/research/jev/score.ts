/**
 * Score a backend's answers against the observed-outcome truth. Pure halves are exported for the test.
 *
 * Per question, on the TEST split, canonical framing: accuracy, ECE (10 equal-width bins on the top
 * probability), multi-class Brier, then the same after one temperature fitted on the TUNE split
 * (grid search, minimising NLL). Framing flip rate = share of items whose argmax differs between the
 * canonical and renamed framings. Pre-registered reject: post-fit ECE > 0.05 or flips > 10%.
 *
 *   node scripts/research/jev/score.ts jev|laya
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Item, Question } from './dataset.ts';
import type { Answer } from './run.ts';

export const argmax = (p: Record<string, number>): string =>
  Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a), ['', -Infinity])[0];

/** Temperature-scale a distribution. Probabilities of exactly 0 are floored so they can recover. */
export function temper(p: Record<string, number>, t: number): Record<string, number> {
  const logits = Object.entries(p).map(([k, v]) => [k, Math.log(Math.max(v, 1e-4)) / t] as const);
  const m = Math.max(...logits.map(([, l]) => l));
  const z = logits.reduce((s, [, l]) => s + Math.exp(l - m), 0);
  return Object.fromEntries(logits.map(([k, l]) => [k, Math.exp(l - m) / z]));
}

export function ece(rows: { p: Record<string, number>; truth: string }[], bins = 10): number {
  const b = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const r of rows) {
    const k = argmax(r.p);
    const c = r.p[k] ?? 0;
    const i = Math.min(bins - 1, Math.floor(c * bins));
    b[i]!.n++;
    b[i]!.conf += c;
    b[i]!.acc += k === r.truth ? 1 : 0;
  }
  return b.reduce(
    (s, x) => s + (x.n ? (x.n / rows.length) * Math.abs(x.acc / x.n - x.conf / x.n) : 0),
    0,
  );
}

export function brier(rows: { p: Record<string, number>; truth: string }[]): number {
  return (
    rows.reduce(
      (s, r) =>
        s +
        Object.entries(r.p).reduce((a, [k, v]) => a + (v - (k === r.truth ? 1 : 0)) ** 2, 0) +
        (r.truth in r.p ? 0 : 1),
      0,
    ) / rows.length
  );
}

export function fitTemperature(rows: { p: Record<string, number>; truth: string }[]): number {
  let best = { t: 1, nll: Infinity };
  for (let t = 0.25; t <= 5.001; t += 0.05) {
    const nll = rows.reduce(
      (s, r) => s - Math.log(Math.max(temper(r.p, t)[r.truth] ?? 0, 1e-6)),
      0,
    );
    if (nll < best.nll) best = { t, nll };
  }
  return Math.round(best.t * 100) / 100;
}

export interface Report {
  question: Question;
  n: number;
  acc: number;
  ece: number;
  brier: number;
  t: number;
  eceFit: number;
  brierFit: number;
  flips: number;
  exactExtremes: number;
  medianMs: number;
  verdict: 'pass' | 'reject' | 'no data';
}

export function report(items: Item[], answers: Answer[], q: Question): Report {
  const byKey = new Map(answers.filter((a) => !a.error).map((a) => [`${a.item}/${a.framing}`, a]));
  const rows = (split: 'tune' | 'test', framing: 'canonical' | 'renamed') =>
    items
      .filter((i) => i.question === q && i.split === split)
      .flatMap((i) => {
        const a = byKey.get(`${i.id}/${framing}`);
        return a ? [{ id: i.id, p: a.probs, truth: i.truth, ms: a.ms }] : [];
      });
  const test = rows('test', 'canonical');
  const t = fitTemperature(rows('tune', 'canonical'));
  const fitted = test.map((r) => ({ ...r, p: temper(r.p, t) }));
  const renamed = new Map(rows('test', 'renamed').map((r) => [r.id, argmax(r.p)]));
  const paired = test.filter((r) => renamed.has(r.id));
  const flips =
    paired.filter((r) => renamed.get(r.id) !== argmax(r.p)).length / Math.max(paired.length, 1);
  const top = test.map((r) => r.p[argmax(r.p)] ?? 0);
  const ms = test.map((r) => r.ms).sort((a, b) => a - b);
  const eceFit = ece(fitted);
  return {
    question: q,
    n: test.length,
    acc: test.filter((r) => argmax(r.p) === r.truth).length / Math.max(test.length, 1),
    ece: ece(test),
    brier: brier(test),
    t,
    eceFit,
    brierFit: brier(fitted),
    flips,
    exactExtremes: top.filter((c) => c >= 0.995).length / Math.max(top.length, 1),
    medianMs: ms[Math.floor(ms.length / 2)] ?? 0,
    verdict: test.length === 0 ? 'no data' : eceFit > 0.05 || flips > 0.1 ? 'reject' : 'pass',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const backend = process.argv[2] ?? 'jev';
  const dir = process.env.JEV_OUT ?? join(homedir(), '.musterd', 'research', 'jev');
  const read = <T>(f: string) =>
    readFileSync(join(dir, f), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  const items = read<Item>('items.jsonl');
  const answers = read<Answer>(`results-${backend}.jsonl`);
  const errors = answers.filter((a) => a.error).length;
  const f = (x: number) => x.toFixed(3);
  console.log(`backend=${backend} answers=${answers.length} errors=${errors}`);
  console.log(
    'question     n   acc    ECE    Brier  T     ECE@T  Brier@T flips  p≥.995 ms   verdict',
  );
  for (const q of ['act_choice', 'ask_species', 'owes_reply'] as Question[]) {
    const r = report(items, answers, q);
    console.log(
      `${q.padEnd(12)} ${String(r.n).padEnd(3)} ${f(r.acc)}  ${f(r.ece)}  ${f(r.brier)}  ${r.t.toFixed(2)}  ${f(r.eceFit)}  ${f(r.brierFit)}   ${f(r.flips)}  ${f(r.exactExtremes)}  ${String(r.medianMs).padEnd(4)} ${r.verdict}`,
    );
  }
}
