import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AllowanceChips } from './AllowanceChips';
import { allowanceChips, readingAge } from './allowanceLine';

/**
 * The header's allowance chips (ADR 744), rendered with `react-dom/server` as the other
 * `*.render.test.ts` files do. Claims: humans only, offline humans kept, the lowest account leads,
 * and the label and stale note read as comms wrote them (lane 01M5ZFNPKA).
 */

const NOW = 10_000_000;
const MIN = 60_000;

const account = (label: string, left: number, readAt = NOW) => ({
  provider: 'claude' as const,
  label,
  readAt,
  windows: [{ name: '5h', left, resetsAt: 1, kind: 'percent' as const }],
});

const member = (
  name: string,
  kind: 'human' | 'agent',
  accounts: ReturnType<typeof account>[] | null,
  presence = 'online',
): MemberSummary =>
  ({
    id: `m_${name}`,
    name,
    kind,
    presence,
    presences: [],
    allowance: accounts
      ? { readAt: Math.max(...accounts.map((a) => a.readAt)), accounts }
      : undefined,
  }) as unknown as MemberSummary;

describe('allowanceChips', () => {
  it('keeps humans with a reading, offline ones too, and drops agents', () => {
    const chips = allowanceChips(
      [
        member('ada', 'agent', [account('Claude Max', 0.5)]),
        member('nick', 'human', [account('Claude Max', 0.62)]),
        member('swetha', 'human', [account('Claude Pro', 0.35, NOW - 3 * 60 * MIN)], 'offline'),
        member('tom', 'human', null),
      ],
      NOW,
    );
    expect(chips.map((c) => c.name)).toEqual(['nick', 'swetha']);
  });

  it('leads with the lowest account and says how many there are', () => {
    const [chip] = allowanceChips(
      [member('nick', 'human', [account('Claude Max', 0.62), account('Codex Pro', 0.09)])],
      NOW,
    );
    expect(chip?.lines[0]?.text).toBe('Codex Pro 9% left');
    expect(chip?.label).toBe("nick's allowance: Codex Pro 9% left, the lowest of 2 accounts");
    expect(chip?.note).toBeNull();
  });

  it('drops the count for one account and adds the stale note for an offline human', () => {
    const [chip] = allowanceChips(
      [member('swetha', 'human', [account('Claude Pro', 0.35, NOW - 3 * 60 * MIN)], 'offline')],
      NOW,
    );
    expect(chip?.label).toBe("swetha's allowance: Claude Pro 35% left, offline, last read 3h ago");
    expect(chip?.note).toBe('offline · last read 3h ago');
  });

  it('puts the viewer first, then online, then offline', () => {
    const chips = allowanceChips(
      [
        member('ann', 'human', [account('A', 0.5)], 'offline'),
        member('bo', 'human', [account('B', 0.5)]),
        member('zed', 'human', [account('Z', 0.5)]),
      ],
      NOW,
      'zed',
    );
    expect(chips.map((c) => c.name)).toEqual(['zed', 'bo', 'ann']);
  });
});

describe('readingAge', () => {
  it('reads in the card’s units', () => {
    expect(readingAge(30_000)).toBe('just now');
    expect(readingAge(4 * MIN)).toBe('4 min ago');
    expect(readingAge(3 * 60 * MIN)).toBe('3h ago');
    expect(readingAge(50 * 60 * MIN)).toBe('2d ago');
  });
});

describe('AllowanceChips', () => {
  const render = (roster: MemberSummary[]) =>
    renderToStaticMarkup(createElement(AllowanceChips, { roster, now: NOW }));

  it('renders a button per human with the lowest percent, warn ink under 15%', () => {
    const html = render([member('nick', 'human', [account('Codex Pro', 0.09)])]);
    expect(html).toContain('lc-allow__chip is-warn');
    expect(html).toContain('>9%<');
    expect(html).toContain('aria-expanded="false"');
  });

  it('quiets a stale chip', () => {
    const html = render([member('nick', 'human', [account('Claude Max', 0.5, NOW - 5 * MIN)])]);
    expect(html).toContain('is-quiet');
  });

  it('renders nothing when no human has a reading', () => {
    expect(render([member('ada', 'agent', [account('Claude Max', 0.5)])])).toBe('');
  });
});
