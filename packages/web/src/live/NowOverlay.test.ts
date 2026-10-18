import { describe, expect, it } from 'vitest';
import { greeting } from './NowOverlay';

const at = (h: number) => new Date(2026, 9, 18, h, 30).getTime();

describe('greeting', () => {
  it('says hello by the hour, with the viewer by name', () => {
    expect(greeting(at(9), 'ada')).toEqual({ hello: 'Good morning, ada', day: 'Sunday, October 18' });
    expect(greeting(at(14), 'ada').hello).toBe('Good afternoon, ada');
    expect(greeting(at(20), 'ada').hello).toBe('Good evening, ada');
    expect(greeting(at(2), 'ada').hello).toBe('Up late, ada');
  });
  it('greets an observer without a name', () => {
    expect(greeting(at(9), null).hello).toBe('Good morning');
  });
});
