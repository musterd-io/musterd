/**
 * Why a prerendered page failed, said out loud.
 *
 * TanStack Start's prerender requests each page from a Vite preview server it starts in the build
 * process, with the global `fetch`. When a request fails it logs only
 * `Encountered error, retrying: <route>`, retries, and after the last retry drops the page. The error
 * it caught is never printed. check-prerendered-routes.ts catches the dropped page (#1618), but
 * neither says why it dropped. On 2026-09-28 this failed three daemon refreshes in a row, and nine
 * /live publisher builds since July, on /live, /broadcast, /character-sheet, /audit, /watch and /board
 * among others, with no cause in any log (lane 01M3NBT7RMMYZFQGKPS9NNGGBP).
 *
 * The preview server answers the same routes in ~20 ms idle and ~100 ms at a load average of 38,
 * with zero failures in 140 concurrent requests (measured that day). So the cause is not "load" in
 * the obvious sense, and guessing a timeout would be a guess. This wraps the global `fetch` for the
 * build process only, and prints one bounded line for each local page request that comes back
 * non-2xx or throws: path, status, status text, latency, the head of the body (where the SSR error
 * lands), or the error and its cause code. The response and the error pass through unchanged, so
 * the plugin behaves exactly as before.
 */

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const BODY_HEAD = 400;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, BODY_HEAD);
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return oneLine(String(err));
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const causeText =
    cause && (cause.code !== undefined || cause.message !== undefined)
      ? ` (cause: ${[cause.code, cause.message].filter((x) => x !== undefined).join(' ')})`
      : '';
  return oneLine(`${err.name}: ${err.message}${causeText}`);
}

export function withPrerenderDiagnostics(inner: Fetch, log: (line: string) => void): Fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!LOCAL_HOSTS.has(url.hostname)) return inner(input, init);
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (err) {
      log(`[prerender-diag] ${url.pathname} threw after ${ms()}ms: ${describeError(err)}`);
      throw err;
    }
    if (!res.ok && !(res.status >= 300 && res.status < 400)) {
      const head = oneLine(await res.clone().text().catch(() => ''));
      log(
        `[prerender-diag] ${url.pathname} → ${res.status} ${res.statusText} in ${ms()}ms` +
          (head ? `: ${head}` : ''),
      );
    }
    return res;
  };
}

/** Install the wrapper on this process's global `fetch`. Build only: `vite build` loads the config
 *  once, in the process that runs the prerender. */
export function installPrerenderDiagnostics(): void {
  const inner = globalThis.fetch.bind(globalThis) as Fetch;
  globalThis.fetch = withPrerenderDiagnostics(inner, (line) => console.warn(line)) as typeof fetch;
}
