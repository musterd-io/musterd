import { describe, expect, it } from 'vitest';
import type { TeamPolicyRead } from '../client';
import { POLICY_GROUPS, fromInput, knobIsSet, knobValue, toInput, withKnob, type Knob } from './policyKnobs';

const knob = (path: string): Knob => {
  const found = POLICY_GROUPS.flatMap((g) => g.knobs).find((k) => k.path.join('.') === path);
  if (!found) throw new Error(`no knob ${path}`);
  return found;
};

describe('withKnob', () => {
  it('sets one nested knob and carries every other key, secrets included', () => {
    const stored = {
      seeds_relay_token: 'secret',
      residency: { hourly_cap: 4 },
      style: { prose: 'Lead with the answer.' },
    };
    expect(withKnob(stored, ['residency', 'idle_wake'], false)).toEqual({
      seeds_relay_token: 'secret',
      residency: { hourly_cap: 4, idle_wake: false },
      style: { prose: 'Lead with the answer.' },
    });
  });

  it('undefined drops the key, and an emptied block goes whole (ADR 185: stored as never set)', () => {
    const stored = { residency: { hourly_cap: 4 }, spend_cap_usd: 50 };
    expect(withKnob(stored, ['residency', 'hourly_cap'], undefined)).toEqual({ spend_cap_usd: 50 });
    expect(withKnob(stored, ['spend_cap_usd'], undefined)).toEqual({ residency: { hourly_cap: 4 } });
  });

  it('never mutates what it was given', () => {
    const stored = { residency: { hourly_cap: 4 } };
    withKnob(stored, ['residency', 'hourly_cap'], 9);
    expect(stored).toEqual({ residency: { hourly_cap: 4 } });
  });
});

describe('knob reads', () => {
  const read = {
    policy: { residency: { hourly_cap: 2, cooldown_ms: 1_800_000 } },
    stored: { residency: { hourly_cap: 2 } },
  } as unknown as TeamPolicyRead;

  it('the value is the effective one; "set" is presence in the sparse doc', () => {
    expect(knobValue(read, knob('residency.hourly_cap'))).toBe(2);
    expect(knobIsSet(read, knob('residency.hourly_cap'))).toBe(true);
    expect(knobIsSet(read, knob('residency.cooldown_ms'))).toBe(false);
  });
});

describe('fromInput / toInput', () => {
  it('minutes on screen, milliseconds on the wire', () => {
    const k = knob('residency.cooldown_ms');
    expect(toInput(k.kind, 1_800_000)).toBe('30');
    expect(fromInput(k, '45')).toEqual({ ok: true, value: 2_700_000 });
    expect(fromInput(k, '0')).toEqual({ ok: false, error: '1–1440 min' });
  });

  it('a blank optional knob clears; a blank required one is refused', () => {
    expect(fromInput(knob('spend_cap_usd'), ' ')).toEqual({ ok: true, value: undefined });
    expect(fromInput(knob('residency.hourly_cap'), '')).toEqual({ ok: false, error: 'needs a value' });
  });

  it('holds the schema bounds the daemon will hold', () => {
    expect(fromInput(knob('residency.hourly_cap'), '21').ok).toBe(false);
    expect(fromInput(knob('residency.hourly_cap'), '2.5').ok).toBe(false);
    expect(fromInput(knob('unpriced_wake_cap'), '0')).toEqual({ ok: true, value: 0 });
    expect(fromInput(knob('spend_cap_usd'), '0').ok).toBe(false);
  });
});

describe('the table', () => {
  it('offers no secret — the overlay must never render a token or URL', () => {
    const paths = POLICY_GROUPS.flatMap((g) => g.knobs.map((k) => k.path.join('.')));
    for (const p of paths) expect(p).not.toMatch(/(^|[._])(token|url|webhook)([._]|$)|_token|_url$/);
  });
});
