/**
 * The typed questions put to Jev / Laya, in two framings each. The canonical framing names options by
 * their musterd key; the renamed framing uses opaque keys in a shuffled order (and, for the yes/no
 * question, the negated proposition). A judge that understands the criteria gives the same underlying
 * answer both ways; the flip rate between them is the framing-sensitivity number the lane pre-registers.
 */
import type { Question } from './dataset.ts';

export type Framing = 'canonical' | 'renamed';

/** The request shape shared by Jev's system_one API and Laya (`choice` / `noul`). */
export type TypedQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string };

const NONE = 'none of these fits';

const ACT_CRITERIA: Record<string, string> = {
  message: 'a free-form note or answer that is none of the more specific acts below',
  status_update: 'reports the sender’s own progress or state to the team; asks nothing of anyone',
  request_help: 'asks a teammate to do something or review something for the sender',
  handoff: 'transfers ownership of a unit of work (a lane, a branch) to someone else',
  accept: 'agrees to or takes on a request someone else made, or approves their outcome',
  decline: 'refuses or returns a request someone else made, or rejects their outcome',
  wait: 'says the sender is on it or pausing, without deciding yet',
  resolve: 'closes a thread or piece of work as finished',
  steer: 'redirects what someone else is doing or should do next',
  challenge: 'asks someone to justify a claim or decision with evidence',
  ask: 'asks a human for a decision, approval, or input before the sender acts',
};
const SPECIES_CRITERIA: Record<string, string> = {
  consult: 'wants the human’s opinion or input; the sender still decides',
  approve: 'wants the human to say yes or no to a specific proposed action',
  escalate: 'hands a problem up because the sender cannot or should not resolve it',
};

const OWES_REPLY = 'Does this message call for a direct reply from the member it is addressed to?';
const OWES_REPLY_NEG = 'Can the member this message is addressed to leave it without any reply?';

function base(q: Question): TypedQuestion {
  switch (q) {
    case 'act_choice':
      return {
        type: 'choice',
        instructions: 'Which coordination act is this message, judged by what it does?',
        criteria: { ...ACT_CRITERIA, none: NONE },
      };
    case 'ask_species':
      return {
        type: 'choice',
        instructions: 'This message asks a human something. What kind of ask is it?',
        criteria: { ...SPECIES_CRITERIA, none: NONE },
      };
    case 'owes_reply':
      return { type: 'noul', instructions: OWES_REPLY };
  }
}

/** Deterministic shuffle keyed on the item id, so a rerun reproduces the same renamed framing. */
function shuffle<T>(xs: T[], seed: string): T[] {
  let h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Framed {
  question: TypedQuestion;
  /** Map a returned option key back to the canonical key ('yes'/'no' for the noul question). */
  toCanonical: (key: string) => string;
  /** Map the noul probability back to P(canonical 'yes'). */
  pYes?: (p: number) => number;
}

export function frame(q: Question, framing: Framing, seed: string): Framed {
  const b = base(q);
  if (framing === 'canonical' || b.type === 'noul') {
    if (b.type === 'noul' && framing === 'renamed') {
      return {
        question: { type: 'noul', instructions: OWES_REPLY_NEG },
        toCanonical: (k) => k,
        pYes: (p) => 1 - p,
      };
    }
    return { question: b, toCanonical: (k) => k, pYes: (p) => p };
  }
  const keys = shuffle(Object.keys(b.criteria), seed);
  const opaque = keys.map((_, i) => `option_${i + 1}`);
  const criteria = Object.fromEntries(keys.map((k, i) => [opaque[i]!, b.criteria[k]!]));
  const back = Object.fromEntries(opaque.map((o, i) => [o, keys[i]!]));
  return {
    question: { type: 'choice', instructions: b.instructions, criteria },
    toCanonical: (k) => back[k] ?? k,
  };
}
