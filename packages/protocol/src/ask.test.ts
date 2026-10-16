import { describe, expect, it } from 'vitest';
import {
  ASK_ACTION_CLASSES,
  ASK_ACTION_CLASS_BY_SPECIES,
  ASK_OUTCOMES,
  ASK_SPECIES,
  ASK_TIERS,
  ASK_TIER_DEFAULTS,
  ASK_TOP_TIER,
  ACCEPTANCE_REVIEW_WINDOW_MS,
  acceptanceAskContract,
  askContract,
  answerAuthority,
  askContractText,
  classifyAskAction,
  reviewWaitMinutes,
  askTierHolds,
} from './ask.js';

describe('the ask tier contract (ADR 147 §2)', () => {
  it('has a contract for every tier, in one place', () => {
    for (const tier of ASK_TIERS) {
      expect(ASK_TIER_DEFAULTS[tier]).toBeDefined();
      expect(askContract(tier)).toEqual(ASK_TIER_DEFAULTS[tier]);
    }
  });

  it('exactly the top tier holds; all others proceed with risk', () => {
    // The load-bearing invariant: only the top tier can wedge (ADR 147 §2 / ADR 145 §3.1).
    expect(ASK_TOP_TIER).toBe(ASK_TIERS[ASK_TIERS.length - 1]);
    expect(askTierHolds(ASK_TOP_TIER)).toBe(true);
    for (const tier of ASK_TIERS) {
      const holds = tier === ASK_TOP_TIER;
      expect(askTierHolds(tier)).toBe(holds);
      expect(askContract(tier).no_answer).toBe(holds ? 'hold' : 'proceed_with_risk');
    }
    // Exactly one holding tier — no ambiguity about which tier wedges.
    expect(ASK_TIERS.filter(askTierHolds)).toHaveLength(1);
  });

  it('timeouts scale up with importance (advisory < standard < blocking)', () => {
    const t = ASK_TIERS.map((tier) => askContract(tier).timeout_ms);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]!);
    // The founder's illustrative numbers (ADR 145 A5): ~3m clarification floor, ~15m top.
    expect(askContract('advisory').timeout_ms).toBe(3 * 60_000);
    expect(askContract('blocking').timeout_ms).toBe(15 * 60_000);
  });

  it('names exactly the three species the design fixes', () => {
    expect([...ASK_SPECIES]).toEqual(['consult', 'escalate', 'approve']);
  });
});

describe('askContractText — the one canonical ask contract phrasing (ADR 147 §2/§4)', () => {
  it('the top tier tells the agent to HOLD and record the held outcome, never proceed', () => {
    const text = askContractText('ask-1', ASK_TOP_TIER);
    expect(text).toContain('HOLD');
    expect(text).toContain('do NOT proceed');
    // The held-outcome recording (ADR 147 §4) — the part MCP's old text omitted.
    expect(text).toContain("meta.ask_outcome='held'");
    expect(text).toContain('ask-1'); // the ask id is threaded in
    expect(text).toContain('15m'); // the blocking timeout, derived from ASK_TIER_DEFAULTS
    expect(text).not.toContain('risk_accepted'); // top tier never risk-proceeds
  });

  it('a below-top tier tells the agent it may PROCEED with a recorded risk-acceptance', () => {
    const text = askContractText('ask-2', 'advisory');
    expect(text).toContain('PROCEED');
    expect(text).toContain("meta.ask_outcome='risk_accepted'");
    expect(text).toContain('meta.chosen_approach');
    expect(text).not.toContain('HOLD');
    expect(text).toContain('3m'); // advisory timeout
  });

  it('derives its minutes from askContract, so the text and the clock never disagree', () => {
    for (const tier of ASK_TIERS) {
      const mins = Math.round(askContract(tier).timeout_ms / 60_000);
      expect(askContractText('x', tier)).toContain(`${mins}m`);
    }
  });
});

describe('the reachability-gated hold (ADR 153)', () => {
  it('stranded joins the terminal outcomes beside held and risk_accepted', () => {
    expect([...ASK_OUTCOMES]).toEqual(['held', 'risk_accepted', 'stranded']);
  });

  it('top tier + provably unreachable → STRAND orders: release the lane with WIP, never proceed', () => {
    const text = askContractText('ask-3', ASK_TOP_TIER, false);
    expect(text).toContain('STRAND');
    expect(text).toContain('do NOT proceed');
    expect(text).toContain("meta.ask_outcome='stranded'");
    expect(text).toContain('release the lane');
    expect(text).toContain('ask-3');
    // Both terminals are non-proceed: the strand branch never risk-proceeds either.
    expect(text).not.toContain('risk_accepted');
  });

  it('top tier + reachable (or unknown — an older daemon) keeps the unchanged HOLD orders', () => {
    for (const reachable of [true, undefined]) {
      const text = askContractText('ask-4', ASK_TOP_TIER, reachable);
      expect(text).toContain('HOLD');
      expect(text).toContain("meta.ask_outcome='held'");
      expect(text).not.toContain('STRAND');
    }
  });

  it('reachability never touches below-top tiers — they proceed with risk regardless', () => {
    for (const reachable of [true, false, undefined]) {
      const text = askContractText('ask-5', 'standard', reachable);
      expect(text).toContain('PROCEED');
      expect(text).not.toContain('STRAND');
    }
  });
});

