import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { resetTailscaleCache, type RunTailscale } from './hubDiagnosis.js';
import { noteHubLinkFailure, noteHubLinkOk, readHubLink } from './hubLink.js';

/** ADR 738: what a joiner's pull ticks say about its hub, kept for `musterd status`. */
const ctxOf = (): Ctx => ({ config: {} }) as unknown as Ctx;
const refused = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
const stopped: RunTailscale = async () => ({
  stdout: '{"BackendState":"Stopped"}',
  failed: false,
  text: '',
});

beforeEach(() => resetTailscaleCache());

describe('hub link (ADR 738)', () => {
  it('is null where no pull has run — the hub itself, or a machine without one', () => {
    expect(readHubLink(ctxOf().config, 't1')).toBeNull();
  });

  it('records a good pull as the last sync, with the host only', () => {
    const ctx = ctxOf();
    noteHubLinkOk(ctx, 't1', 'http://100.100.246.14:4849', 1_000);
    expect(readHubLink(ctx.config, 't1')).toEqual({
      hub: '100.100.246.14:4849',
      last_ok_at: 1_000,
      failing_since: null,
      failure: null,
    });
  });

  it('keeps the last sync and the first failure across a run of failures, with the latest cause', async () => {
    const ctx = ctxOf();
    noteHubLinkOk(ctx, 't1', 'http://hub.example:4849', 1_000);
    await noteHubLinkFailure(ctx, 't1', 'http://hub.example:4849', refused(), 2_000);
    await noteHubLinkFailure(
      ctx,
      't1',
      'http://hub.example:4849',
      new DOMException('aborted', 'TimeoutError'),
      3_000,
    );
    expect(readHubLink(ctx.config, 't1')).toEqual({
      hub: 'hub.example:4849',
      last_ok_at: 1_000,
      failing_since: 2_000,
      failure: { kind: 'timeout', code: 'TimeoutError', tailscale: null },
    });
  });

  it('reads Tailscale for a tailnet hub', async () => {
    const ctx = ctxOf();
    await noteHubLinkFailure(ctx, 't1', 'http://100.100.246.14:4849', refused(), 2_000, stopped);
    expect(readHubLink(ctx.config, 't1')?.failure).toEqual({
      kind: 'refused',
      code: 'ECONNREFUSED',
      tailscale: 'stopped',
    });
  });

  it('a good pull after failures clears the failure', async () => {
    const ctx = ctxOf();
    await noteHubLinkFailure(ctx, 't1', 'http://hub.example:4849', refused(), 2_000);
    noteHubLinkOk(ctx, 't1', 'http://hub.example:4849', 5_000);
    expect(readHubLink(ctx.config, 't1')).toMatchObject({
      last_ok_at: 5_000,
      failing_since: null,
      failure: null,
    });
  });

  it('is per daemon config and per team', () => {
    const a = ctxOf();
    const b = ctxOf();
    noteHubLinkOk(a, 't1', 'http://h:1', 1_000);
    expect(readHubLink(b.config, 't1')).toBeNull();
    expect(readHubLink(a.config, 't2')).toBeNull();
  });
});
