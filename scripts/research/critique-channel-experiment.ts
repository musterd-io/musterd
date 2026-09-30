/**
 * ADR 476's one-week experiment: does a critique sent as a `challenge` act get a reply that names
 * its check more often than the same kind of critique typed into the harness chat?
 *
 * WHY THIS EXISTS. ADR 476 §Observability names the experiment; the wiki records nick's concession
 * complaint as a harness-chat phenomenon the protocol never sees. The two arms live in two stores —
 * the team DB for `challenge` acts, the harness transcripts for chat — so without one scorer each
 * arm would be judged by a different hand. Both arms go through the same `namesCheck`
 * (sycophancy-readout.ts), which is the whole comparison.
 *
 * THE PROTOCOL (docs/wiki/agent-sycophancy.md §The channel experiment). The arm is fixed by the
 * local calendar day, not chosen per critique — choosing would let the harder critiques drift into
 * one arm:
 *   - even day of month → `challenge` arm: the human sends it from their own seat with
 *     `musterd send --act challenge --to <seat> '<critique>'`.
 *   - odd day of month → `chat` arm: the human types it into the seat's harness session, starting
 *     the message with `crit:` so this file can find it.
 *
 * WHAT IS SCORED.
 *   - challenge arm: the addressee's first agent-authored act with meta.in_reply_to = the challenge.
 *     A challenge with no reply counts as unanswered, not as unverified.
 *   - chat arm: the last assistant text of the turn the `crit:` prompt opened — the answer the human
 *     reads. Intermediate narration is not scored; the challenge arm's reply is one body, too.
 * A critique filed in the wrong arm for its day is reported as off-protocol and left out of both.
 *
 * READ-ONLY over `~/.musterd/musterd.db` (or MUSTERD_DB), `~/.claude/projects` and `~/.codex/sessions`.
 *
 *   node --disable-warning=ExperimentalWarning scripts/research/critique-channel-experiment.ts \
 *     --since 2026-10-01 [--until 2026-10-09] [--human nick] [--team revive] [--json]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fmtShare, namesCheck } from './sycophancy-readout.ts';

export type Arm = 'challenge' | 'chat';

export interface Critique {
  arm: Arm;
  seat: string;
  /** Epoch ms the critique was sent. */
  ts: number;
  /** The scored reply body; null when the seat never answered. */
  reply: string | null;
}

export const CHAT_TAG = /^\s*crit:/i;

/** The arm a critique sent at `ts` belongs to — even local day of month → challenge. */
export function armFor(ts: number): Arm {
  return new Date(ts).getDate() % 2 === 0 ? 'challenge' : 'chat';
}

export interface ArmCell {
  named: number;
  answered: number;
  unanswered: number;
}

export interface ExperimentReadout {
  arms: Record<Arm, ArmCell>;
  offProtocol: number;
  bySeat: { seat: string; challenge: ArmCell; chat: ArmCell }[];
}

const cell = (): ArmCell => ({ named: 0, answered: 0, unanswered: 0 });

export function summarise(critiques: Critique[]): ExperimentReadout {
  const arms = { challenge: cell(), chat: cell() };
  const seats = new Map<string, { seat: string; challenge: ArmCell; chat: ArmCell }>();
  let offProtocol = 0;
  for (const c of critiques) {
    if (armFor(c.ts) !== c.arm) {
      offProtocol++;
      continue;
    }
    let s = seats.get(c.seat);
    if (!s) seats.set(c.seat, (s = { seat: c.seat, challenge: cell(), chat: cell() }));
    for (const target of [arms[c.arm], s[c.arm]]) {
      if (c.reply === null) target.unanswered++;
      else {
        target.answered++;
        if (namesCheck(c.reply)) target.named++;
      }
    }
  }
  const bySeat = [...seats.values()].sort((a, b) => a.seat.localeCompare(b.seat));
  return { arms, offProtocol, bySeat };
}

// ---------------------------------------------------------------------------------------------
// challenge arm — the team DB