describe('the lane_review ask window (ADR 506)', () => {
  it('floors a below-top tier at the team window and keeps its no-answer policy', () => {
    expect(acceptanceAskContract('standard')).toEqual({
      timeout_ms: ACCEPTANCE_REVIEW_WINDOW_MS,
      no_answer: 'proceed_with_risk',
    });
    expect(acceptanceAskContract('standard', 45 * 60_000).timeout_ms).toBe(45 * 60_000);
  });

  it('never shortens a tier whose own timeout is longer than the window', () => {
    expect(acceptanceAskContract('blocking', 60_000)).toEqual(askContract('blocking'));
  });

  it('the shipped default is 20 minutes, and the generic tier table is untouched', () => {
    expect(ACCEPTANCE_REVIEW_WINDOW_MS).toBe(20 * 60_000);
    expect(askContract('standard').timeout_ms).toBe(5 * 60_000);
  });

  it('reviewWaitMinutes reads the reported wait, or the default from an older daemon', () => {
    expect(reviewWaitMinutes(10 * 60_000)).toBe(10);
    expect(reviewWaitMinutes(undefined)).toBe(20);
  });
});

describe('the ask action class (ADR 623 §1)', () => {
  it('pins the class table: only consult is advisory, every other species is privileged', () => {
    // Widening this table is a reviewed change (ADR 618 §4). A species added without a row here
    // would be a type error; a row changed here must change this test, on purpose.
    expect(ASK_ACTION_CLASS_BY_SPECIES).toEqual({
      consult: 'advisory',
      escalate: 'privileged',
      approve: 'privileged',
    });
    expect([...ASK_ACTION_CLASSES]).toEqual(['privileged', 'advisory']);
    for (const species of ASK_SPECIES) expect(ASK_ACTION_CLASS_BY_SPECIES[species]).toBeDefined();
  });

  it('classifies a consult with no gate as advisory', () => {
    expect(classifyAskAction({ species: 'consult', tier: 'advisory' })).toBe('advisory');
  });

  it('classifies escalate and approve as privileged', () => {
    expect(classifyAskAction({ species: 'escalate' })).toBe('privileged');
    expect(classifyAskAction({ species: 'approve' })).toBe('privileged');
  });

  it('a gate-raised ask is privileged even when it says consult', () => {
    expect(
      classifyAskAction({ species: 'consult', gate: { class: 'costly-action', fingerprint: 'x' } }),
    ).toBe('privileged');
  });

  it('fails closed: missing meta, missing or unknown species, and prototype keys are privileged', () => {
    expect(classifyAskAction(undefined)).toBe('privileged');
    expect(classifyAskAction(null)).toBe('privileged');
    expect(classifyAskAction({})).toBe('privileged');
    expect(classifyAskAction({ species: 'whatever' })).toBe('privileged');
    expect(classifyAskAction({ species: 42 })).toBe('privileged');
    expect(classifyAskAction({ species: 'constructor' })).toBe('privileged');
    expect(classifyAskAction({ species: '__proto__' })).toBe('privileged');
  });

  it('does not trust a client-supplied action_class in the meta it classifies', () => {
    expect(classifyAskAction({ species: 'approve', action_class: 'advisory' })).toBe('privileged');
  });
});

describe('what an answer is worth (ADR 623 §3)', () => {
  it('an answer with no channel provenance is a plain answer from an authenticated seat', () => {
    expect(answerAuthority({ species: 'approve' }, { in_reply_to: 'a1' })).toBe('authority');
    expect(answerAuthority({}, undefined)).toBe('authority');
    expect(answerAuthority(undefined, null)).toBe('authority');
  });

  it('an A1 channel answer is advisory, for every ask class and every species', () => {
    for (const species of ASK_SPECIES) {
      const ask = { species, action_class: ASK_ACTION_CLASS_BY_SPECIES[species] };
      expect(answerAuthority(ask, { channel_answer: { channel: 'slack', assurance: 'A1' } })).toBe(
        'advisory',
      );
    }
  });

  it('fails closed: any channel_answer is advisory, however malformed, and A2 grants nothing yet', () => {
    expect(answerAuthority({}, { channel_answer: {} })).toBe('advisory');
    expect(answerAuthority({}, { channel_answer: 'A2' })).toBe('advisory');
    expect(answerAuthority({}, { channel_answer: { assurance: 'A2' } })).toBe('advisory');
    expect(answerAuthority({}, { channel_answer: { assurance: 'bogus' } })).toBe('advisory');
  });
});
