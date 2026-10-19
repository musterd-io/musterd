/**
 * Resident seat pilot readout — the six measures of docs/research/resident-seat-pilot-manifest.md,
 * derived from the daemon's rows (lane 01M4VTAEJZ). The finding (015) is read from the HUB's db
 * after the 48-hour acceptance tail; a joiner's replica gives a provisional read only, and the
 * header says which it was given.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/resident-pilot-readout.ts \
 *     [--db ~/.musterd/musterd.db] [--team revive] [--now <ms>] [--json]
 *
 * Arm membership is the allocation record in docs/research/resident-seat-pilot/window-start.md,
 * copied into ALLOCATION below. A lane that record excludes is listed with its reason and counts
 * for neither arm.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const H = 3_600_000;
/** The worker seat's first `wake_leases` row (window-start.md). */
export const WINDOW_START = Date.parse('2026-10-15T00:11:37Z');
export const WINDOW_END = WINDOW_START + 7 * 24 * H;
export const TAIL_END = WINDOW_END + 48 * H;

export const ARMS = {
  A: { seats: ['resident'], model: 'claude-haiku-5-5' },
  B: { seats: ['mason'], model: 'claude-opus-5-5' },
  C: { seats: ['delta', 'dolly', 'sloane', 'lazara', 'alfie'], model: null },
} as const;
type Arm = keyof typeof ARMS;

interface Allocation {
  lane: string; // 10-char prefix, as window-start.md records it
  arm: 'B' | 'C';
  pass: number;
  excluded?: string;
  note?: string;
}

/** window-start.md passes 1–4, as recorded. A re-handed lane appears once per handoff. */
export const ALLOCATION: Allocation[] = [
  { lane: '01M3ZC3G35', arm: 'B', pass: 1 },
  { lane: '01M41PX0XB', arm: 'C', pass: 1, excluded: 'recipient never wakeable (delta)' },
  { lane: '01M4FF0P6H', arm: 'B', pass: 1, excluded: 'amendment 1, released with intervention' },
  { lane: '01M4FF0S55', arm: 'C', pass: 1, excluded: 'amendment 1 (needs a Twitch viewer)' },
  { lane: '01M4HGY13Z', arm: 'B', pass: 1 },
  { lane: '01M4S53AV4', arm: 'C', pass: 1 },
  { lane: '01M4S7N1HV', arm: 'B', pass: 1 },
  { lane: '01M4VTQ66X', arm: 'C', pass: 1, note: 'delta never wakeable; dolly took it, attended' },
  { lane: '01M4W7HY7Z', arm: 'B', pass: 1 },
  { lane: '01M3AMY549', arm: 'B', pass: 2, excluded: 'amendment 1, released with intervention' },
  { lane: '01M3W3EQ67', arm: 'C', pass: 2 },
  { lane: '01M3W6GWVN', arm: 'B', pass: 2 },
  { lane: '01M3W815KR', arm: 'C', pass: 2, excluded: 'recipient never wakeable (delta)' },
  { lane: '01M4RX7NE2', arm: 'B', pass: 2, note: 'stalled 10-15→10-19; steered 01M5AMG4H8' },
  { lane: '01M4SB4CJP', arm: 'C', pass: 2 },
  { lane: '01M4SB4D7R', arm: 'B', pass: 2 },
  { lane: '01M4VPY8JV', arm: 'C', pass: 2, note: 'delta never wakeable; dolly took it, attended' },
  { lane: '01M3W815KR', arm: 'B', pass: 3 },
  { lane: '01M41PX0XB', arm: 'C', pass: 3 },
  { lane: '01M46GR8AC', arm: 'B', pass: 3 },
  { lane: '01M4S9AVXF', arm: 'C', pass: 3 },
  { lane: '01M50ZB4YM', arm: 'B', pass: 3 },
  { lane: '01M50ZJ9F9', arm: 'C', pass: 3 },
  { lane: '01M5162W38', arm: 'B', pass: 3, note: 'stalled 10-16→10-19; steered 01M5AMG4H8' },
];

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const usd = (v: number) => `$${v.toFixed(2)}`;

