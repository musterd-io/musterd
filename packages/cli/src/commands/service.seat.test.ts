import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_SEAT_FILE, serviceSeatAuth } from './service.js';

// 2026-10-19: the operator joined revive-staging, `config.current` / `config.server` moved with
// them, and every service tick sent its revive token to the staging cloud ("invalid service token
// for team revive-staging") — the CI sampler silently stopped recording for two days.
describe('serviceSeatAuth — the token’s own team and daemon win over the machine default', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svc-seat-'));
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        server: 'https://revive-staging.musterd.dev',
        current: 'revive-staging',
        identities: {},
      }),
    );
    mkdirSync(join(dir, 'autorefresh'));
    writeFileSync(join(dir, 'autorefresh', 'seat-token'), 'mssvc_test\n');
    process.env['MUSTERD_CONFIG'] = config;
    process.env['MUSTERD_SERVICE_TOKEN_FILE'] = join(dir, 'autorefresh', 'seat-token');
    delete process.env['MUSTERD_SERVICE_TEAM'];
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('with no seat.json (a pre-fix install), the machine default stands', () => {
    const auth = serviceSeatAuth()!;
    expect(auth.team).toBe('revive-staging');
    expect(auth.http.server).toBe('https://revive-staging.musterd.dev');
  });

  it('seat.json beside the token names the team and daemon the token was minted on', () => {
    writeFileSync(
      join(dir, 'autorefresh', SERVICE_SEAT_FILE),
      JSON.stringify({ team: 'revive', server: 'http://localhost:4849' }),
    );
    const auth = serviceSeatAuth()!;
    expect(auth.team).toBe('revive');
    expect(auth.http.server).toBe('http://localhost:4849');
  });

  it('an explicit env team and a caller-named daemon still win over seat.json', () => {
    writeFileSync(
      join(dir, 'autorefresh', SERVICE_SEAT_FILE),
      JSON.stringify({ team: 'revive', server: 'http://localhost:4849' }),
    );
    process.env['MUSTERD_SERVICE_TEAM'] = 'other';
    const auth = serviceSeatAuth({ server: 'http://127.0.0.1:9' })!;
    expect(auth.team).toBe('other');
    expect(auth.http.server).toBe('http://127.0.0.1:9');
  });

  it('a malformed seat.json is ignored, never a throw', () => {
    writeFileSync(join(dir, 'autorefresh', SERVICE_SEAT_FILE), '{nope');
    expect(serviceSeatAuth()!.team).toBe('revive-staging');
  });
});