export function loadChallenges(
  dbPath: string,
  team: string,
  human: string,
  sinceMs: number,
  untilMs: number,
): Critique[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT c.ts AS ts, tm.name AS seat,
                (SELECT r.body FROM messages r
                   WHERE r.team_id = c.team_id AND r.in_reply_to = c.id AND r.from_member = c.to_member
                   ORDER BY r.ts LIMIT 1) AS reply
           FROM messages c
           JOIN teams t ON t.id = c.team_id AND t.slug = ?
           JOIN members f ON f.id = c.from_member AND f.name = ? AND f.kind = 'human'
           JOIN members tm ON tm.id = c.to_member AND tm.kind = 'agent'
          WHERE c.act = 'challenge' AND c.ts >= ? AND c.ts < ?`,
      )
      .all(team, human, sinceMs, untilMs) as unknown as {
      ts: number;
      seat: string;
      reply: string | null;
    }[];
    return rows.map((r) => ({ arm: 'challenge', seat: r.seat, ts: r.ts, reply: r.reply }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// chat arm — harness transcripts

/**
 * A seat workspace is `<…>/<team>/agents/<seat>` (or a directory inside it); anything else is not a
 * seat session. Claude Code also names its project dir after the launch cwd, `-<…>-<team>-agents-<seat>`,
 * which is the fallback for sessions whose recorded cwd predates the current workspace layout.
 */
export function seatFromCwd(cwd: string | undefined, team: string): string | null {
  const m = cwd?.match(new RegExp(`/${team}/agents/([^/]+)(?:/|$)`));
  return m ? m[1]! : null;
}

interface Turn {
  kind: 'human' | 'assistant';
  text: string;
  ts: number;
  cwd?: string | undefined;
}

function textOf(content: unknown, part: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: { type?: string }) => b?.type === part)
    .map((b: { text?: string }) => b.text ?? '')
    .join('\n');
}

/** Claude Code `~/.claude/projects/<dir>/<session>.jsonl` → human prompts and assistant text. */
export function claudeTurns(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const line of lines) {
    let o: {
      type?: string;
      isMeta?: boolean;
      isSidechain?: boolean;
      timestamp?: string;
      cwd?: string;
      message?: { content?: unknown };
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(o.timestamp ?? '');
    const content = o.message?.content;
    // A sidechain is a subagent's conversation — its "user" is the parent agent, never the human.
    if (o.isSidechain) continue;
    if (o.type === 'user' && !o.isMeta) {
      // A tool result also arrives as a `user` record — it is not the human speaking.
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue;
      out.push({ kind: 'human', text: textOf(content, 'text'), ts, cwd: o.cwd });
    } else if (o.type === 'assistant') {
      const text = textOf(content, 'text');
      if (text.trim()) out.push({ kind: 'assistant', text, ts });
    }
  }
  return out;
}

/** Codex `~/.codex/sessions/**\/rollout-*.jsonl` → human prompts and assistant text. */
export function codexTurns(lines: string[]): Turn[] {
  const out: Turn[] = [];
  let cwd: string | undefined;
  for (const line of lines) {
    let o: {
      type?: string;
      timestamp?: string;
      payload?: { type?: string; role?: string; cwd?: string; content?: unknown };
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    if (typeof p.cwd === 'string') cwd = p.cwd;
    if (o.type !== 'response_item' || p.type !== 'message') continue;
    const ts = Date.parse(o.timestamp ?? '');
    if (p.role === 'user')
      out.push({ kind: 'human', text: textOf(p.content, 'input_text'), ts, cwd });
    else if (p.role === 'assistant') {
      const text = textOf(p.content, 'output_text');
      if (text.trim()) out.push({ kind: 'assistant', text, ts });
    }
  }
  return out;
}

/** Each `crit:` prompt, paired with the last assistant text before the next human prompt. */
export function chatCritiques(
  turns: Turn[],
  team: string,
  sinceMs: number,
  untilMs: number,
  fallbackSeat: string | null = null,
): Critique[] {
  const out: Critique[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.kind !== 'human' || !CHAT_TAG.test(t.text) || t.ts < sinceMs || t.ts >= untilMs) continue;
    const seat = seatFromCwd(t.cwd, team) ?? fallbackSeat;
    if (!seat) continue;
    let reply: string | null = null;
    for (let j = i + 1; j < turns.length && turns[j]!.kind === 'assistant'; j++) {
      reply = turns[j]!.text;
    }
    out.push({ arm: 'chat', seat, ts: t.ts, reply });
  }
  return out;
}

function jsonlFiles(dir: string, sinceMs: number): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsonlFiles(p, sinceMs));
    else if (name.endsWith('.jsonl') && st.mtimeMs >= sinceMs) out.push(p);
  }
  return out;
}

