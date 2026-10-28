import { describe, expect, it } from 'vitest';
import {
  fetchWeather,
  OPEN_METEO_URL,
  WEATHER_TTL_MS,
  weatherDue,
  weatherFromCode,
  weatherMoves,
  weatherOverride,
} from './weather';

describe('weather at the windows (lane 01M5XS6597)', () => {
  it('reads the WMO codes as the four skies the room draws, and an unknown code as cloudy', () => {
    expect(weatherFromCode(0)).toBe('clear');
    expect(weatherFromCode(1)).toBe('clear');
    expect(weatherFromCode(3)).toBe('cloudy');
    expect(weatherFromCode(45)).toBe('cloudy');
    expect(weatherFromCode(61)).toBe('rain');
    expect(weatherFromCode(81)).toBe('rain');
    expect(weatherFromCode(95)).toBe('rain');
    expect(weatherFromCode(73)).toBe('snow');
    expect(weatherFromCode(86)).toBe('snow');
    expect(weatherFromCode(999)).toBe('cloudy');
    expect(weatherFromCode(Number.NaN)).toBe('cloudy');
  });

  it('honours ?weather= for a known state only', () => {
    expect(weatherOverride('?weather=rain')).toBe('rain');
    expect(weatherOverride('?light=8&weather=Snow')).toBe('snow');
    expect(weatherOverride('?weather=hail')).toBeNull();
    expect(weatherOverride('')).toBeNull();
  });

  it('only rain and snow move', () => {
    expect(weatherMoves('rain')).toBe(true);
    expect(weatherMoves('snow')).toBe(true);
    expect(weatherMoves('cloudy')).toBe(false);
    expect(weatherMoves('clear')).toBe(false);
  });

  it('asks once an hour, and at once when nothing is known', () => {
    expect(weatherDue(null, 1000)).toBe(true);
    expect(weatherDue({ state: 'clear', at: 1000 }, 1000 + WEATHER_TTL_MS - 1)).toBe(false);
    expect(weatherDue({ state: 'clear', at: 1000 }, 1000 + WEATHER_TTL_MS)).toBe(true);
  });

  it('turns a reply into a sky, and every failure into null, never a throw', async () => {
    const ok = (body: unknown) =>
      (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
    expect(await fetchWeather(ok({ current: { weather_code: 63 } }))).toBe('rain');
    expect(await fetchWeather(ok({ current: {} }))).toBeNull();
    expect(await fetchWeather(ok(null))).toBeNull();
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchWeather(bad)).toBeNull();
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchWeather(down)).toBeNull();
  });

  it('asks for the office, not the viewer', () => {
    expect(OPEN_METEO_URL).toContain('latitude=34.05');
    expect(OPEN_METEO_URL).toContain('longitude=-118.24');
    expect(OPEN_METEO_URL).toContain('current=weather_code');
  });
});
