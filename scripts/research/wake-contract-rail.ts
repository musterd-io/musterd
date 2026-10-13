/**
 * ADR 436 Decision 4 — the wake contract rail: one row per harness, derived from the wake ledger.
 *
 * WHY THIS EXISTS. ADR 436 decided not to own the agent loop yet, and set a dated trigger instead
 * (Decision 5): thirty days after clause 1 reached the daemon (2026-09-21 21:04, #1650), revisit if
 * a backend still cannot be priced from its own artifact, or if any harness's median floor exceeds
 * three times Claude Code's. The trigger is "read from the rail, not re-argued" (ADR 436 §Eval) —
 * so the rail has to exist as one command before 2026-10-21. Arms A–E (wiki
 * `resume-bound-is-below-one-wake-life.md`, 2026-09-21) were its first rows, measured by hand.
 *
 * A DERIVED READ, NEVER A STORE. Everything comes from rows already written:
 *   - harness       — the seat's latest `residency.enrolled` row at or before the wake;
 *   - priced        — `residency.wake_cost.cost_usd` present, else its `unpriced_reason`;
 *   - floor         — the wake life's PROMPT tokens: `wake_cost.usage` when the backend reported it,
 *                     else the seat's transcript `usage` rows in trace.db between wake and settle
 *                     (Claude Code prices its wakes but posts no usage, so its tokens only exist there);
 *   - musterd reads — `residency.context_read` rows by the seat between the wake and its first act;
 *   - tool calls    — the seat's R1 tool-call rows in trace.db between the wake and its first act;
 *   - first act     — the seat's first act (not a `status_update`) between the wake and its settle,
 *                     and whether it answered IN the waking act's thread (ADR 434's discharge).
 *
 * PROMPT TOKENS, NORMALISED PER HARNESS. The harnesses disagree on whether "input" includes the
 * cached prefix: Claude Code (`input` + `cache_read` + `cache_creation`) and OpenCode (`input` +
 * `cached`) report it beside input; Codex and Grok report it inside input (cached ≤ input on every
 * row, 2026-09-30). The ADR's "floor" is read as the whole life's prompt tokens — what arm D measured
 * (284,583 for four calls) and the #1650 falsifier recorded (443,286) — not tokens before the act,
 * which no ledger row separates.
 *
 * READ-ONLY over `~/.musterd/musterd.db` (or MUSTERD_DB) and `~/.musterd/trace.db` (or MUSTERD_TRACE_DB).
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/wake-contract-rail.ts \
 *     [--since YYYY-MM-DD] [--team revive] [--wakes] [--json]
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** ADR 436 clause 1 reached the daemon here (#1650, `cd818f7b`); the trigger reads 30 days on. */
export const CLAUSE_1_LANDED = '2026-09-21T21:04:00';
export const TRIGGER_DATE = '2026-10-21';
export const FLOOR_RATIO_LIMIT = 3;

export interface WakeFacts {
  seat: string;
  harness: string;
  /**
   * `reply` — a wake to answer an act (derivation `immediate` / `batched`); `work_order` — a board
   * dispatch that runs a whole coding session. They are different animals: on 2026-09-30 all 18
   * work orders were Claude Code, and mixing them in put its median floor at 928k against arm B's
   * 38k reply. ADR 436's floor is a reply wake's, so only `reply` rows enter the ratio.
   */
  kind: 'reply' | 'work_order';
  ts: number;
  /** The waking act; `lane:<id>` for a work order, which has no thread to answer in. */
  act: string;
  session: string | null;
  /** null when no `wake_cost` row settled this lease. */
  priced: boolean | null;
  unpricedReason: string | null;
  /** ADR 583: `gateway` when the host's metering gateway priced the wake from the provider's usage
   *  block; `harness_artifact` when the harness's own output did; null before ADR 583 landed. */
  priceSource: string | null;
  promptTokens: number | null;
  musterdReads: number;
  /** null when trace.db holds no rows for this seat inside the wake. */
  toolCalls: number | null;
  firstAct: { act: string; inThread: boolean } | null;
}

