/**
 * Weather at the windows (lane 01M5XS6597): what the office's panes show of the sky outside.
 *
 * The office clock is Los Angeles time (`pstNowHours`), so the sky is Los Angeles' too. The viewer's
 * browser asks Open-Meteo (no key, no account) for the current WMO weather code once an hour, and the
 * room draws one of four states over its window panes: clear, cloudy, rain, snow. Nothing is written to
 * the daemon or the protocol, and nothing about the viewer leaves the page — the request names the
 * office's coordinates, not theirs. No network, a slow reply or any error → the last state known, else
 * clear: the office is never wrong-looking for a missing forecast, only sunnier than it should be.
 * (nick, 2026-10-27: the browser path, no city setting.)
 *
 * `?weather=rain|snow|cloudy|clear` on `/live`, `/broadcast` and `/office-preview` overrides the sky —
 * a dev aid for seeing a state, inert unless present, the same shape as `?light=HH`.
 */

export type Weather = 'clear' | 'cloudy' | 'rain' | 'snow';

export const WEATHER_STATES: readonly Weather[] = ['clear', 'cloudy', 'rain', 'snow'];

/** Where the office is: downtown Los Angeles, the clock's city. */
export const OFFICE_LAT = 34.05;
export const OFFICE_LON = -118.24;

/** How long one reading stands before the next ask. The sky does not change by the minute. */
export const WEATHER_TTL_MS = 60 * 60 * 1000;

export const OPEN_METEO_URL = `https://api.open-meteo.com/v1/forecast?latitude=${OFFICE_LAT}&longitude=${OFFICE_LON}&current=weather_code`;

/**
 * The WMO weather interpretation codes Open-Meteo returns, as the four skies the room can draw.
 * 0–1 clear and mainly clear; 2–3 partly to overcast, 45–48 fog — cloudy; 51–67 drizzle and rain,
 * 80–82 showers, 95–99 thunder — rain; 71–77 snow, 85–86 snow showers — snow. Anything unknown is
 * cloudy: a code the table never saw is still weather, and a grey pane is the safe guess.
 */
export function weatherFromCode(code: number): Weather {
  if (!Number.isFinite(code)) return 'cloudy';
  if (code <= 1) return 'clear';
  if (code <= 3 || code === 45 || code === 48) return 'cloudy';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) return 'rain';
  return 'cloudy';
}

/** The `?weather=` override, or null when absent or not a state the room draws. */
export function weatherOverride(search: string): Weather | null {
  try {
    const q = new URLSearchParams(search).get('weather')?.trim().toLowerCase();
    return q && (WEATHER_STATES as readonly string[]).includes(q) ? (q as Weather) : null;
  } catch {
    return null;
  }
}

/** Does a sky animate? Rain and snow move; clear and cloudy are a tint and hold still. */
export function weatherMoves(w: Weather): boolean {
  return w === 'rain' || w === 'snow';
}

/** One reading and when it was taken — what `nextWeather` keeps between asks. */
export interface WeatherReading {
  state: Weather;
  at: number;
}

/**
 * Whether a fresh ask is due: never before the TTL has run out on the last reading. A reading that
 * failed is not a reading — `last` stays what it was, so a flaky network retries on the next tick
 * rather than pinning the sky for an hour on nothing.
 */
export function weatherDue(last: WeatherReading | null, now: number): boolean {
  return last === null || now - last.at >= WEATHER_TTL_MS;
}

/**
 * Ask Open-Meteo for the current code. Resolves to the sky, or null on any failure (offline, blocked,
 * a slow reply past `timeoutMs`, an unexpected body). `fetchImpl` is injectable for tests.
 */
export async function fetchWeather(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<Weather | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPEN_METEO_URL, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { current?: { weather_code?: unknown } };
    const code = body?.current?.weather_code;
    return typeof code === 'number' ? weatherFromCode(code) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