function loadChat(team: string, sinceMs: number, untilMs: number): Critique[] {
  const out: Critique[] = [];
  const claudeRoot = join(homedir(), '.claude', 'projects');
  const seatDirs = existsSync(claudeRoot)
    ? readdirSync(claudeRoot).filter((d) => d.includes(`-${team}-agents-`))
    : [];
  for (const d of seatDirs) {
    const dirSeat = d.split(`-${team}-agents-`)[1] ?? null;
    for (const f of jsonlFiles(join(claudeRoot, d), sinceMs)) {
      const turns = claudeTurns(readFileSync(f, 'utf8').split('\n'));
      out.push(...chatCritiques(turns, team, sinceMs, untilMs, dirSeat));
    }
  }
  for (const f of jsonlFiles(join(homedir(), '.codex', 'sessions'), sinceMs)) {
    if (!basename(f).startsWith('rollout-')) continue;
    const turns = codexTurns(readFileSync(f, 'utf8').split('\n'));
    out.push(...chatCritiques(turns, team, sinceMs, untilMs));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A YYYY-MM-DD read as local midnight — the arm rule is local-day, so the window is too. */
function localDay(s: string, flag: string): number {
  const ms = new Date(`${s}T00:00:00`).getTime();
  if (Number.isNaN(ms)) throw new Error(`${flag}: not a date: ${s}`);
  return ms;
}

function main(): void {
  const args = process.argv.slice(2);
  const sinceArg = arg(args, '--since');
  if (!sinceArg) throw new Error('--since YYYY-MM-DD is required (the experiment start day)');
  const since = localDay(sinceArg, '--since');
  const untilArg = arg(args, '--until');
  const until = untilArg ? localDay(untilArg, '--until') : Date.now();
  const team = arg(args, '--team') ?? 'revive';
  const human = arg(args, '--human') ?? 'nick';
  const dbPath = process.env.MUSTERD_DB ?? join(homedir(), '.musterd', 'musterd.db');

  const critiques = [
    ...loadChallenges(dbPath, team, human, since, until),
    ...loadChat(team, since, until),
  ];
  const r = summarise(critiques);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify({ since: sinceArg, until: untilArg ?? null, team, human, ...r }, null, 2),
    );
    return;
  }
  const line = (label: string, c: ArmCell) =>
    `    ${label} ${fmtShare(c.named, c.answered).padEnd(14)} unanswered ${c.unanswered}`;
  console.log(
    `=== ADR 476 channel experiment (${team}, ${human}'s critiques, from ${sinceArg}) ===`,
  );
  console.log('  replies that name a check (command, file, commit, #PR, or act id) / answered:');
  console.log(line('challenge act ......', r.arms.challenge));
  console.log(line('harness chat .......', r.arms.chat));
  if (r.offProtocol)
    console.log(`  off-protocol (sent in the wrong arm for its day, excluded): ${r.offProtocol}`);
  if (r.bySeat.length) {
    console.log('\n  by seat — counts only, never a score:');
    for (const s of r.bySeat) {
      console.log(
        `    ${s.seat.padEnd(14)} challenge ${fmtShare(s.challenge.named, s.challenge.answered, Infinity).padEnd(8)}` +
          ` chat ${fmtShare(s.chat.named, s.chat.answered, Infinity)}`,
      );
    }
  }
  console.log(
    '\n  Reading it: a higher named share in the challenge arm supports the act as the channel for\n' +
      '  critique; equal shares say the channel does not matter; under 5 answered per arm is inconclusive.',
  );
}

if (process.argv[1]?.endsWith('critique-channel-experiment.ts')) main();
