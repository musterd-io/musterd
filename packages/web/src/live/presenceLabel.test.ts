import { describe, expect, it } from 'vitest';
import {
  identityMeta,
  plateDetailSegments,
  plateModel,
  shortLaneState,
  shortModel,
  shortSurface,
  shortWorkTitle,
} from './presenceLabel';

describe('shortSurface — first-class harnesses keep their own name', () => {
  it('names grok as grok, not grok-cli and not the model family crumb', () => {
    expect(shortSurface('grok')).toBe('grok');
    expect(shortSurface('claude-code')).toBe('claude code');
    expect(shortSurface('opencode')).toBe('opencode');
  });
});

describe('shortModel — the Claude families', () => {
  it('names every Claude family with its version, Fable included', () => {
    expect(shortModel('claude-opus-5')).toBe('opus 5');
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet 4.5');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(shortModel('claude-fable-5')).toBe('fable 5');
  });

  it('never leaves the vendor prefix on a known family', () => {
    // The bug: an unlisted family fell through to the "first two segments" fallback and rendered
    // "claude fable" — vendor + family, no version, and it reads like the harness.
    for (const id of ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-5']) {
      expect(shortModel(id)).not.toContain('claude');
      expect(shortModel(id)).toMatch(/\d/);
    }
  });

  it('keeps the muse-spark version crumb (ghost plate defect)', () => {
    // The fallback kept "muse spark" and dropped the rev, so 1.2 and 1.3 read identically.
    expect(shortModel('muse-spark-1.3-contributor-free')).toBe('muse spark 1.3');
    expect(shortModel('muse-spark-1.2-contributor-free')).toBe('muse spark 1.2');
    expect(plateModel('muse-spark-1.3-contributor-free')).toBe('muse spark 1.3');
  });
});

describe('plateModel', () => {
  it('gives the short model for the always-on plate', () => {
    expect(plateModel('claude-opus-4-5')).toBe('opus 4.5');
  });

  it('is null when there is no model worth showing', () => {
    expect(plateModel(null)).toBeNull();
    expect(plateModel('')).toBeNull();
    expect(plateModel('unknown')).toBeNull();
  });

  it('never carries the harness — that moved to hover', () => {
    expect(plateModel('claude-opus-4-5')).not.toContain('claude code');
  });
});

describe('shortSurface', () => {
  it('maps known harnesses to compact labels', () => {
    expect(shortSurface('claude-code')).toBe('claude code');
    expect(shortSurface('cursor')).toBe('cursor');
    expect(shortSurface('codex')).toBe('codex');
    expect(shortSurface('cli')).toBe('cli');
    expect(shortSurface('web')).toBe('web');
  });
  it('returns empty for missing', () => {
    expect(shortSurface(null)).toBe('');
    expect(shortSurface(undefined)).toBe('');
  });
});

describe('shortModel', () => {
  it('shortens common model ids into glanceable labels', () => {
    expect(shortModel('claude-opus-4-5')).toBe('opus 4.5');
    // The lab's variant name stays; the harness's effort suffix goes (nick, 2026-10-19: big-body's
    // GPT 6 Luna read "gpt6").
    expect(shortModel('gpt-5.6-luna-medium')).toBe('gpt 5.6 luna');
    expect(shortModel('gpt-6-luna')).toBe('gpt 6 luna');
    expect(shortModel('grok-4.7')).toBe('grok 4.7');
    expect(shortModel('claude-opus-4-6')).toBe('opus 4.6');
    expect(shortModel('grok-4.5')).toBe('grok 4.5');
  });
  it('returns empty when unattested', () => {
    expect(shortModel(null)).toBe('');
  });

  it('drops a vendor prefix — a router id names the lab twice', () => {
    expect(shortModel('moonshotai/kimi-k3')).toBe('kimi k3');
    expect(shortModel('opencode/beam-free')).toBe('beam');
  });

  it('drops route words but keeps the stealth name whole', () => {
    expect(shortModel('fledge-alpha-free')).toBe('fledge alpha');
    expect(shortModel('longcat-2.5-preview-free')).toBe('longcat 2.5');
    expect(shortModel('cat-jam-free')).toBe('cat jam');
  });

  it('cuts at a word, never mid-word', () => {
    const s = shortModel('some-very-long-experimental-model-name-v9');
    expect(s.length).toBeLessThanOrEqual(20);
    expect('some very long model name v9'.startsWith(s)).toBe(true);
    expect(shortModel('unknown')).toBe('');
  });
});

describe('identityMeta', () => {
  it('joins surface · model when both present', () => {
    const m = identityMeta({ surface: 'cursor', model: 'grok-4.5' });
    expect(m.line).toBe('cursor · grok 4.5');
    expect(m.title).toContain('cursor');
    expect(m.title).toContain('grok-4.5');
  });
  it('omits the line when both surface and model are empty', () => {
    expect(identityMeta({}).line).toBeNull();
  });
  it('appends role to title always, and to line when set', () => {
    const m = identityMeta({ surface: 'cli', model: null, role: 'backend' });
    expect(m.line).toBe('cli · backend');
    expect(m.title).toContain('backend');
  });
});

describe('plateDetailSegments', () => {
  it('orders model then harness then role', () => {
    expect(
      plateDetailSegments({
        surface: 'cursor',
        model: 'claude-opus-5',
        role: 'backend',
      }),
    ).toEqual(['opus 5', 'cursor', 'backend']);
  });

  it('omits empty parts', () => {
    expect(plateDetailSegments({ surface: 'cli', model: null, role: '' })).toEqual(['cli']);
    expect(plateDetailSegments({ surface: null, model: 'grok-4.5' })).toEqual(['grok 4.5']);
    expect(plateDetailSegments({})).toEqual([]);
  });
});

describe('shortWorkTitle', () => {
  it('leaves short titles alone', () => {
    expect(shortWorkTitle('ship it')).toBe('ship it');
  });
  it('keeps whole words — never mid-word ellipsis', () => {
    expect(shortWorkTitle('Office presence chrome (nameplates + hybrid work)', 4)).toBe(
      'Office presence chrome (nameplates…',
    );
  });
  it('defaults to four words', () => {
    expect(shortWorkTitle('one two three four five six')).toBe('one two three four…');
  });
});

describe('shortLaneState', () => {
  it('maps in-flight states to short chips', () => {
    expect(shortLaneState('active')).toBe('active');
    expect(shortLaneState('blocked')).toBe('blocked');
    expect(shortLaneState('claimed')).toBe('claimed');
    expect(shortLaneState('ready_for_review')).toBe('acceptance');
    expect(shortLaneState('awaiting_acceptance')).toBe('acceptance');
  });
  it('returns null for done/abandoned/null', () => {
    expect(shortLaneState('done')).toBeNull();
    expect(shortLaneState(null)).toBeNull();
  });
});
