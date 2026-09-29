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

type Cause = { code?: unknown; message?: unknown; errors?: unknown };

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return oneLine(String(err));
  const cause = err.cause as Cause | undefined;
  const causeText =
    cause && (cause.code !== undefined || cause.message !== undefined)
      ? ` (cause: ${[cause.code, cause.message].filter((x) => x !== undefined).join(' ')})`
      : '';
  // A dual-stack connect (localhost → ::1 and 127.0.0.1) fails as an AggregateError whose own
  // message is empty; which address timed out lives only in its sub-errors. The first capture
  // (2026-09-28 20:47) printed `ETIMEDOUT` and nothing else for exactly this reason.
  const attempts = Array.isArray(cause?.errors)
    ? ` [${cause.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join('; ')}]`
    : '';
  return oneLine(`${err.name}: ${err.message}${causeText}${attempts}`);
}

function localPath(input: Request | string | URL): string | null {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return LOCAL_HOSTS.has(url.hostname) ? url.pathname : null;
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

export interface ConnectRetryOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Re-request a local page whose request THREW — the connection failed — rather than answered.
 *
 * The plugin has a `retryCount`, and it does not work: on an error it re-queues the page through
 * `addCrawlPageTask`, whose first line returns at once for a path already in its `seen` set, so the
 * page is never requested again and is dropped after one failure (read in
 * @tanstack/start-plugin-core 1.171 `prerender.js`, 2026-09-29). That is why the 20:47 capture shows
 * one failed `/live/` request and then a dropped page, with `retrying: /live` printed in between.
 *
 * Only a thrown request is retried. A page that answered, even with a 500, is a render error, which
 * is a real bug and must still fail the build via check-prerendered-routes.ts.
 */
export function withConnectRetry(inner: Fetch, opts: ConnectRetryOptions): Fetch {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (input, init) => {
    const path = localPath(input);
    if (path === null) return inner(input, init);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= opts.attempts; attempt++) {
      try {
        // A Request can be sent once; a fresh copy per attempt keeps the retry honest.
        const res = await inner(input instanceof Request ? input.clone() : input, init);
        if (attempt > 1) opts.log?.(`[prerender-diag] ${path} recovered on attempt ${attempt}`);
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < opts.attempts) await sleep(opts.delayMs);
      }
    }
    throw lastErr;
  };
}

const INSTALLED = Symbol.for('musterd.prerenderDiagnostics');

/**
 * Install diagnostics and the connect retry on this process's global `fetch`, for builds.
 *
 * Idempotent. `vite.preview()`, which the prerender starts, loads vite.config.ts again in the same
 * process, so an unguarded install ran three times: every failure was logged three times, each
 * layer timing a slightly longer call (3615, 3643 and 3644 ms in the 20:47 capture), and three
 * nested retries would multiply.
 */
export function installPrerenderDiagnostics(): void {
  const current = globalThis.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;
  const log = (line: string) => console.warn(line);
  const wrapped = withConnectRetry(
    withPrerenderDiagnostics(current.bind(globalThis) as Fetch, log),
    { attempts: 4, delayMs: 1000, log },
  ) as typeof fetch & { [INSTALLED]?: true };
  wrapped[INSTALLED] = true;
  globalThis.fetch = wrapped;
}
