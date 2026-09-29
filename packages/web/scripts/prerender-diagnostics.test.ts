import { describe, expect, it } from 'vitest';

import { withPrerenderDiagnostics } from './prerender-diagnostics.ts';

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

  it('keeps a long error body to one bounded line', async () => {
    const { fetch, lines } = harness(async () => new Response('x'.repeat(5000), { status: 500 }));
    await fetch(new Request(`${LOCAL}/live/`));
    expect(lines[0]!.length).toBeLessThan(700);
  });
});
