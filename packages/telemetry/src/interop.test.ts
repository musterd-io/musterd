import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTelemetryForTests, startTelemetry } from './index.js';

// Its own file because vi.mock is hoisted per file: these shapes must not leak into index.test.ts.
const state = vi.hoisted(() => ({ failBoot: false }));

// The shape a bundler's split chunk hands back for a CommonJS package (the MCP adapter bundle,
// ADR 574): `module.exports` behind `default`, no named exports. A bare destructure of this read
// `resourceFromAttributes` as undefined and closed the adapter on 2026-10-13.
vi.mock('@opentelemetry/resources', async (importOriginal) => ({
  default: await importOriginal<typeof import('@opentelemetry/resources')>(),
}));

vi.mock('@opentelemetry/sdk-node', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opentelemetry/sdk-node')>();
  class NodeSDK extends real.NodeSDK {
    override start(): void {
      if (state.failBoot) throw new Error('boom');
      super.start();
    }
  }
  return { ...real, NodeSDK };
});

describe('startTelemetry against the modules a bundle hands it', () => {
  afterEach(() => {
    resetTelemetryForTests();
    state.failBoot = false;
    vi.restoreAllMocks();
  });

  it('boots when a CommonJS package arrives as default-only', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }; // nothing listens there
    const handle = await startTelemetry({ serviceName: 'musterd-test', env });
    expect(handle.active).toBe(true);
    await handle.shutdown({ timeoutMs: 500 });
  });

  it('never rejects: a failed boot is one stderr line and the no-op handle', async () => {
    state.failBoot = true;
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' };
    const handle = await startTelemetry({ serviceName: 'musterd-test', env });
    expect(handle.active).toBe(false);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('SDK failed to start: boom'));
    await handle.shutdown();
  });
});
