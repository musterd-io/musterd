/**
 * Stored claims are checked on read (ADR 522): find what a stored note talks about and say what is
 * true now. Bounded and deterministic — a regex pass over the text (notes are ≤ 8 KiB) and indexed
 * lookups, never a model re-reading prose — so it can ride every read without anyone asking.
 *
 * Three things are found:
 * - **lane ids** (ULIDs naming a lane on this Team) — reported only when the lane has ENDED (done,
 *   abandoned) or been parked: that is the fact that changes the note's meaning. A live lane is as
 *   the note left it and says nothing.
 * - **hold ids** — reported with the hold's real state: in force until when, or lifted / ended.
 * - **Team-rule phrases** ("don't merge", "no refreshes", "merge freeze", "hold off on pushing") —
 *   backed when an active hold carries the matching effect, otherwise unsourced: no rule the Team is
 *   under says it. The pre-demo freeze of 2026-09-28 is the case: it lived in exactly this shape.
 *
 * The lines are conclusive on purpose. "Possibly stale, please verify" sends every seat that reads
 * the note off to verify the same thing; "no active hold says this — the Team is not paused" ends it.
 */
import {
  CLAIM_CHECKS_MAX,
  type ClaimCheck,
  describeHoldLine,
  type Hold,
  type HoldEffect,
  isHoldActive,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { getHoldById, listActiveHolds } from './holds.js';

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

/**
 * A Team-rule phrase: a stopping word near a landing verb, or a named freeze. Matched per sentence,
 * so the snippet a seat sees is the clause the note actually wrote.
 */
const RULE_RE =
  /\b(?:(?:don'?t(?! forget)|do not(?! forget)|no|stop|nobody|no one|never|avoid|hold off(?: on)?|paused?|freezes?|frozen|halt)\b[^.!?\n]{0,40}?\b(?:merg(?:e|es|ing)|refresh(?:es|ing)?|push(?:es|ing)?|deploy(?:s|ing)?|bounc(?:e|es|ing)|restart(?:s|ing)?)|(?:merge|code|deploy|demo) freeze)\b/i;

/** Which hold effect a rule phrase claims. `null` = a generic freeze; any enforced hold backs it. */
function effectOf(phrase: string): HoldEffect | null {
  if (/merg|push/i.test(phrase)) return 'merges_paused';
  if (/refresh|bounc|restart|deploy/i.test(phrase)) return 'autorefresh_paused';
  return null;
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

const ENDED_LANE: Record<string, string> = {
  done: 'is done',
  abandoned: 'was abandoned',
  parked: 'is parked by a human',
};

export async function checkClaims(
  db: Driver,
  team: { id: string },
  text: string,
  now: number = Date.now(),
): Promise<ClaimCheck[]> {
  if (!text) return [];
  const checks: ClaimCheck[] = [];
  const seen = new Set<string>();
  const push = (c: ClaimCheck): boolean => {
    if (seen.has(c.ref) || checks.length >= CLAIM_CHECKS_MAX) return false;
    seen.add(c.ref);
    checks.push(c);
    return true;
  };

  // Rules first: they are the claims that spread, and the cap must not crowd them out.
  let active: Hold[] | null = null;
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (checks.length >= CLAIM_CHECKS_MAX) break;
    const m = RULE_RE.exec(sentence);
    if (!m) continue;
    active ??= await listActiveHolds(db, team.id, now);
    const effect = effectOf(m[0]);
    const backing = active.find((h) =>
      effect === null ? h.effect !== 'notice' : h.effect === effect,
    );
    const ref = clip(sentence, 120);
    push(
      backing
        ? {
            kind: 'rule',
            ref,
            verdict: 'current',
            line: `"${ref}" — backed: ${describeHoldLine(backing, now)}.`,
          }
        : {
            kind: 'rule',
            ref,
            verdict: 'unsourced',
            line:
              `"${ref}" — no active Team hold says this, so the Team is not paused. Team rules are ` +
              'set by a human with `musterd hold`; if this was a note to yourself, it binds only you.',
          },
    );
  }

  for (const id of new Set(text.match(ULID_RE) ?? [])) {
    if (checks.length >= CLAIM_CHECKS_MAX) break;
    const hold = await getHoldById(db, team.id, id);
    if (hold) {
      push(
        isHoldActive(hold, now)
          ? {
              kind: 'hold',
              ref: id,
              verdict: 'current',
              line: `hold ${id} is in force: ${describeHoldLine(hold, now)}.`,
            }
          : {
              kind: 'hold',
              ref: id,
              verdict: 'ended',
              line:
                `hold ${id} (${hold.effect.replaceAll('_', ' ')} by ${hold.created_by}) ` +
                `${hold.lifted_at !== null ? `was lifted by ${hold.lifted_by}` : 'has ended'} — ` +
                'whatever this note says it pauses is no longer paused.',
            },
      );
      continue;
    }
    const lane = await db.get<{ state: string; title: string }>(
      'SELECT state, title FROM lanes WHERE team_id = ? AND id = ?',
      [team.id, id],
    );
    const ended = lane ? ENDED_LANE[lane.state] : undefined;
    if (lane && ended) {
      push({
        kind: 'lane',
        ref: id,
        verdict: 'ended',
        line: `lane ${id} ("${clip(lane.title, 60)}") ${ended} — nothing in this note about it is still to do.`,
      });
    }
  }
  return checks;
}
