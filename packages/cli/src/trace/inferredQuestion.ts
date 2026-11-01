import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bindingSeat,
  inferQuestion,
  makeEnvelope,
  type Binding,
  type Question,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { HttpClient } from '../client.js';
import { findMuseSessionLog } from '../host/backends/museUsage.js';
import { museDataRoot } from '../session/enumerate.js';
import { lastGrokMessage, lastMuseMessage, lastOpencodeMessage } from './lastMessage.js';
import { transcriptPathFor } from './tail.js';

/**
 * The turn-end catcher (ADR 781). On a turn's end, a last message that ends by asking the person
 * something is raised as an inferred question, so it reaches `/live` and the phone. On the next
 * prompt in that session the person has answered in the terminal, so the card is withdrawn. Claude
 * Code and OpenCode come in on the trace tap; Grok and Muse on the interrupt probe (ADR 785).
 * Bounded and silent like the tap: any failure just means no card.
 */

/** `.musterd/inferred-question.json`: the open inferred question this workspace raised. */
export const INFERRED_QUESTION_FILE = 'inferred-question.json';

/** An inferred question's body: the seat's last message, clipped. */
export const INFERRED_BODY_MAX = 2_000;

interface Raised {
  id: string;
  session_id: string;
}

function statePath(dir: string): string {
  return join(dir, '.musterd', INFERRED_QUESTION_FILE);
}

export function readRaised(dir: string): Raised | null {
  try {
    const v = JSON.parse(readFileSync(statePath(dir), 'utf8')) as Partial<Raised>;
    return typeof v.id === 'string' && typeof v.session_id === 'string'
      ? { id: v.id, session_id: v.session_id }
      : null;
  } catch {
    return null;
  }
}

function writeRaised(dir: string, raised: Raised): void {
  const path = statePath(dir);
  // Fresh name, O_EXCL, then rename — the idle-wake file's pattern (ADR 558).
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(raised), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One turn boundary, harness-neutral: `begin` (the person typed: withdraw the open card) or `end` (the
 * turn finished: raise its last message if that asks something). `withdrawFirst` is for harnesses
 * with no prompt hook (ADR 785): the next turn's end is the first sign the person answered.
 */
export interface TurnBoundary {
  event: 'begin' | 'end';
  session: string;
  lastMessage?: string | undefined;
  withdrawFirst?: boolean;
}

async function withdraw(
  binding: Binding,
  seat: string,
  client: HttpClient,
  dir: string,
  session: string,
): Promise<void> {
  const raised = readRaised(dir);
  if (!raised || raised.session_id !== session) return;
  rmSync(statePath(dir), { force: true });
  await client.send(
    binding.team,
    makeEnvelope({
      id: ulid(),
      team: binding.team,
      from: seat,
      to: { kind: 'team' },
      act: 'resolve',
      thread: raised.id,
      body: 'answered in the session',
      meta: { withdrawn: 'answered_in_session' },
    }),
  );
}

export async function catchTurn(
  turn: TurnBoundary,
  opts: { binding: Binding | null; dir: string; client: HttpClient | null },
): Promise<void> {
  try {
    const { binding, dir, client } = opts;
    if (!binding || !client || !turn.session) return;
    const seat = bindingSeat(binding);
    if (!seat) return;
    if (turn.event === 'begin' || turn.withdrawFirst) {
      await withdraw(binding, seat, client, dir, turn.session);
      if (turn.event === 'begin') return;
    }
    const last = turn.lastMessage;
    if (typeof last !== 'string') return;
    const inferred = inferQuestion(last);
    if (!inferred) return;
    const question: Question = {
      ...inferred,
      blocking: false,
      audience: 'team',
      inferred: true,
    };
    const id = ulid();
    // The daemon refuses this while the seat has any open question (ADR 781 §3); that throw is the
    // expected "an explicit question already covers it", and lands in the catch below.
    await client.send(
      binding.team,
      makeEnvelope({
        id,
        team: binding.team,
        from: seat,
        to: { kind: 'team' },
        act: 'ask',
        body: clip(last.trim(), INFERRED_BODY_MAX),
        meta: { species: 'consult', question },
      }),
    );
    writeRaised(dir, { id, session_id: turn.session });
  } catch {
    /* fail-open by contract */
  }
}

/**
 * The trace tap's form: a Claude-shaped payload (`Stop` / `UserPromptSubmit`). Claude Code carries
 * the message as `last_assistant_message`; OpenCode's plugin sends the bare boundary, so its message
 * is read from the store (ADR 785).
 */
export async function catchTurnEnd(
  raw: string,
  opts: {
    binding: Binding | null;
    dir: string;
    client: HttpClient | null;
    harness?: string;
    readOpencode?: (session: string) => Promise<string | undefined>;
  },
): Promise<void> {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const session = typeof p['session_id'] === 'string' ? p['session_id'] : '';
    if (!session) return;
    if (p['hook_event_name'] === 'UserPromptSubmit') {
      await catchTurn({ event: 'begin', session }, opts);
      return;
    }
    if (p['hook_event_name'] !== 'Stop' || p['stop_hook_active'] === true) return;
    let last =
      typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : undefined;
    if (last === undefined && opts.harness === 'opencode' && opts.binding && opts.client)
      last = await (opts.readOpencode ?? lastOpencodeMessage)(session);
    await catchTurn({ event: 'end', session, lastMessage: last }, opts);
  } catch {
    /* fail-open by contract */
  }
}

