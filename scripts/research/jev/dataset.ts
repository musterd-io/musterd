/**
 * Jev offline-judge experiment (lane 01M3QCVE6E) — build the labelled item set.
 *
 * Ground truth is what actually happened in the message log, not a label anyone assigned. The act a
 * seat really sent, the `meta.species` it really put on an ask, and whether a directed act really got
 * an in_reply_to answer from its addressee. That keeps the labeller's own belief out of the truth,
 * the same discipline as finding 008.
 *
 * The item file holds team prose, so it is written OUTSIDE the repo (default ~/.musterd/research/jev/)
 * and is never committed (ADR 184: agent prose is not publishable). Bodies are credential-scrubbed
 * (traceScrub, ADR 445 §3), member names are pseudonymised, and ULIDs are masked before they are
 * written — the redacted text is the only thing a hosted backend is ever sent.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scrubCredentials } from '../../../packages/protocol/dist/traceScrub.js';

export type Question = 'act_choice' | 'ask_species' | 'owes_reply';

export interface Item {
  id: string; // sha-derived, not the message id
  question: Question;
  text: string; // redacted body
  truth: string; // option key, or 'yes'/'no' for owes_reply
  split: 'tune' | 'test';
}

/** The acts a seat chooses between when it writes a body (ask kept: it is a choice like any other). */
export const ACTS = [
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
  'resolve',
  'steer',
  'challenge',
  'ask',
] as const;
export const SPECIES = ['consult', 'approve', 'escalate'] as const;

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b|\b01[0-9A-HJKMNP-TV-Z]{8,}\b/g;

/** Redact one body: credentials, member names (longest first, word-bounded), ULIDs. Pure. */
export function redact(body: string, names: string[]): string {
  let out = scrubCredentials(body).text;
  const sorted = [...new Set(names)]
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const n of sorted) {
    const tag = `seat-${createHash('sha256').update(n).digest('hex').slice(0, 4)}`;
    out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), tag);
  }
  return out.replace(ULID, '<id>');
}

/** Deterministic 40/60 tune/test split keyed on the item id. */
export function splitOf(id: string): 'tune' | 'test' {
  return parseInt(id.slice(0, 8), 16) % 10 < 4 ? 'tune' : 'test';
}

/** Daemon-authored or templated bodies carry no seat judgement — excluded from every question. */
export function isGenerated(body: string, meta: Record<string, unknown>): boolean {
  return (
    body.startsWith('[lane]') ||
    'lane_warning' in meta ||
    'lane_review' in meta ||
    'lane_submit' in meta ||
    body.trim().length < 20
  );
}

interface Row {
  id: string;
  act: string;
  body: string;
  meta: string | null;
  to_kind: string;
  to_member: string | null;
  replied: number;
}

function sample<T>(rows: T[], n: number, key: (r: T) => string): T[] {
  return [...rows]
    .sort((a, b) =>
      createHash('sha256').update(key(a)).digest('hex') <
      createHash('sha256').update(key(b)).digest('hex')
        ? -1
        : 1,
    )
    .slice(0, n);
}

export function build(dbPath: string, perClass: number): Item[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const names = (db.prepare('SELECT DISTINCT name FROM members').all() as { name: string }[]).map(
    (r) => r.name,
  );
  const rows = db
    .prepare(
      `SELECT m.id, m.act, m.body, m.meta, m.to_kind, m.to_member,
              EXISTS (SELECT 1 FROM messages r WHERE r.team_id = m.team_id AND r.in_reply_to = m.id
                      AND r.from_member = m.to_member) AS replied
         FROM messages m WHERE m.act != 'insight'`,
    )
    .all() as unknown as Row[];
  db.close();

  const usable = rows.filter(
    (r) => !isGenerated(r.body, r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {}),
  );
  const items: Item[] = [];
  const push = (question: Question, r: Row, truth: string) => {
    const id = createHash('sha256').update(`${question}:${r.id}`).digest('hex').slice(0, 16);
    items.push({ id, question, text: redact(r.body, names), truth, split: splitOf(id) });
  };

  for (const act of ACTS) {
    for (const r of sample(
      usable.filter((x) => x.act === act),
      perClass,
      (x) => x.id,
    ))
      push('act_choice', r, act);
  }
  const asks = usable.filter((x) => x.act === 'ask');
  for (const sp of SPECIES) {
    const of = asks.filter(
      (x) => (JSON.parse(x.meta ?? '{}') as { species?: string }).species === sp,
    );
    for (const r of sample(of, perClass, (x) => x.id)) push('ask_species', r, sp);
  }
  // A directed act a reply is owed to: request_help / ask / challenge / message sent to one member.
  const directed = usable.filter(
    (x) =>
      x.to_kind === 'member' && ['request_help', 'ask', 'challenge', 'message'].includes(x.act),
  );
  for (const r of sample(
    directed.filter((x) => x.replied),
    perClass * 2,
    (x) => x.id,
  ))
    push('owes_reply', r, 'yes');
  for (const r of sample(
    directed.filter((x) => !x.replied),
    perClass * 2,
    (x) => x.id,
  ))
    push('owes_reply', r, 'no');
  return items;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');
  const outDir = process.env.JEV_OUT ?? join(homedir(), '.musterd', 'research', 'jev');
  const items = build(dbPath, Number(process.env.JEV_PER_CLASS ?? 15));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  const counts: Record<string, number> = {};
  for (const i of items)
    counts[`${i.question}/${i.truth}/${i.split}`] =
      (counts[`${i.question}/${i.truth}/${i.split}`] ?? 0) + 1;
  console.log(`${items.length} items → ${join(outDir, 'items.jsonl')}`);
  console.log(counts);
}
