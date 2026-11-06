/**
 * Poll a Fly machine until it is `stopped`, through the Machines API, for up to `deadlineMs`.
 * Extracted from `deploy.mjs` (which runs a deploy at the top level, so importing it runs the
 * deploy) for `waitForStopped.test.ts` — the same move as `scripts/adr-sections.ts`.
 *
 * Not `fly machine wait`: flyctl 0.4.123 returns `deadline_exceeded` after 60 s (the API's own wait
 * cap) whatever `--wait-timeout` says — reproduced 2026-11-03 against a `sleep 120` probe — and the
 * deploy cleanup then destroyed a live migrate machine mid-ladder, twice (lane 01M6FF11B1).
 *
 * Transient read failures retry inside the deadline (lane 01M6FJBY19): a thrown fetch, a 404 while
 * the machine record still lags its create, 408/429, and any 5xx. The deploy's `finally` destroys
 * the machine either way, so aborting the wait early is the same harm as the flyctl cap — the wait
 * gives up only at the deadline, or at once on a status that cannot heal by waiting (auth, other
 * 4xx).
 */
const RETRYABLE = new Set([404, 408, 429]);

export async function waitForStopped(
  token,
  app,
  machineId,
  deadlineMs,
  { fetchImpl = fetch, pollMs = 5000 } = {},
) {
  const headers = { Authorization: `Bearer ${token}` };
  const url = `https://api.machines.dev/v1/apps/${app}/machines/${machineId}`;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < deadlineMs) {
    let res;
    try {
      res = await fetchImpl(url, { headers });
    } catch (e) {
      last = `read failed: ${e instanceof Error ? e.message : String(e)}`;
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.state === 'stopped') return;
    if (!res.ok && !RETRYABLE.has(res.status) && res.status < 500)
      throw new Error(`reading the migrate machine → ${res.status} ${body.error ?? ''}`.trim());
    last = res.ok ? (body.state ?? '?') : `${res.status} ${body.error ?? ''}`.trim();
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `migrate machine ${machineId} did not stop within ${Math.round(deadlineMs / 1000)} s (state ${last})`,
  );
}
