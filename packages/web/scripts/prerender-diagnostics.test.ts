import { describe, expect, it } from 'vitest';

import {
  installPrerenderDiagnostics,
  withConnectRetry,
  withPrerenderDiagnostics,
} from './prerender-diagnostics.ts';

const LOCAL = 'http://localhost:4173';

function harness(impl: (req: Request) => Promise<Response>) {
  const lines: string[] = [];
  const fetch = withPrerenderDiagnostics(
    (input) => impl(input instanceof Request ? input : new Request(input)),
    (line) => lines.push(line),
  );
  return { fetch, lines };
}

describe('withPrerenderDiagnostics', () => {
  it('stays silent on a page that rendered', async () => {
    const { fetch, lines } = harness(async () => new Response('<html>ok</html>', { status: 200 }));
    const res = await fetch(new Request(`${LOCAL}/live/`));
    expect(await res.text()).toBe('<html>ok</html>');
    expect(lines).toEqual([]);
  });

  it('names the status, status text and body of a failed page, and still hands the body back', async () => {
    const { fetch, lines } = harness(
      async () =>
        new Response('ReferenceError: window is not defined\n    at OfficePreviewPage', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    );
    const res = await fetch(new Request(`${LOCAL}/office-preview/`));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('window is not defined'); // the plugin still reads it
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[prerender-diag\] \/office-preview\/ → 500 Internal Server Error in \d+ms: ReferenceError: window is not defined at OfficePreviewPage$/,
    );
  });

  it('names a thrown fetch error and its cause code, then rethrows it', async () => {
    const { fetch, lines } = harness(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      });
    });
    await expect(fetch(new Request(`${LOCAL}/broadcast/`))).rejects.toThrow('fetch failed');
    expect(lines[0]).toMatch(
      /^\[prerender-diag\] \/broadcast\/ threw after \d+ms: TypeError: fetch failed \(cause: UND_ERR_SOCKET other side closed\)$/,
    );
  });

  it('ignores requests that are not to a local preview server', async () => {
    const { fetch, lines } = harness(async () => new Response('nope', { status: 503 }));
    await fetch(new Request('https://example.com/x'));
    expect(lines).toEqual([]);
  });

  // Captured 2026-09-28 20:47 on the /live publisher: `(cause: ETIMEDOUT )` — the code and nothing
  // else. Which address, which syscall, and which of the dual-stack attempts timed out were lost.
  it('names the address, port, syscall and each sub-error of a connect failure', async () => {
    const attempt = (address: string) =>
      Object.assign(new Error(`connect ETIMEDOUT ${address}:4173`), {
        code: 'ETIMEDOUT',
        syscall: 'connect',
        address,
        port: 4173,
      });
    const { fetch, lines } = harness(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([attempt('::1'), attempt('127.0.0.1')], ''), {
          code: 'ETIMEDOUT',
        }),
      });
    });
    await expect(fetch(new Request(`${LOCAL}/live/`))).rejects.toThrow('fetch failed');
    expect(lines[0]).toContain('cause: ETIMEDOUT');
    expect(lines[0]).toContain('[connect ETIMEDOUT ::1:4173; connect ETIMEDOUT 127.0.0.1:4173]');
  });

  it('keeps a long error body to one bounded line', async () => {
    const { fetch, lines } = harness(async () => new Response('x'.repeat(5000), { status: 500 }));
    await fetch(new Request(`${LOCAL}/live/`));
    expect(lines[0]!.length).toBeLessThan(700);
  });
});

describe('withConnectRetry', () => {
  const noSleep = async () => {};
  const refused = () =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code: 'ETIMEDOUT' }) });

  // The plugin's own retry never re-requests: it re-queues the page through addCrawlPageTask,
  // which returns at once for a path it has already seen. One failed connect drops the page.
  it('re-requests a local page whose connection failed, and returns the success', async () => {
    let calls = 0;
    const fetch = withConnectRetry(
      async () => {
        calls++;
        if (calls < 3) throw refused();
        return new Response('<html>ok</html>');
      },
      { attempts: 4, delayMs: 1, sleep: noSleep },
    );
    const res = await fetch(new Request(`${LOCAL}/live/`));
    expect(await res.text()).toBe('<html>ok</html>');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt and throws the last error', async () => {
    let calls = 0;
    const fetch = withConnectRetry(
      async () => {
        calls++;
        throw refused();
      },
      { attempts: 3, delayMs: 1, sleep: noSleep },
    );
    await expect(fetch(new Request(`${LOCAL}/live/`))).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('does not retry a page that answered, even with a 500 (a render error is a real bug)', async () => {
    let calls = 0;
    const fetch = withConnectRetry(
      async () => {
        calls++;
        return new Response('boom', { status: 500 });
      },
      { attempts: 4, delayMs: 1, sleep: noSleep },
    );
    expect((await fetch(new Request(`${LOCAL}/live/`))).status).toBe(500);
    expect(calls).toBe(1);
  });

  it('does not retry a request to a non-local host', async () => {
    let calls = 0;
    const fetch = withConnectRetry(
      async () => {
        calls++;
        throw refused();
      },
      { attempts: 4, delayMs: 1, sleep: noSleep },
    );
    await expect(fetch(new Request('https://example.com/x'))).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('installPrerenderDiagnostics', () => {
  // `vite.preview()` reloads vite.config.ts in the same process, so the config's install ran three
  // times and every failure was logged three times, each layer timing a slightly longer call.
  it('installs once per process, however often the config is loaded', () => {
    const original = globalThis.fetch;
    try {
      installPrerenderDiagnostics();
      const once = globalThis.fetch;
      installPrerenderDiagnostics();
      installPrerenderDiagnostics();
      expect(globalThis.fetch).toBe(once);
      expect(globalThis.fetch).not.toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });
});