/**
 * The interrupt probe's form (ADR 785): Grok's PreToolUse and Stop, and Muse's Stop, pipe their
 * payload to `musterd inbox --interrupt-check`. `doorbellRang` is that probe's own verdict — when it
 * printed a line, the Stop is blocked and the turn goes on, so its last message is not the last.
 * Neither harness has a prompt hook, so the card is withdrawn at the next boundary instead: Grok's
 * next tool call or turn end, Muse's next turn end.
 */
export async function catchHookTurn(
  raw: string,
  harness: string,
  opts: {
    binding: Binding | null;
    dir: string;
    client: HttpClient | null;
    doorbellRang: boolean;
    env?: NodeJS.ProcessEnv;
    readGrok?: (path: string) => string | undefined;
    readMuse?: (session: string) => string | undefined;
  },
): Promise<void> {
  try {
    const env = opts.env ?? process.env;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string): string | undefined =>
      typeof p[k] === 'string' ? (p[k] as string) : undefined;
    if (harness === 'grok') {
      const session = s('sessionId') ?? s('session_id') ?? '';
      const event = (s('hookEventName') ?? s('hook_event_name') ?? '').toLowerCase();
      const isStop = event === 'stop' || (event === '' && s('reason') !== undefined);
      if (!isStop) {
        if (event === 'pretooluse' || s('toolName') !== undefined || s('tool_name') !== undefined)
          await catchTurn({ event: 'begin', session }, opts);
        return;
      }
      if (s('reason') !== 'end_turn' || p['stopHookActive'] === true || opts.doorbellRang) return;
      const path = transcriptPathFor(
        { harness: 'grok', session_id: session, cwd: s('cwd') ?? opts.dir },
        env,
      );
      const lastMessage = path ? (opts.readGrok ?? lastGrokMessage)(path) : undefined;
      await catchTurn({ event: 'end', session, lastMessage, withdrawFirst: true }, opts);
      return;
    }
    if (harness === 'muse') {
      const session = s('session_id') ?? s('sessionId') ?? env['MUSE_SESSION_ID'] ?? '';
      if (p['stop_hook_active'] === true || opts.doorbellRang || !session) return;
      const lastMessage =
        s('last_assistant_message') ??
        (
          opts.readMuse ??
          ((id: string) => {
            const log = findMuseSessionLog(id, museDataRoot());
            return log ? lastMuseMessage(log) : undefined;
          })
        )(session);
      await catchTurn({ event: 'end', session, lastMessage, withdrawFirst: true }, opts);
    }
  } catch {
    /* fail-open by contract */
  }
}
