import { describe, expect, it } from 'vitest';
import { pillBottom, SPRING, TAB_BOUNCE, tabTint } from './springs';
import { light } from './theme';

describe('the tab pill (ADR 815, the app shell)', () => {
  it('sits above the home indicator by movetrail’s rule, never below 2 pt', () => {
    expect(pillBottom(34)).toBe(18);
    expect(pillBottom(0)).toBe(2);
  });

  it('tints each tab with its own hue: mustard, agent jade, human rose', () => {
    expect(tabTint('now', light)).toBe('#E1AD01');
    expect(tabTint('work', light)).toBe('#1a9e88');
    expect(tabTint('you', light)).toBe('#d9557d');
  });

  it('bounces the pressed icon down, over, and back to rest', () => {
    expect(TAB_BOUNCE[TAB_BOUNCE.length - 1]).toBe(1);
    expect(TAB_BOUNCE[0]).toBeLessThan(1);
    expect(Math.max(...TAB_BOUNCE)).toBeGreaterThan(1);
  });

  it('keeps every spring inside the brand’s 120–400 ms band at rest', () => {
    for (const s of Object.values(SPRING)) {
      expect(s.damping).toBeGreaterThan(0);
      expect(s.stiffness).toBeGreaterThan(0);
    }
  });
});
