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

/**
 * The turn-end catcher (ADR 781) on the trace tap. On `Stop`, a last message that ends by asking the
 * person something is raised as an inferred question, so it reaches `/live` and the phone. On the
 * next `UserPromptSubmit` in that session the person has answered in the terminal, so the card is
 * withdrawn. Bounded and silent like the tap: any failure just means no card.
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

export async function catchTurnEnd(
  raw: string,
  opts: { binding: Binding | null; dir: string; client: HttpClient | null },
): Promise<void> {
  try {
    const { binding, dir, client } = opts;
    if (!binding || !client) return;
    const seat = bindingSeat(binding);
    if (!seat) return;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const session = typeof p['session_id'] === 'string' ? p['session_id'] : '';
    if (!session) return;

    if (p['hook_event_name'] === 'UserPromptSubmit') {
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
      return;
    }

    if (p['hook_event_name'] !== 'Stop' || p['stop_hook_active'] === true) return;
    const last = p['last_assistant_message'];
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
    writeRaised(dir, { id, session_id: session });
  } catch {
    /* fail-open by contract */
  }
}
