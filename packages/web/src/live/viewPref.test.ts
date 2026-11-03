import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextView, onViewPref, readViewPref, writeViewPref } from './viewPref';

/**
 * The "Outside" preference (window views inc 3, lane 01M6ENHBPB): which panorama the office windows
 * show on /live. Claims: it round-trips through localStorage, a storage that throws reads as no pref
 * and writes quietly, junk reads as no pref, the cycle visits every view, and a write tells listeners.
 */

function store(): Record<string, string> {
  const data: Record<string, string> = {};
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    },
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('viewPref', () => {
  it('the pref round-trips and survives a throwing localStorage', () => {
    const data = store();
    expect(readViewPref()).toBeNull();
    writeViewPref('coast');
    expect(data['musterd.live.view']).toBe('coast');
    expect(readViewPref()).toBe('coast');
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('private mode');
        },
        setItem: () => {
          throw new Error('private mode');
        },
      },
    });
    expect(readViewPref()).toBeNull();
    expect(() => writeViewPref('mountain')).not.toThrow();
  });

  it('reads a stored value it does not know as no pref', () => {
    const data = store();
    data['musterd.live.view'] = 'moon';
    expect(readViewPref()).toBeNull();
  });

  it('cycles city → coast → mountain → city', () => {
    expect(nextView('city')).toBe('coast');
    expect(nextView('coast')).toBe('mountain');
    expect(nextView('mountain')).toBe('city');
  });

  it('a write tells every listener, and an unsubscribed one hears nothing', () => {
    store();
    const heard: string[] = [];
    const off = onViewPref((v) => heard.push(v));
    writeViewPref('mountain');
    off();
    writeViewPref('city');
    expect(heard).toEqual(['mountain']);
  });
});