export function readout(db: DatabaseSync, team: string, now: number) {
  const teamId = (db.prepare('SELECT id FROM teams WHERE slug = ?').get(team) as Row | undefined)
    ?.id as string | undefined;
  if (!teamId) throw new Error(`no team ${team}`);
  const memberId = (name: string) =>
    (
      db.prepare('SELECT id FROM members WHERE team_id = ? AND name = ?').get(teamId, name) as
        | Row
        | undefined
    )?.id as string | undefined;
  const fullLane = (prefix: string) =>
    (db
      .prepare('SELECT id, state FROM lanes WHERE team_id = ? AND id LIKE ?')
      .get(teamId, `${prefix}%`) as { id: string; state: string } | undefined) ?? null;

  // ── Attestation first: every A/B lease in the window needs a presence that attests its model.
  // Presence rows are pruned once detached, so the `presence.attached` audit row is the record.
  const attestation: Record<string, { leases: number; attested: number; wrong: string[] }> = {};
  for (const arm of ['A', 'B'] as const) {
    const a = { leases: 0, attested: 0, wrong: [] as string[] };
    for (const seat of ARMS[arm].seats) {
      const mid = memberId(seat);
      const leases = db
        .prepare(
          `SELECT id, created_at, expires_at FROM wake_leases
            WHERE team_id = ? AND member_id = ? AND created_at BETWEEN ? AND ?`,
        )
        .all(teamId, mid ?? '', WINDOW_START, WINDOW_END) as Row[];
      for (const l of leases) {
        a.leases++;
        const p = db
          .prepare(
            `SELECT json_extract(detail, '$.model') AS model FROM audit
              WHERE team_id = ? AND action = 'presence.attached' AND actor = ?
                AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 1`,
          )
          .get(teamId, seat, num(l.created_at), num(l.expires_at)) as Row | undefined;
        if (p?.model === ARMS[arm].model) a.attested++;
        else if (p?.model) a.wrong.push(`${String(l.id)}=${String(p.model)}`);
      }
    }
    attestation[arm] = a;
  }

  // ── Measure 1: directed act → first in-thread answer, per arm.
  const m1: Record<
    string,
    {
      acts: number;
      answered: number;
      p50: number | null;
      p95: number | null;
      steeredDelivered: number;
    }
  > = {};
  for (const arm of ['A', 'B', 'C'] as Arm[]) {
    const secs: number[] = [];
    let acts = 0;
    let steered = 0;
    for (const seat of ARMS[arm].seats) {
      const mid = memberId(seat);
      if (!mid) continue;
      const directed = db
        .prepare(
          `SELECT id, ts FROM messages WHERE team_id = ? AND to_kind = 'member' AND to_member = ?
             AND act != 'status_update' AND from_member != ? AND ts BETWEEN ? AND ?`,
        )
        .all(teamId, mid, mid, WINDOW_START, WINDOW_END) as Row[];
      for (const d of directed) {
        acts++;
        const reply = db
          .prepare(
            `SELECT MIN(ts) AS ts FROM messages WHERE team_id = ? AND from_member = ?
               AND act != 'status_update' AND ts >= ?
               AND (thread_id = ? OR json_extract(meta, '$.in_reply_to') = ?)`,
          )
          .get(teamId, mid, num(d.ts), d.id as string, d.id as string) as Row;
        if (reply.ts != null) secs.push((num(reply.ts) - num(d.ts)) / 1000);
      }
      steered += num(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM audit WHERE team_id = ? AND action = 'residency.steered'
                 AND target = ? AND ts BETWEEN ? AND ?`,
            )
            .get(teamId, seat, WINDOW_START, WINDOW_END) as Row
        ).n,
      );
    }
    m1[arm] = {
      acts,
      answered: secs.length,
      p50: percentile(secs, 50),
      p95: percentile(secs, 95),
      steeredDelivered: steered,
    };
  }

  // ── Measures 2 and 3, per allocated lane.
  const lanes = ALLOCATION.map((a) => {
    const lane = fullLane(a.lane);
    const id = lane?.id ?? '';
    const cost = db
      .prepare(
        `SELECT COUNT(*) AS wakes, COALESCE(SUM(json_extract(c.detail, '$.cost_usd')), 0) AS usd,
                SUM(json_extract(c.detail, '$.unpriced_reason') IS NOT NULL) AS unpriced
           FROM wake_leases w JOIN audit c ON c.team_id = w.team_id
            AND c.action = 'residency.wake_cost' AND json_extract(c.detail, '$.lease_id') = w.id
          WHERE w.team_id = ? AND w.lane_id = ?
            AND w.member_id IN (SELECT id FROM members WHERE team_id = w.team_id
                                 AND name IN (SELECT value FROM json_each(?)))`,
      )
      // Only the arm's own seats' wakes: another seat's wake on the lane (a reviewer, a dreamer)
      // is not the arm's spend, and its missing price must not void the arm's lane.
      .get(teamId, id, JSON.stringify(ARMS[a.arm].seats)) as Row;
    const closed = db
      .prepare(
        `SELECT json_extract(detail, '$.reason') AS reason, json_extract(detail, '$.reviewer_family') AS fam, ts
           FROM audit WHERE team_id = ? AND action = 'lane.closed' AND target = ? AND ts <= ?
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(teamId, id, Math.min(now, TAIL_END)) as Row | undefined;
    const outcome = (verb: string) =>
      num(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM audit WHERE team_id = ? AND action = ? AND target = ?`,
            )
            .get(teamId, verb, id) as Row
        ).n,
      );
    const claims = db
      .prepare(
        `SELECT json_extract(j.value, '$.kind') AS kind, json_extract(j.value, '$.verdict') AS verdict
           FROM audit a, json_each(a.detail, '$.claims') j
          WHERE a.team_id = ? AND a.action = 'lane.claims_filed' AND a.target = ?`,
      )
      .all(teamId, id) as Row[];
    return {
      ...a,
      id,
      state: lane?.state ?? 'missing',
      wakes: num(cost.wakes),
      usd: num(cost.usd),
      unpriced: num(cost.unpriced),
      accepted: closed?.reason === 'counterpart_confirm',
      closeReason: (closed?.reason as string | undefined) ?? null,
      reviewerFamily: (closed?.fam as string | undefined) ?? null,
      submits: outcome('lane.ready_for_review'),
      sentBack: outcome('lane.review_sent_back'),
      rerouted: outcome('lane.review_rerouted'),
      claims,
    };
  });

  const arm = (x: 'B' | 'C') => {
    const mine = lanes.filter((l) => l.arm === x && !l.excluded);
    // A lane with no priced wake (attended work leases nothing) or an unpriced one cannot enter
    // the ratio: the rail's rule is that a wake without a price cannot be compared.
    const comparable = mine.filter((l) => l.wakes > 0 && l.unpriced === 0);
    const acceptedComparable = comparable.filter((l) => l.accepted);
    const usdSum = comparable.reduce((s, l) => s + l.usd, 0);
    const claims = mine.flatMap((l) => l.claims);
    return {
      handed: mine.length,
      verdicts: mine.filter((l) => l.closeReason !== null).length,
      accepted: mine.filter((l) => l.accepted).length,
      comparable: comparable.length,
      excludedNoPrice: mine.length - comparable.length,
      usdComparable: usdSum,
      usdPerAccepted: acceptedComparable.length ? usdSum / acceptedComparable.length : null,
      submits: mine.reduce((s, l) => s + l.submits, 0),
      sentBack: mine.reduce((s, l) => s + l.sentBack, 0),
      rerouted: mine.reduce((s, l) => s + l.rerouted, 0),
      claimsConfirmed: claims.filter((c) => c.verdict === 'confirmed').length,
      claimsFiled: claims.length,
    };
  };
  const B = arm('B');
  const C = arm('C');

  // ── Kill criterion (manifest): read only past the readability floor.
  let verdict: string;
  if (B.handed < 8 || B.verdicts < 4)
    verdict = `underpowered — B handed ${B.handed} (floor 8), verdicts ${B.verdicts} (floor 4)`;
  else if (B.usdPerAccepted === null || C.usdPerAccepted === null)
    verdict = 'unreadable — an arm has no priced accepted lane';
  else if (Math.abs(B.usdPerAccepted - C.usdPerAccepted) <= 0.1 * C.usdPerAccepted)
    verdict = 'tie within 10% — no evidence either way; the worker shape waits';
  else if (B.usdPerAccepted > C.usdPerAccepted)
    verdict = 'B costs more per accepted lane — ship coordination-only; the worker shape waits';
  else verdict = 'B costs less per accepted lane — the worker shape is not killed';
  // The manifest's floor is on B only; a baseline priced on one or two lanes is a reading, not a
  // comparison, so the verdict carries C's count wherever it is thin.
  if (C.comparable < 4) verdict += ` (C priced on ${C.comparable} lane(s) — honest-N caveat)`;

  // ── Measure 5: per A/B lease, summed wake_turns vs the lease's wake_cost.
  const m5: Record<string, { leases: number; noCostRow: number; mismatched: string[] }> = {};
  for (const a of ['A', 'B'] as const) {
    const out = { leases: 0, noCostRow: 0, mismatched: [] as string[] };
    for (const seat of ARMS[a].seats) {
      const rows = db
        .prepare(
          `SELECT t.lease_id AS lease, SUM(t.cost_usd) AS turns,
                  (SELECT json_extract(c.detail, '$.cost_usd') FROM audit c
                    WHERE c.team_id = t.team_id AND c.action = 'residency.wake_cost'
                      AND json_extract(c.detail, '$.lease_id') = t.lease_id) AS cost
             FROM wake_turns t WHERE t.team_id = ? AND t.member_id = ?
              AND t.created_at BETWEEN ? AND ? GROUP BY t.lease_id`,
        )
        .all(teamId, memberId(seat) ?? '', WINDOW_START, WINDOW_END) as Row[];
      for (const r of rows) {
        out.leases++;
        if (r.cost == null) out.noCostRow++;
        else if (Math.abs(num(r.turns) - num(r.cost)) > 0.001)
          out.mismatched.push(
            `${String(r.lease)} turns ${num(r.turns).toFixed(4)} cost ${num(r.cost).toFixed(4)}`,
          );
      }
    }
    m5[a] = out;
  }

  return { teamId, now, attestation, m1, lanes, B, C, verdict, m5 };
}

function render(r: ReturnType<typeof readout>, dbPath: string): string {
  const out: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z';
  out.push(`resident seat pilot readout — db ${dbPath}`);
  out.push(
    `window ${iso(WINDOW_START)} → ${iso(WINDOW_END)}, tail to ${iso(TAIL_END)}; read at ${iso(r.now)}`,
  );
  if (r.now < TAIL_END) out.push('PROVISIONAL — the acceptance tail has not ended');
  out.push('\nattestation (A/B leases in window)');
  for (const [a, v] of Object.entries(r.attestation))
    out.push(
      `  ${a}: ${v.attested}/${v.leases} attested${v.wrong.length ? `, wrong model: ${v.wrong.join(', ')}` : ''}`,
    );
  out.push('\n1. directed act → first in-thread answer (seconds)');
  for (const [a, v] of Object.entries(r.m1))
    out.push(
      `  ${a}: ${v.answered}/${v.acts} answered · p50 ${v.p50?.toFixed(1) ?? '—'} · p95 ${v.p95?.toFixed(1) ?? '—'} · steers delivered in-loop ${v.steeredDelivered}`,
    );
  out.push('\n2–4. per lane');
  for (const l of r.lanes)
    out.push(
      `  ${l.arm} p${l.pass} ${l.lane} ${l.state.padEnd(19)} wakes ${String(l.wakes).padStart(3)} ${usd(l.usd).padStart(7)}` +
        ` ${l.accepted ? 'ACCEPTED' : (l.closeReason ?? 'open').padEnd(8)}${l.reviewerFamily ? ` by ${l.reviewerFamily}` : ''}` +
        `${l.excluded ? ` — EXCLUDED: ${l.excluded}` : ''}${l.note ? ` — ${l.note}` : ''}`,
    );
  for (const [name, a] of [
    ['B', r.B],
    ['C', r.C],
  ] as const)
    out.push(
      `  ${name}: handed ${a.handed}, verdicts ${a.verdicts}, accepted ${a.accepted}; comparable ${a.comparable} ` +
        `(${a.excludedNoPrice} without a priced wake), ${usd(a.usdComparable)} → ` +
        `${a.usdPerAccepted === null ? '—' : usd(a.usdPerAccepted)} per accepted · submits ${a.submits}, ` +
        `sent back ${a.sentBack}, re-routed ${a.rerouted} · claims ${a.claimsConfirmed}/${a.claimsFiled} confirmed`,
    );
  out.push(`\nkill criterion: ${r.verdict}`);
  out.push('\n5. cost reconciles (wake_turns vs wake_cost, $0.001)');
  for (const [a, v] of Object.entries(r.m5))
    out.push(
      `  ${a}: ${v.leases} leases · ${v.noCostRow} with no cost row · ${v.mismatched.length} mismatched${v.mismatched.length ? `\n    ${v.mismatched.join('\n    ')}` : ''}`,
    );
  out.push(
    '\n6. adversarial probe: read from window-start.md (failed 10-15, passed 10-16 under ADR 627)',
  );
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const dbPath = arg('--db') ?? join(homedir(), '.musterd', 'musterd.db');
  if (!existsSync(dbPath)) throw new Error(`no db at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const r = readout(db, arg('--team') ?? 'revive', Number(arg('--now') ?? Date.now()));
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r, dbPath));
}