export interface HarnessRow {
  harness: string;
  kind: WakeFacts['kind'];
  wakes: number;
  settled: number;
  priced: number;
  /** ADR 583: of the priced wakes, how many the gateway priced. */
  viaGateway: number;
  unpricedReasons: Record<string, number>;
  floor: { median: number | null; n: number };
  musterdReads: { median: number | null; n: number };
  toolCalls: { median: number | null; n: number };
  /** Of wakes with a real act id AND a first act. */
  inThread: { yes: number; n: number };
  noAct: number;
}

type Usage = Record<string, number | undefined>;

/** Whole-life prompt tokens for one usage record, per the harness's own reporting convention. */
export function promptTokens(harness: string, u: Usage): number {
  const n = (k: string) => (typeof u[k] === 'number' ? u[k]! : 0);
  switch (harness) {
    case 'claude-code':
      return n('input_tokens') + n('cache_read_tokens') + n('cache_creation_tokens');
    case 'opencode':
    case 'gateway': // ADR 583: the wake_turns shape, cached input split out for every vendor
      return n('input_tokens') + n('cached_input_tokens') + n('cache_write_input_tokens');
    default:
      // codex, grok: the cached prefix is already inside input_tokens.
      return n('input_tokens');
  }
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export function summarise(wakes: WakeFacts[]): HarnessRow[] {
  const by = new Map<string, WakeFacts[]>();
  for (const w of wakes) {
    const key = `${w.harness}\u0000${w.kind}`;
    by.set(key, [...(by.get(key) ?? []), w]);
  }
  const rows: HarnessRow[] = [];
  for (const ws of by.values()) {
    const { harness, kind } = ws[0]!;
    const unpricedReasons: Record<string, number> = {};
    for (const w of ws) {
      if (w.priced === false) {
        const r = w.unpricedReason ?? 'no_reason_given';
        unpricedReasons[r] = (unpricedReasons[r] ?? 0) + 1;
      }
    }
    const floors = ws.flatMap((w) => (w.promptTokens === null ? [] : [w.promptTokens]));
    const withAct = ws.filter((w) => w.firstAct !== null);
    const reads = withAct.map((w) => w.musterdReads);
    const calls = withAct.flatMap((w) => (w.toolCalls === null ? [] : [w.toolCalls]));
    const threaded = withAct.filter((w) => !w.act.startsWith('lane:'));
    rows.push({
      harness,
      kind,
      wakes: ws.length,
      settled: ws.filter((w) => w.priced !== null).length,
      priced: ws.filter((w) => w.priced === true).length,
      viaGateway: ws.filter((w) => w.priced === true && w.priceSource === 'gateway').length,
      unpricedReasons,
      floor: { median: median(floors), n: floors.length },
      musterdReads: { median: median(reads), n: reads.length },
      toolCalls: { median: median(calls), n: calls.length },
      inThread: { yes: threaded.filter((w) => w.firstAct!.inThread).length, n: threaded.length },
      noAct: ws.length - withAct.length,
    });
  }
  return rows.sort(
    (a, b) =>
      (a.kind === 'reply' ? 0 : 1) - (b.kind === 'reply' ? 0 : 1) ||
      b.wakes - a.wakes ||
      a.harness.localeCompare(b.harness),
  );
}

export interface TriggerRead {
  fires: boolean;
  reasons: string[];
  /** Why a clause could not be judged — never read as "holds". */
  unjudged: string[];
}

/**
 * ADR 436 Decision 5, as one read: fires when a harness with settled wakes has priced none of them
 * (any kind — a price reader prices every life), or when a harness's median REPLY floor exceeds
 * FLOOR_RATIO_LIMIT × Claude Code's reply floor.
 */
export function readTrigger(rows: HarnessRow[]): TriggerRead {
  const reasons: string[] = [];
  const unjudged: string[] = [];
  const perHarness = new Map<string, { settled: number; priced: number }>();
  for (const r of rows) {
    const h = perHarness.get(r.harness) ?? { settled: 0, priced: 0 };
    perHarness.set(r.harness, { settled: h.settled + r.settled, priced: h.priced + r.priced });
  }
  for (const [harness, h] of perHarness) {
    if (h.settled > 0 && h.priced === 0) {
      reasons.push(`${harness}: 0/${String(h.settled)} settled wakes priced`);
    }
  }
  rows = rows.filter((r) => r.kind === 'reply');
  const base = rows.find((r) => r.harness === 'claude-code')?.floor.median ?? null;
  if (base === null) {
    unjudged.push('floor ratio: no Claude Code floor to compare against');
  } else {
    for (const r of rows) {
      if (r.harness === 'claude-code') continue;
      if (r.floor.median === null) {
        unjudged.push(`floor ratio: ${r.harness} has no floor reading`);
        continue;
      }
      const ratio = r.floor.median / base;
      if (ratio > FLOOR_RATIO_LIMIT) {
        reasons.push(`${r.harness}: median floor ${ratio.toFixed(1)}× Claude Code's`);
      }
    }
  }
  return { fires: reasons.length > 0, reasons, unjudged };
}

// ---------------------------------------------------------------------------------------------
// loaders

interface AuditRow {
  ts: number;
  actor: string | null;
  target: string | null;
  detail: string | null;
}

const CALL_ROW = `(kind IN ('PostToolUse','PostToolUseFailure') OR (harness = 'grok' AND kind = 'PreToolUse'))`;

function load(dbPath: string, tracePath: string, team: string, sinceMs: number): WakeFacts[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const trace = existsSync(tracePath) ? new DatabaseSync(tracePath, { readOnly: true }) : null;
  try {
    const teamRow = db.prepare('SELECT id FROM teams WHERE slug = ?').get(team) as
      | { id: string }
      | undefined;
    if (!teamRow) throw new Error(`no team ${team}`);
    const teamId = teamRow.id;
    const audit = (action: string, since = 0) =>
      db
        .prepare(
          'SELECT ts, actor, target, detail FROM audit WHERE team_id = ? AND action = ? AND ts >= ? ORDER BY ts',
        )
        .all(teamId, action, since) as unknown as AuditRow[];
    const parse = (d: string | null): Record<string, unknown> => {
      try {
        return d ? (JSON.parse(d) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    const enrolled = audit('residency.enrolled').map((r) => ({
      seat: r.target ?? '',
      ts: r.ts,
      harness: String(parse(r.detail)['harness'] ?? 'unknown'),
    }));
    const harnessAt = (seat: string, ts: number) =>
      enrolled.filter((e) => e.seat === seat && e.ts <= ts).at(-1)?.harness ?? 'unknown';

    const costs = new Map<string, { ts: number; d: Record<string, unknown> }>();
    for (const r of audit('residency.wake_cost', sinceMs)) {
      const d = parse(r.detail);
      if (typeof d['lease_id'] === 'string') costs.set(d['lease_id'], { ts: r.ts, d });
    }
    const reads = audit('residency.context_read', sinceMs).filter(
      (r) => parse(r.detail)['reason'] === undefined, // a refused read is not a read
    );
    const actsOf = db.prepare(
      `SELECT m.act, m.in_reply_to, m.thread_id, m.ts FROM messages m
         JOIN members mem ON mem.id = m.from_member AND mem.name = ?
        WHERE m.team_id = ? AND m.ts >= ? AND m.ts <= ? AND m.act != 'status_update'
        ORDER BY m.ts LIMIT 1`,
    );
    const threadOf = db.prepare('SELECT thread_id FROM messages WHERE id = ?');
    const traceCalls = trace?.prepare(
      `SELECT COUNT(DISTINCT COALESCE(tool_use_id, id)) AS n, COUNT(*) AS rows FROM trace_events
        WHERE team_id = ? AND seat = ? AND ts > ? AND ts < ? AND agent_id IS NULL AND ${CALL_ROW}`,
    );
    const traceAny = trace?.prepare(
      'SELECT COUNT(*) AS n FROM trace_events WHERE team_id = ? AND seat = ? AND ts >= ? AND ts <= ?',
    );
    // The wake's own session: the capture row that names this lease (ADR 436 clause 3). Its digest
    // is a 12-char prefix of trace.db's, so a human session opened beside the wake never adds tokens.
    const wakeDigest = new Map<string, string>();
    for (const r of audit('residency.session_captured', sinceMs - 60 * 60_000)) {
      const cd = parse(r.detail);
      if (typeof cd['wake_lease'] === 'string' && typeof cd['session_digest'] === 'string') {
        wakeDigest.set(cd['wake_lease'], cd['session_digest']);
      }
    }
    const traceUsage = trace?.prepare(
      `SELECT detail FROM trace_events WHERE team_id = ? AND seat = ? AND harness = ?
         AND kind = 'usage' AND ts >= ? AND ts <= ? AND session_digest LIKE ?`,
    );

    // The wake starts at its LEASE, not its `woke` row: the host writes `woke` only after it has
    // verified the seat occupied, and by then the seat has often read its packet already (ghost,
    // 2026-09-29: context_read 16:43:08, woke 16:43:09). Starting at `woke` counted that read as 0.
    const leasedAt = new Map<string, { ts: number; derivation: unknown }>();
    for (const r of audit('residency.wake_leased', sinceMs - 60 * 60_000)) {
      const ld = parse(r.detail);
      if (typeof ld['lease_id'] === 'string') {
        leasedAt.set(ld['lease_id'], { ts: r.ts, derivation: ld['derivation'] });
      }
    }

    const out: WakeFacts[] = [];
    for (const r of audit('residency.woke', sinceMs)) {
      const d = parse(r.detail);
      const seat = r.target ?? '';
      const act = String(d['act'] ?? '');
      const harness = harnessAt(seat, r.ts);
      const leaseId = typeof d['lease_id'] === 'string' ? d['lease_id'] : undefined;
      const cost = leaseId ? costs.get(leaseId) : undefined;
      const leased = leaseId ? leasedAt.get(leaseId) : undefined;
      const start = leased?.ts ?? r.ts;
      const kind: WakeFacts['kind'] =
        leased?.derivation === 'work_order' || act.startsWith('lane:') ? 'work_order' : 'reply';
      const end = cost?.ts ?? r.ts + 30 * 60_000;

      const first = actsOf.get(seat, teamId, start, end) as
        | { act: string; in_reply_to: string | null; thread_id: string | null; ts: number }
        | undefined;
      let firstAct: WakeFacts['firstAct'] = null;
      if (first) {
        const actThread =
          (threadOf.get(act) as { thread_id: string | null } | undefined)?.thread_id ?? act;
        const inThread =
          first.in_reply_to === act || first.thread_id === act || first.thread_id === actThread;
        firstAct = { act: first.act, inThread };
      }
      const until = first?.ts ?? end;

      let promptTok: number | null = null;
      const usage = cost?.d['usage'];
      const priceSource =
        typeof cost?.d['price_source'] === 'string' ? cost.d['price_source'] : null;
      // ADR 583 Decision 3: a gateway-metered wake's floor is read from the provider's usage block
      // in one shape for every vendor (cached input split out) — no per-harness normalisation.
      if (priceSource === 'gateway' && usage && typeof usage === 'object')
        promptTok = promptTokens('gateway', usage as Usage);
      else if (usage && typeof usage === 'object')
        promptTok = promptTokens(harness, usage as Usage);
      else if (traceUsage && cost) {
        const digest = leaseId ? wakeDigest.get(leaseId) : undefined;
        const rows = traceUsage.all(
          teamId,
          seat,
          harness,
          start,
          cost.ts,
          digest ? `${digest}%` : '%',
        ) as { detail: string }[];
        if (rows.length > 0) {
          promptTok = rows.reduce((s, u) => s + promptTokens(harness, parse(u.detail) as Usage), 0);
        }
      }

      let toolCalls: number | null = null;
      if (traceCalls && traceAny) {
        const any = (traceAny.get(teamId, seat, start, end) as { n: number }).n;
        if (any > 0) toolCalls = (traceCalls.get(teamId, seat, start, until) as { n: number }).n;
      }

      out.push({
        seat,
        harness,
        kind,
        ts: r.ts,
        act,
        session: typeof d['session'] === 'string' ? d['session'] : null,
        priced: cost ? typeof cost.d['cost_usd'] === 'number' : null,
        priceSource,
        unpricedReason:
          cost && typeof cost.d['unpriced_reason'] === 'string' ? cost.d['unpriced_reason'] : null,
        promptTokens: promptTok,
        musterdReads: reads.filter((x) => x.actor === seat && x.ts >= start && x.ts <= until)
          .length,
        toolCalls,
        firstAct,
      });
    }
    return out;
  } finally {
    db.close();
    trace?.close();
  }
}

// ---------------------------------------------------------------------------------------------

/** Local wall-clock `YYYY-MM-DD HH:MM` — the same clock host.log and the wiki's arm tables use. */
const local = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** `local()` plus its zone and the UTC instant, so the header reads against `--json`'s ISO `since`. */
const stamped = (ms: number) => {
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${local(ms)} ${zone} = ${new Date(ms).toISOString().slice(0, 16)}Z`;
};

const k = (n: number | null) =>
  n === null ? '—' : n >= 10_000 ? `${String(Math.round(n / 1000))}k` : String(n);
const med = (c: { median: number | null; n: number }) => `${k(c.median)} (n=${String(c.n)})`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = arg(args, '--since');
  const since = sinceArg ? new Date(`${sinceArg}T00:00:00`) : new Date(CLAUSE_1_LANDED);
  if (Number.isNaN(since.getTime())) throw new Error(`--since: not a date: ${String(sinceArg)}`);
  const team = arg(args, '--team') ?? 'revive';
  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');
  const tracePath = process.env.MUSTERD_TRACE_DB ?? join(homedir(), '.musterd', 'trace.db');
  const wakes = load(dbPath, tracePath, team, since.getTime());
  const rows = summarise(wakes);
  const trigger = readTrigger(rows);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify({ team, since: since.toISOString(), rows, trigger, wakes }, null, 2),
    );
    return;
  }
  console.log(
    `=== ADR 436 wake contract rail (${team}, wakes since ${stamped(since.getTime())}) ===`,
  );
  console.log(
    '  harness         wakes  priced        via gw  floor (prompt tok)  musterd reads  tool calls    in thread  no act',
  );
  for (const r of rows) {
    const priced = `${String(r.priced)}/${String(r.settled)}`;
    console.log(
      `  ${(r.kind === 'reply' ? r.harness : `${r.harness} (w/o)`).padEnd(15)} ${String(r.wakes).padStart(5)}  ${priced.padEnd(13)} ` +
        `${(r.viaGateway > 0 ? `gw ${String(r.viaGateway)}` : '').padEnd(7)} ` +
        `${med(r.floor).padEnd(19)} ${med(r.musterdReads).padEnd(14)} ${med(r.toolCalls).padEnd(13)} ` +
        `${`${String(r.inThread.yes)}/${String(r.inThread.n)}`.padEnd(10)} ${String(r.noAct)}`,
    );
    const reasons = Object.entries(r.unpricedReasons);
    if (reasons.length) {
      console.log(
        `  ${''.padEnd(15)} unpriced: ${reasons.map(([why, n]) => `${why} ×${String(n)}`).join(', ')}`,
      );
    }
  }
  if (args.includes('--wakes')) {
    console.log('\n  per wake:');
    for (const w of wakes) {
      console.log(
        `    ${local(w.ts)} ${w.seat.padEnd(9)} ${w.harness.padEnd(12)} ` +
          `${String(w.session ?? '').padEnd(8)} tok ${k(w.promptTokens).padEnd(6)} reads ${String(w.musterdReads)} ` +
          `calls ${w.toolCalls === null ? '—' : String(w.toolCalls)} ` +
          `${w.firstAct ? `${w.firstAct.act}${w.firstAct.inThread ? ' (in thread)' : ''}` : 'no act'}`,
      );
    }
  }
  const verdict = trigger.fires ? `FIRES — ${trigger.reasons.join('; ')}` : 'holds';
  console.log(
    `\n  ADR 436 trigger (binding on ${TRIGGER_DATE}; read now it is advisory): ${verdict}`,
  );
  for (const u of trigger.unjudged) console.log(`    not judged: ${u}`);
  console.log(
    '  (w/o) = board work orders: whole coding sessions, shown apart and never in the floor ratio.\n' +
      '  Medians only; a harness with n < 5 on a column is a reading, not a verdict. Floor = the wake\n' +
      "  life's prompt tokens, normalised per harness (see the header).",
  );
}

if (process.argv[1]?.endsWith('wake-contract-rail.ts')) main();
