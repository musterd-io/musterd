# Wake take-over Implementation Plan

> **For agentic workers:** implement this in your own seat with superpowers:executing-plans, one lane
> per task group (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a person runs `musterd <seat>` and a wake on this machine holds the seat, offer
`⏎ take over · w watch · esc`. Take over stops the wake at a tool boundary and resumes its
conversation. Watch follows it live.

**Architecture:** The wake host writes `.musterd/wake-lease.json` (with the new `session_id`) for
Claude Code wakes as it already does for Codex. The launcher finds the wake through that file, asks it
to stop by writing `.musterd/wake-yield.json`, which `musterd gate` turns into a PreToolUse deny, and
hard-stops the process group if it does not exit. The host notices the yield marker when its child
settles and reports `yielded` on the supplementary wake report. Watch tails the wake's transcript.

**Tech Stack:** TypeScript (Node ≥22), zod (`@musterd/protocol`), vitest, the existing launcher
(`packages/cli/src/launcher`), host (`packages/cli/src/host`) and gate (`packages/cli/src/commands/gate.ts`).

**Spec:** `docs/superpowers/specs/2026-10-07-wake-take-over-design.md`

## Global Constraints

- `@musterd/protocol` schema changes ship with an ADR (AGENTS.md hard rule 1). Take the number from
  `pnpm adr:next` and push a draft PR before writing the ADR (ADR 220/223).
- New wire fields are optional, so older hosts and launchers still parse (ADR 148).
- Glossary terms only: Team, Member, Presence, Surface, Act (`brand.md` §5).
- CLI output matches `docs/design/figma-brief-terminal.md`. A new frame updates the brief in the same
  PR.
- Docs and code never disagree at the end of a commit (hard rule 3). Every new source file gets a
  described line in its package's `## File tree` block (`arch-trees:check`).
- No new runtime dependency.
- Nothing crosses to the daemon that names a session id or a transcript path (ADR 131 §5). `session_id`
  lives only in the local file.
- Fast gates before every push: `pnpm typecheck && pnpm lint && pnpm format:check`. CI is the test
  authority. Do not run the full suite on the shared laptop.
- Every commit ends with `Co-authored-by: dolly <dolly@revive.musterd>`.

## Review Focus

1. **A stale `wake-lease.json`** (crashed host, expired lease, or a pid the OS reused) must read as "no
   wake here". It must never stop an unrelated process. Pinned in Task 3.1 (`localWake`).
2. **A wake mid-way through a long model turn** makes no tool call, so the yield marker is never seen.
   The hard stop must fire after 10 s and stop the whole process group. Pinned in Task 2.2.
3. **A yield marker left behind** (the person pressed ⌃C during the stop) must not stop a *later*
   wake with a different lease. Pinned in Task 2.1 (lease match) and Task 1.2 (host removes it).
4. **An older host** writes no `session_id`. Take over cannot resume, so the launcher falls back to
   ADR 543's question instead of resuming nothing. Pinned in Task 3.2.
5. **A credential in the wake's transcript** must not print in watch mode. Pinned in Task 4.1.

## Increments

| # | Lane | Tasks |
| --- | --- | --- |
| 1 | `01M4C6VGFH9G9XC3Q9D5SPET2H` | 1.1–1.4: protocol fields, ADR, host writes the file and reports `yielded`, server records it |
| 2 | `01M4C6VMNF59JHWAKCGFTA48RH` | 2.1–2.2: the yield marker in `gate`, the stop escalation |
| 3 | `01M4C6VNN7HDB9GCXF08GTZ2BV` | 3.1–3.5: find the wake, the menu, take over, flags, picker, docs |
| 4 | `01M4C6VP9V8RY75B3HYGT51PX0` | 4.1–4.3: watch events, the follow loop, wiring |

Each increment is its own branch and PR, landed in order.

## Corrections to the spec (found while planning, 2026-10-07)

- Claude Code wakes do **not** write `wake-lease.json` today. Only `host/backends/codex.ts` does
  (ADR 354). Task 1.2 adds the write to the Claude Code backend.
- The primary wake report lands at verification, long before a take-over. So `yielded` rides the
  **supplementary** report the host already sends at run exit (`residency.wake_cost`). It does not
  change the primary outcome, so a take-over never counts as a failed wake.
- The launcher is not the wake's parent, so it cannot read an exit code. Watch decides "finished" vs
  "ended early" from the transcript. If the last assistant record's `stop_reason` is `end_turn`, the
  wake finished. Anything else means it ended early.

The spec is updated with these in the same PR as this plan.

---

## Increment 1 — protocol and host (lane `01M4C6VGFH9G9XC3Q9D5SPET2H`)

Branch: `feat/wake-take-over-1-protocol-host`. Claim the lane first (`lane_claim`).

### Task 1.1: Protocol fields and the yield file schema

**Files:**
- Modify: `packages/protocol/src/wakeLease.ts`
- Modify: `packages/protocol/src/residency.ts` (`WakeReportBodySchema`, ~line 726)
- Test: `packages/protocol/src/wakeLease.test.ts`, `packages/protocol/src/residency.test.ts`

**Interfaces:**
- Produces: `WakeLeaseFile.session_id?: string`; `WAKE_YIELD_FILE = 'wake-yield.json'`;
  `WakeYieldFileSchema` / `type WakeYieldFile = { lease_id: string; by: string; at: number }`;
  `WakeReportBody.yielded?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// wakeLease.test.ts
import { WAKE_YIELD_FILE, WakeLeaseFileSchema, WakeYieldFileSchema } from './wakeLease.js';

describe('wake take-over fields (ADR NNN)', () => {
  const base = {
    lease_id: 'L1',
    provenance: 'wake',
    harness: 'claude-code',
    spawner_pid: 42,
    started_at: 1,
    expires_at: 2,
  };
  it('the lease file carries the session id, and stays optional for older hosts', () => {
    expect(WakeLeaseFileSchema.parse({ ...base, session_id: 'c5b415ef' }).session_id).toBe('c5b415ef');
    expect(WakeLeaseFileSchema.parse(base).session_id).toBeUndefined();
  });
  it('the yield file names the lease it stops, who asked, and when', () => {
    expect(WAKE_YIELD_FILE).toBe('wake-yield.json');
    expect(WakeYieldFileSchema.parse({ lease_id: 'L1', by: 'nick', at: 5 })).toEqual({
      lease_id: 'L1',
      by: 'nick',
      at: 5,
    });
    expect(WakeYieldFileSchema.safeParse({ by: 'nick', at: 5 }).success).toBe(false);
  });
});

// residency.test.ts
it('a wake report may say the run yielded to a person (ADR NNN)', () => {
  expect(WakeReportBodySchema.parse({ lease_id: 'L1', occupied: true, yielded: true }).yielded).toBe(true);
});
```

- [ ] **Step 2: Run them to confirm they fail.** Run: `pnpm --filter @musterd/protocol exec vitest run src/wakeLease.test.ts src/residency.test.ts`. Expected: FAIL (`WAKE_YIELD_FILE` undefined, `session_id` stripped, `yielded` stripped).

- [ ] **Step 3: Implement**

```ts
// wakeLease.ts — inside WakeLeaseFileSchema, after expires_at:
  /** The conversation id the host gave the harness (`--session-id` / `--resume`), so a person can
   *  take the wake over in that conversation (ADR NNN). Local only — never sent to the daemon.
   *  Absent from older hosts: take over then falls back to the plain live-seat question. */
  session_id: z.string().min(1).max(128).optional(),

// wakeLease.ts — new, after WakeLeaseFile:
/** The marker a launcher writes to ask the wake holding `lease_id` to stop (ADR NNN). `musterd gate`
 *  denies that wake's next tool call while it exists; the host removes it when the run settles. */
export const WAKE_YIELD_FILE = 'wake-yield.json';
export const WakeYieldFileSchema = z.object({
  lease_id: z.string().min(1).max(64),
  /** The person taking over, for the deny line and the audit. */
  by: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
});
export type WakeYieldFile = z.infer<typeof WakeYieldFileSchema>;

// residency.ts — inside WakeReportBodySchema, after `deferred`:
  /** ADR NNN: the run ended because a person took the seat over (the yield marker named this
   *  lease). Rides the supplementary report; never changes the primary outcome. */
  yielded: z.boolean().optional(),
```

- [ ] **Step 4: Run the tests to confirm they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Export check.** Confirm `packages/protocol/src/index.ts` re-exports `wakeLease.js` (`grep -n wakeLease packages/protocol/src/index.ts`). Add `export * from './wakeLease.js';` only if it is missing.

- [ ] **Step 6: Commit.** `git commit -am "feat(protocol): wake-lease session_id, the yield file, yielded on the wake report (ADR NNN)"`

### Task 1.2: The Claude Code host writes the lease file and reports `yielded`

**Files:**
- Modify: `packages/cli/src/host/backends/claudeCode.ts` (`runAttempt`, ~line 395; `ClaudeCodeDeps`, ~line 126)
- Modify: `packages/cli/src/host/wakeLeaseFile.ts` (add `takeYieldFile`)
- Modify: `packages/cli/src/host/loop.ts` (supplementary report, ~line 604)
- Test: `packages/cli/src/host/wakeLeaseFile.test.ts`, `packages/cli/src/host/backends/claudeCode.test.ts`, `packages/cli/src/host/loop.test.ts`

**Interfaces:**
- Consumes: `WakeLeaseFile.session_id`, `WAKE_YIELD_FILE`, `WakeYieldFileSchema` (Task 1.1).
- Produces: `takeYieldFile(workspace: string, leaseId: string): boolean`, which returns true and
  deletes the file when it names `leaseId`, and returns false (deleting nothing) otherwise.
  `WakeCompletion.yielded?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// wakeLeaseFile.test.ts
describe('takeYieldFile (ADR NNN)', () => {
  it('takes a marker for this lease and leaves one for another lease alone', () => {
    const ws = mkdtempSync(join(tmpdir(), 'yield-'));
    mkdirSync(join(ws, '.musterd'));
    const path = join(ws, '.musterd', 'wake-yield.json');
    writeFileSync(path, JSON.stringify({ lease_id: 'L2', by: 'nick', at: 1 }));
    expect(takeYieldFile(ws, 'L1')).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(takeYieldFile(ws, 'L2')).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(takeYieldFile(ws, 'L2')).toBe(false); // gone is not a yield
  });
});

// claudeCode.test.ts — use the file's existing fake-spawn helpers
it('writes the lease file with the session id after spawn, and clears it when the run settles', async () => {
  const writes: unknown[] = [];
  const clears: string[] = [];
  // build the backend with deps.writeWakeLease = (ws, f) => writes.push(f),
  // deps.clearWakeLease = (ws, id) => clears.push(id), deps.mintSessionId = () => 'S-1',
  // and a fake child with pid 4242 that exits 0 after printing a result line.
  // …run one fresh wake for lease 'L1'…
  expect(writes).toEqual([
    expect.objectContaining({ lease_id: 'L1', harness: 'claude-code', spawner_pid: 4242, session_id: 'S-1' }),
  ]);
  expect(clears).toEqual(['L1']);
});

it('a run that settles while a yield marker names its lease completes as yielded', async () => {
  // same harness; deps.takeYield = (ws, id) => id === 'L1'
  // …await the settled completion…
  expect(completion?.yielded).toBe(true);
});
```

- [ ] **Step 2: Run them to confirm they fail.** Run: `pnpm --filter @musterd/cli exec vitest run src/host/wakeLeaseFile.test.ts src/host/backends/claudeCode.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `takeYieldFile`**

```ts
// wakeLeaseFile.ts
import { BINDING_DIR, WAKE_LEASE_FILE, WAKE_YIELD_FILE, WakeYieldFileSchema, type WakeLeaseFile } from '@musterd/protocol';

/** Remove the yield marker if it names `leaseId` (ADR NNN). True ⇒ this run was taken over. A marker
 *  for another lease is left for that lease's run; a missing or unreadable one is no yield. */
export function takeYieldFile(workspace: string, leaseId: string): boolean {
  const path = join(workspace, BINDING_DIR, WAKE_YIELD_FILE);
  try {
    const parsed = WakeYieldFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || parsed.data.lease_id !== leaseId) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement the backend write, clear and yield.** In `ClaudeCodeDeps` add
  `writeWakeLease?: typeof writeWakeLeaseFile; clearWakeLease?: typeof clearWakeLeaseFile; takeYield?: typeof takeYieldFile;`.
  In `runAttempt`, right after the `try { child = … } catch` block:

```ts
  // ADR NNN: the same lease file Codex writes (ADR 354), now for Claude Code too and carrying the
  // conversation id, so a person running `musterd <seat>` can find this wake and take it over.
  if (child.pid !== undefined) {
    (deps.writeWakeLease ?? writeWakeLeaseFile)(spec.workspace, {
      lease_id: spec.order.lease_id,
      provenance: 'wake',
      harness: 'claude-code',
      spawner_pid: child.pid,
      started_at: spawnedAt,
      expires_at: spawnedAt + opts.timeoutMs,
      session_id: opts.sessionId,
    });
  }
```

  Where the attempt's `settled` promise resolves (the existing `child.once('exit', …)` handler), before the completion object is built:

```ts
    if (child.pid !== undefined)
      (deps.clearWakeLease ?? clearWakeLeaseFile)(spec.workspace, spec.order.lease_id);
    const yielded = (deps.takeYield ?? takeYieldFile)(spec.workspace, spec.order.lease_id);
```

  and add `...(yielded ? { yielded: true } : {})` to the `WakeCompletion` it returns. Add `yielded?: boolean` to the `WakeCompletion` type (in `host/backend.ts`).

- [ ] **Step 5: Codex settles the yield too.** In `codex.ts`'s settle (after `clearWakeLeaseFile`), add the same `takeYieldFile` call and `yielded` field, so a taken-over Codex wake is recorded the same way.

- [ ] **Step 6: The host sends the supplementary report when yielded.** In `loop.ts` at the early return (`if (completion.cost_usd === undefined && completion.duration_ms === undefined) return;`) change the condition to also send when yielded, and include the field:

```ts
          if (
            completion.cost_usd === undefined &&
            completion.duration_ms === undefined &&
            completion.yielded !== true
          )
            return;
          // …existing body construction…
          ...(completion.yielded ? { yielded: true } : {}),
```

  Add a `loop.test.ts` case: a completion with only `yielded: true` posts one supplementary report with `yielded: true`.

- [ ] **Step 7: Run the tests to confirm they pass.** Same command plus `src/host/loop.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit.** `git commit -am "feat(host): Claude Code wakes write the lease file with their session id; a taken-over run reports yielded (ADR NNN)"`

### Task 1.3: The server records `yielded`

**Files:**
- Modify: `packages/server/src/transport/http.ts` (supplementary branch, ~line 4430)
- Test: `packages/server/src/transport/residency-http.test.ts` (next to `supplementary wake-cost report`)

- [ ] **Step 1: Write the failing test.** Reuse that describe's `reportedLease()` helper:

```ts
it('a yielded-only supplementary report records residency.wake_cost with yielded (ADR NNN)', async () => {
  const leaseId = await reportedLease();
  const r = await post('/teams/dawn/residency/wake-report', { lease_id: leaseId, occupied: true, yielded: true }, agentKey);
  expect(r.status).toBe(200);
  expect(r.json.status).toBe('cost_recorded');
  const rows = await audits('residency.wake_cost');
  expect(rows.at(-1)?.detail).toMatchObject({ lease_id: leaseId, yielded: true });
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `pnpm --filter @musterd/server exec vitest run src/transport/residency-http.test.ts -t yielded`. Expected: FAIL (409 conflict).

- [ ] **Step 3: Implement.** Change the guard to `if (body.cost_usd !== undefined || body.duration_ms !== undefined || body.yielded === true)` and add `...(body.yielded ? { yielded: true } : {}),` to `detail`. Update the comment above it to name ADR NNN.

- [ ] **Step 4: Run it to confirm it passes.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(server): record a yielded wake on its supplementary report (ADR NNN)"`

### Task 1.4: ADR and docs, then land

- [ ] **Step 1:** `pnpm adr:next`. Reserve it with a stub commit and push a draft PR straight away (ADR 223).
- [ ] **Step 2:** Write `docs/decisions/NNN-wake-take-over.md` with Context (the 2026-10-07 incident, ADR 543), Problem, Decision (the three wire changes, the gate deny, the take over / watch prompt amending ADR 491 Decision 6 and ADR 543), Consequences, and Observability & Evaluation (`residency.wake_cost.yielded` counts take-overs; no eval, since this is not agent-facing behaviour). Replace every `NNN` in this increment's code comments and tests.
- [ ] **Step 3:** Docs in the same commit:
  - `SPEC.md`: the wake-lease file paragraph gains `session_id`, and the wake report gains `yielded`.
  - `docs/architecture/02-protocol.md`: the wake-report row.
  - `docs/architecture/03-server.md`: the supplementary-report line.
- [ ] **Step 4:** Run the fast gates, push, `gh pr ready`, then `gh pr merge --squash --auto --delete-branch`. After the merge, `lane_submit` and follow its reply.

---

## Increment 2 — yield and stop (lane `01M4C6VMNF59JHWAKCGFTA48RH`)

Branch: `feat/wake-take-over-2-yield`.

### Task 2.1: `musterd gate` denies a yielded wake's tool call

**Files:**
- Create: `packages/cli/src/launcher/yield.ts`
- Modify: `packages/cli/src/commands/gate.ts` (`decide`, right after `parseToolCall`)
- Test: `packages/cli/src/launcher/yield.test.ts`, `packages/cli/src/commands/gate.test.ts`

**Interfaces:**
- Consumes: `WAKE_YIELD_FILE`, `WakeYieldFileSchema`.
- Produces:
  - `writeYieldFile(workspace: string, y: WakeYieldFile): void`
  - `readYieldFile(workspace: string): WakeYieldFile | null`
  - `yieldDenyReason(workspace: string, env: NodeJS.ProcessEnv): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
// yield.test.ts
describe('yieldDenyReason (ADR NNN)', () => {
  const ws = () => { const d = mkdtempSync(join(tmpdir(), 'y-')); mkdirSync(join(d, '.musterd')); return d; };
  it('denies only the wake whose lease the marker names', () => {
    const d = ws();
    writeYieldFile(d, { lease_id: 'L1', by: 'nick', at: 1 });
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toMatch(
      /^nick has taken over this seat — end your turn now; do not retry/,
    );
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L2' })).toBeNull(); // a later wake is untouched
    expect(yieldDenyReason(d, {})).toBeNull(); // a person's own session is never denied
  });
  it('no marker, or an unreadable one, denies nothing', () => {
    const d = ws();
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toBeNull();
    writeFileSync(join(d, '.musterd', 'wake-yield.json'), '{not json');
    expect(yieldDenyReason(d, { MUSTERD_WAKE_LEASE: 'L1' })).toBeNull();
  });
});
```

  In `gate.test.ts`, follow the file's existing pattern for a stdin-driven `gate check --stdin`. With `MUSTERD_WAKE_LEASE=L1` and a marker for `L1` in the workspace, a `Bash` call prints the PreToolUse deny JSON whose reason starts `nick has taken over this seat`.

- [ ] **Step 2: Run them to confirm they fail.** `pnpm --filter @musterd/cli exec vitest run src/launcher/yield.test.ts src/commands/gate.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `yield.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR, WAKE_YIELD_FILE, WakeYieldFileSchema, type WakeYieldFile } from '@musterd/protocol';

/** The yield marker (ADR NNN): a person asks the wake holding `lease_id` in this folder to stop. */
export function writeYieldFile(workspace: string, y: WakeYieldFile): void {
  mkdirSync(join(workspace, BINDING_DIR), { recursive: true });
  writeFileSync(join(workspace, BINDING_DIR, WAKE_YIELD_FILE), JSON.stringify(y) + '\n', { mode: 0o600 });
}

export function readYieldFile(workspace: string): WakeYieldFile | null {
  try {
    const parsed = WakeYieldFileSchema.safeParse(
      JSON.parse(readFileSync(join(workspace, BINDING_DIR, WAKE_YIELD_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The PreToolUse deny for a wake a person has taken over, or null. Keyed on the session's own lease
 *  (`MUSTERD_WAKE_LEASE`, which the host sets and hooks inherit): a person's session carries none,
 *  and a later wake carries a different one, so a leftover marker can stop nothing else. */
export function yieldDenyReason(workspace: string, env: NodeJS.ProcessEnv): string | null {
  const lease = env['MUSTERD_WAKE_LEASE']?.trim();
  if (!lease) return null;
  const y = readYieldFile(workspace);
  if (!y || y.lease_id !== lease) return null;
  return `${y.by} has taken over this seat — end your turn now; do not retry this or any other tool.`;
}
```

- [ ] **Step 4: Wire it into `gate.ts`.** In `decide`, immediately after `if (!raw) return;`:

```ts
    // ADR NNN — a person took this wake over: stop at this tool boundary. Before the wall and any
    // daemon round trip, so nothing can delay it; purely local.
    const yielded = yieldDenyReason(process.cwd(), process.env);
    if (yielded) {
      emitDeny(yielded);
      emitted = true;
      decision = 'deny';
      return;
    }
```

  The hook command `cd`s to `$CLAUDE_PROJECT_DIR`, so `process.cwd()` is the seat's folder.

- [ ] **Step 5: Run the tests to confirm they pass.** Expected: PASS.

- [ ] **Step 6: Commit.** `git commit -am "feat(gate): a yield marker denies the taken-over wake's next tool call (ADR NNN)"`

### Task 2.2: Stop the wake: yield, wait, then hard stop

**Files:**
- Modify: `packages/cli/src/launcher/yield.ts`
- Test: `packages/cli/src/launcher/yield.test.ts`

**Interfaces:**
- Produces: `stopWake(wake: { workspace: string; lease_id: string; pid: number }, by: string, deps?: StopDeps): Promise<'yielded' | 'killed'>`, where
  `StopDeps = { alive?: (pid: number) => boolean; kill?: (pid: number, sig: NodeJS.Signals) => void; sleep?: (ms: number) => Promise<void>; now?: () => number; graceMs?: number; killGraceMs?: number }`.
  Defaults: `graceMs` 10 000 and `killGraceMs` 5 000.

- [ ] **Step 1: Write the failing tests**

```ts
describe('stopWake (ADR NNN)', () => {
  const fakeClock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  it('a wake that exits at its next tool call is yielded, and nothing is signalled', async () => {
    const d = ws(); const c = fakeClock(); let polls = 0; const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c, alive: () => ++polls < 3, kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('yielded');
    expect(kills).toEqual([]);
    expect(readYieldFile(d)).toEqual({ lease_id: 'L1', by: 'nick', at: expect.any(Number) });
  });
  it('a wake still alive after the grace gets SIGTERM to its group, then SIGKILL', async () => {
    const d = ws(); const c = fakeClock(); const kills: string[] = [];
    const r = await stopWake({ workspace: d, lease_id: 'L1', pid: 77 }, 'nick', {
      ...c, alive: () => true, kill: (p, s) => kills.push(`${p}:${s}`),
    });
    expect(r).toBe('killed');
    expect(kills).toEqual(['-77:SIGTERM', '-77:SIGKILL']);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail.** Expected: FAIL (`stopWake` undefined).

- [ ] **Step 3: Implement**

```ts
export interface StopDeps {
  alive?: (pid: number) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  killGraceMs?: number;
}

const POLL_MS = 250;

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Ask the wake to stop at its next tool call; past the grace, stop its process group the way the
 *  host's own watchdog does (detached ⇒ the harness leads its group). ADR NNN. */
export async function stopWake(
  wake: { workspace: string; lease_id: string; pid: number },
  by: string,
  deps: StopDeps = {},
): Promise<'yielded' | 'killed'> {
  const alive = deps.alive ?? pidAlive;
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  writeYieldFile(wake.workspace, { lease_id: wake.lease_id, by, at: now() });
  const until = (ms: number) => now() + ms;
  const waitGone = async (deadline: number): Promise<boolean> => {
    while (now() < deadline) {
      if (!alive(wake.pid)) return true;
      await sleep(POLL_MS);
    }
    return !alive(wake.pid);
  };
  if (await waitGone(until(deps.graceMs ?? 10_000))) return 'yielded';
  try { kill(-wake.pid, 'SIGTERM'); } catch { /* already gone */ }
  if (await waitGone(until(deps.killGraceMs ?? 5_000))) return 'killed';
  try { kill(-wake.pid, 'SIGKILL'); } catch { /* already gone */ }
  return 'killed';
}
```

  The first test's `alive` returns false on its third poll. The second test's `alive` never does, so SIGKILL is always sent after the second grace.

- [ ] **Step 4: Run the tests to confirm they pass.** Expected: PASS.

- [ ] **Step 5: Docs, gates, land.** Add `yield.ts` to the `packages/cli/src/` file tree in `docs/architecture/04-cli.md`. Run the fast gates, open the PR with auto-merge, and after the merge `lane_submit`.

---

## Increment 3 — the launcher (lane `01M4C6VNN7HDB9GCXF08GTZ2BV`)

Branch: `feat/wake-take-over-3-launcher`.

### Task 3.1: Find a live local wake

**Files:**
- Modify: `packages/cli/src/launcher/live.ts`
- Test: `packages/cli/src/launcher/live.test.ts`

**Interfaces:**
- Produces: `interface LocalWake { lease_id: string; pid: number; session_id: string | null; harness: string; started_at: number; workspace: string }` and
  `localWake(seat: Seat, live: Live | null, deps?: { alive?: (pid: number) => boolean; now?: () => number }): LocalWake | null`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('localWake (ADR NNN)', () => {
  const file = (over = {}) => ({ lease_id: 'L1', provenance: 'wake', harness: 'claude-code', spawner_pid: 77, started_at: 1_000, expires_at: 99_000, session_id: 'S-1', ...over });
  const at = (f: object) => { const d = mkdtempSync(join(tmpdir(), 'lw-')); mkdirSync(join(d, '.musterd')); writeFileSync(join(d, '.musterd', 'wake-lease.json'), JSON.stringify(f)); return d; };
  const wakeLive = { where: 'here' as const, label: 'here', surface: 'claude-code', since: 1, wake: null };
  it('a live, unexpired wake here is found', () => {
    const d = at(file());
    expect(localWake(seat({ path: d }), wakeLive, { alive: () => true, now: () => 5_000 })).toEqual({
      lease_id: 'L1', pid: 77, session_id: 'S-1', harness: 'claude-code', started_at: 1_000, workspace: d,
    });
  });
  it('expired, dead, elsewhere, not-a-wake, or no file is no wake', () => {
    const d = at(file());
    expect(localWake(seat({ path: d }), wakeLive, { alive: () => true, now: () => 100_000 })).toBeNull();
    expect(localWake(seat({ path: d }), wakeLive, { alive: () => false, now: () => 5_000 })).toBeNull();
    expect(localWake(seat({ path: d }), { ...wakeLive, where: 'elsewhere' }, { alive: () => true, now: () => 5_000 })).toBeNull();
    const { wake: _w, ...personLive } = wakeLive;
    expect(localWake(seat({ path: d }), personLive, { alive: () => true, now: () => 5_000 })).toBeNull();
    expect(localWake(seat({ path: mkdtempSync(join(tmpdir(), 'none-')) }), wakeLive)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** in `live.ts`. Use `readFileSync` of `join(seat.path, BINDING_DIR, WAKE_LEASE_FILE)`, `WakeLeaseFileSchema.safeParse`, and `pidAlive` from `./yield.js`. Return null unless all of these hold: `live?.where === 'here'`, `live.wake !== undefined`, the file parses, `now() < expires_at`, and `alive(spawner_pid)`. Map `spawner_pid → pid` and `session_id ?? null`, and set `workspace: seat.path`.

- [ ] **Step 4: Run the tests to confirm they pass.** **Step 5: Commit.**

### Task 3.2: The menu and take over in `musterd <seat>`

**Files:**
- Modify: `packages/cli/src/launcher/rows.ts` (add `wakeMenu`)
- Modify: `packages/cli/src/launcher/byName.ts` (`launchSeat`, the `!opts.force` block; `LaunchOptions`; flag parsing ~line 84)
- Modify: `packages/cli/src/launcher/plan.ts` (`PlanInput` gains `env` overrides on the plan)
- Modify: `packages/cli/src/launcher/supervise.ts` (spawn with `plan.env` when present)
- Test: `packages/cli/src/launcher/rows.test.ts`, `packages/cli/src/launcher/byName.test.ts`

**Interfaces:**
- Consumes: `localWake`, `LocalWake` (3.1); `stopWake` (2.2); `wakeReason` (ADR 543, `rows.ts`).
- Produces:
  - `wakeMenu(member: string, live: Live, now: number): string[]`, the menu lines.
  - `LaunchOptions.takeOver?: boolean` and `LaunchOptions.watch?: boolean`.
  - `LaunchDeps.choose?: (lines: string[]) => Promise<'take-over' | 'watch' | 'cancel'>`, where ⏎ means take-over, w means watch, and esc or ⌃C means cancel.
  - `LaunchDeps.stopWake?: typeof stopWake`.
  - `LaunchDeps.watch?: (wake: LocalWake, seat: Seat) => Promise<'take-over' | 'leave' | 'finished' | 'ended'>` (implemented in Increment 4; until then, the default refuses with "watch arrives in increment 4").
  - `LaunchPlan.env?: NodeJS.ProcessEnv`.

- [ ] **Step 1: Write the failing tests**

```ts
// rows.test.ts
it('the wake menu names the wake, why, and the three keys (ADR NNN)', () => {
  const live = { where: 'here' as const, label: 'here', surface: 'claude-code', since: NOW - H,
    wake: { edge: 'dispatch_continuation', lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG', act_id: null, act: null, from: null } };
  expect(wakeMenu('dolly', live, NOW)).toEqual([
    `dolly is busy — a wake started ${sinceLabel(NOW - H, NOW)} to carry on with lane 01M46YWG8Y.`,
    '  ⏎  take over   stop the wake, continue its conversation here',
    '  w  watch       follow it live; ⏎ takes over at any point',
    '  esc cancel',
  ]);
});

// byName.test.ts — reuse the woken-roster fixture from the ADR 543 test; seat folder gets a
// wake-lease.json (pid 77, session S-1) and deps.alive = () => true via a localWake dep.
it('⏎ on a local wake stops it and resumes its conversation (ADR NNN)', async () => {
  const stop = vi.fn(async () => 'yielded' as const);
  const { d, supervise } = deps({ roster: woken, isTTY: true, choose: async () => 'take-over', stopWake: stop, catalog: cat });
  expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ lease_id: 'L1', pid: 77 }), expect.any(String));
  expect(supervise.mock.calls[0]![0]).toMatchObject({ args: expect.arrayContaining(['--resume', 'S-1']) });
  expect(supervise.mock.calls[0]![0].env).toMatchObject({ MUSTERD_TOOK_OVER: 'to carry on with lane 01M46YWG8Y' });
});
it('esc launches nothing and stops nothing', async () => { /* choose → 'cancel'; expect stop and supervise not called; returns 0 */ });
it('--take-over with no TTY takes over; --force on a wake also takes over', async () => { /* isTTY false; flags ['--take-over'] then ['--force'] */ });
it('a wake file with no session_id (older host) falls back to the plain question', async () => {
  /* write the file without session_id; expect deps.confirm called with liveQuestion text and no choose */
});
```

- [ ] **Step 2: Run them to confirm they fail.** Expected: FAIL.

- [ ] **Step 3: Implement `wakeMenu`** in `rows.ts`:

```ts
/** The take over / watch menu for a live local wake (ADR NNN), one string per line. */
export function wakeMenu(member: string, live: Live, now: number): string[] {
  const since = live.since !== null ? ` started ${sinceLabel(live.since, now)}` : '';
  const why = wakeReason(live.wake) || '';
  return [
    `${member} is busy — a wake${since}${why}.`,
    '  ⏎  take over   stop the wake, continue its conversation here',
    '  w  watch       follow it live; ⏎ takes over at any point',
    '  esc cancel',
  ];
}
```

- [ ] **Step 4: Implement the branch in `launchSeat`.** Replace the `if (!opts.force) { … }` block with:

```ts
  const live = liveFor(seat, await (deps.roster ?? fetchRoster)(seat.server, seat.team));
  const wake = live ? (deps.localWake ?? localWake)(seat, live) : null;
  if (wake && wake.session_id && live) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const choice: 'take-over' | 'watch' | 'cancel' =
      opts.takeOver || opts.force ? 'take-over'
      : opts.watch ? 'watch'
      : !isTTY ? (() => { throw new CliError(`${seat.member} is live ${liveSummary(live, now())} — pass --take-over or --watch`, 1); })()
      : await (deps.choose ?? chooseOnTTY)(wakeMenu(seat.member, live, now()));
    if (choice === 'cancel') return 0;
    if (choice === 'watch') {
      const watched = await (deps.watch ?? watchNotYet)(wake, seat);
      if (watched === 'leave') return 0;
      if (watched === 'take-over') await (deps.stopWake ?? stopWake)(wake, viewerNameFor(seat) ?? 'a person');
      // 'finished' / 'ended': the wake is already gone; resume its conversation as is.
    } else {
      await (deps.stopWake ?? stopWake)(wake, viewerNameFor(seat) ?? 'a person');
    }
    return runPlan(seat, { mode: 'resume', harness: wake.harness, force: true }, deps, {
      session: { harness: wake.harness, id: wake.session_id },
      env: { MUSTERD_TOOK_OVER: wakeReason(live.wake).trim() || 'the wake' },
    });
  }
  if (!opts.force && live) { /* unchanged ADR 543 path: liveSummary / liveQuestion / confirm */ }
```

  Extract the rest of today's `launchSeat` (binding → `planLaunch` → mirror → record → supervise → receipt) into `runPlan(seat, opts, deps, override?: { session?: {harness, id}; env?: NodeJS.ProcessEnv })`. `override.session` takes precedence over the binding's captured session, and `override.env` is set on the returned `LaunchPlan.env`. `chooseOnTTY` reads one keypress in raw mode: ⏎ → take-over, `w` → watch, esc or ⌃C → cancel. Mirror `confirmOnTTY`'s raw-mode handling in the same file. `viewerNameFor` is already imported in `byName.ts`. Check its signature and pass what it needs.

- [ ] **Step 5: `supervise.ts`.** Spawn with `env: plan.env ? { ...(deps.env ?? process.env), ...plan.env } : (deps.env ?? process.env)`. Add a test that `plan.env` reaches the child.

- [ ] **Step 6: Flags.** In the flag parsing (~line 84): `takeOver: parsed.flags['take-over'] === true, watch: parsed.flags['watch'] === true`. Add both flags to `help/catalog.ts` under `musterd <seat>`.

- [ ] **Step 7: Run the tests to confirm they pass.** **Step 8: Commit.** `git commit -am "feat(launcher): take over a live local wake — stop it at a tool boundary and resume its conversation (ADR NNN)"`

### Task 3.3: The session start line after a take-over

**Files:**
- Modify: `packages/cli/src/commands/session.ts` (the orientation emit, ~line 512)
- Test: `packages/cli/src/commands/session.test.ts`

- [ ] **Step 1: Failing test.** With `MUSTERD_TOOK_OVER='to carry on with lane 01M46YWG8Y'` in env, `session start --stdin` emits `additional_context` containing `You took over a wake that was running to carry on with lane 01M46YWG8Y — its conversation is above; continue from where it stopped.`
- [ ] **Step 2: Run it to confirm it fails.**
- [ ] **Step 3: Implement.** Where the orientation block is built, prepend that line when `process.env['MUSTERD_TOOK_OVER']` is set. It is a person's interactive session (no `MUSTERD_PROVENANCE=wake`), so the existing wake suppression does not apply.
- [ ] **Step 4: Run it to confirm it passes.** **Step 5: Commit.**

### Task 3.4: The picker

**Files:**
- Modify: `packages/cli/src/launcher/picker/state.ts` (`confirm` gains `wake: LocalWake | null`; outcomes gain `take-over` / `watch`)
- Modify: `packages/cli/src/launcher/picker/view.ts` (confirm footer)
- Modify: `packages/cli/src/launcher/index.ts` (dispatch the new outcomes to `launchSeat` with `takeOver` / `watch`)
- Test: `packages/cli/src/launcher/picker/state.test.ts`, `packages/cli/src/launcher/picker/view.test.ts`

**Interfaces:**
- Produces: `PickerOutcome` adds `| { kind: 'take-over'; seat: Seat } | { kind: 'watch'; seat: Seat }`.

- [ ] **Step 1: Failing tests.**
  - *state:* with `confirm.wake` set, ⏎ → `{ kind: 'take-over', seat }`, `w` → `{ kind: 'watch', seat }`, esc → `confirm: null` and no outcome. With `confirm.wake` null, today's `y` behaviour is unchanged.
  - *view:* the confirm footer renders `wakeMenu(...)` lines wrapped to the width when `confirm.wake` is set.
- [ ] **Step 2: Run them to confirm they fail.**
- [ ] **Step 3: Implement.**
  - Where the confirm is opened (`state.ts:334`), set `wake` from a `localWake` lookup the picker already has the seat for. Pass it in through the picker's existing `live` map plus a new `wakes: Record<string, LocalWake | null>` field filled when the roster is read.
  - In `index.ts`, map `take-over` → `launchSeat(seat, { mode: 'resume', harness: null, force: false, takeOver: true })` and `watch` → `{ …, watch: true }`.
- [ ] **Step 4: Run them to confirm they pass.** **Step 5: Commit.**

### Task 3.5: Docs and the terminal frame, then land

- [ ] `docs/architecture/04-cli.md` `musterd <seat>`: replace the ADR 543 sentence with the menu, `--take-over`, `--watch`, and `--force` on a wake.
- [ ] `docs/design/figma-brief-terminal.md`: add the wake-menu frame, with the exact lines from `wakeMenu`.
- [ ] Fast gates, PR, auto-merge, `lane_submit`.

---

## Increment 4 — watch (lane `01M4C6VP9V8RY75B3HYGT51PX0`)

Branch: `feat/wake-take-over-4-watch`.

### Task 4.1: Watch events from a transcript

**Files:**
- Create: `packages/cli/src/launcher/watch/events.ts`
- Test: `packages/cli/src/launcher/watch/events.test.ts`

**Interfaces:**
- Produces:
  - `interface WatchEvent { ts: number | null; kind: 'text' | 'tool'; line: string }`
  - `watchEvents(lines: readonly string[]): WatchEvent[]`
  - `endedCleanly(lines: readonly string[]): boolean`
  - `formatWatchLine(e: WatchEvent, cols: number): string`

- [ ] **Step 1: Failing tests** with a fixture built inline from real record shapes:

```ts
const rec = (o: object) => JSON.stringify(o);
const lines = [
  rec({ type: 'assistant', timestamp: '2026-10-07T16:27:00Z', message: { stop_reason: 'tool_use', content: [
    { type: 'text', text: "The umbrella's three PRs are merged;\nchecking main has all of them." },
    { type: 'tool_use', name: 'Bash', input: { command: 'git log --oneline origin/main -5', description: 'x' } },
  ] } }),
  rec({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET OUTPUT' }] } }),
  rec({ type: 'assistant', timestamp: '2026-10-07T16:29:00Z', message: { stop_reason: 'tool_use', content: [
    { type: 'tool_use', name: 'mcp__musterd__lane_submit', input: { id: '01M46YWG8YHEV2SKW9F1N0W8FG' } },
  ] } }),
  rec({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'export KEY=mskey_abcdefabcdefabcdef' }] } }),
  'not json',
];
it('reads words and tool calls, never tool results', () => {
  expect(watchEvents(lines).map((e) => e.line)).toEqual([
    "“The umbrella's three PRs are merged; checking main has all of them.”",
    '▸ Bash  git log --oneline origin/main -5',
    '▸ lane_submit  01M46YWG8YHEV2SKW9F1N0W8FG',
    expect.not.stringContaining('mskey_abcdef'),
  ]);
});
it('a credential in the words is scrubbed', () => {
  expect(watchEvents(lines).at(-1)!.line).toMatch(/\[REDACTED|\*\*\*/); // match scrubCredentials' actual marker
});
it('ended cleanly when the last assistant record stopped on end_turn', () => {
  expect(endedCleanly(lines)).toBe(true);
  expect(endedCleanly(lines.slice(0, 3))).toBe(false);
});
it('a line is one row, trimmed to the width', () => {
  expect(formatWatchLine({ ts: null, kind: 'text', line: 'x'.repeat(200) }, 40).length).toBeLessThanOrEqual(40);
});
```

  Before you write the assertion in the second test, check `scrubCredentials`' real replacement marker in `packages/protocol/src/traceScrub.ts` and use that exact marker.

- [ ] **Step 2: Run them to confirm they fail.**
- [ ] **Step 3: Implement.**
  - Parse each line with `JSON.parse` in a try/catch, skipping bad lines. Keep `type === 'assistant'` only.
  - For a `text` block: collapse whitespace to single spaces, run `scrubCredentials(text).text`, and wrap in `“…”`.
  - For a `tool_use` block: strip a `mcp__<server>__` prefix from the name, and take the first present arg in the order `command`, `file_path`, `path`, `id`, `lane_id`, `pattern`. Produce `▸ <name>  <arg>` and scrub it.
  - `ts`: `Date.parse(timestamp)` or null.
  - `endedCleanly`: the last parseable assistant record has `message.stop_reason === 'end_turn'`.
  - `formatWatchLine`: `HH:MM  ` (local time; omitted when ts is null) plus the line, cut to `cols` with `…`.
- [ ] **Step 4: Run them to confirm they pass.** **Step 5: Commit.**

### Task 4.2: The follow loop

**Files:**
- Create: `packages/cli/src/launcher/watch/index.ts`
- Test: `packages/cli/src/launcher/watch/index.test.ts`

**Interfaces:**
- Consumes: `LocalWake` (3.1), `watchEvents`, `endedCleanly`, `formatWatchLine` (4.1), `findClaudeTranscript(sessionId)` (`host/backends/claudeCode.ts:153`, returns the path's stat. Check its return shape, and add a sibling `claudeTranscriptPath(sessionId): string | undefined` there if it only returns a stat).
- Produces: `watchWake(wake: LocalWake, seat: Seat, deps?: WatchDeps): Promise<'take-over' | 'leave' | 'finished' | 'ended'>`, where
  `WatchDeps = { readLines?: (path: string) => string[]; alive?: (pid: number) => boolean; keys?: AsyncIterable<'enter' | 'esc'>; out?: (s: string) => void; sleep?: (ms: number) => Promise<void>; cols?: number; header?: string }`.

- [ ] **Step 1: Failing tests.**
  - It prints the header, then the last 10 events.
  - New lines appearing between polls are printed once, never twice.
  - `enter` resolves `take-over`, and `esc` resolves `leave`.
  - When `alive` turns false: if `endedCleanly` holds it prints `wake finished — opening its conversation` and resolves `finished`. Otherwise it prints `wake ended before finishing` and then the prompt `⏎ open its conversation · esc quit`. `enter` resolves `ended`, `esc` resolves `leave`.
  - With no transcript path it resolves `leave` after printing `can't watch: no transcript for this wake yet`.

  Drive `keys` with an async generator and `sleep` as a no-op that advances a counter.
- [ ] **Step 2: Run them to confirm they fail.**
- [ ] **Step 3: Implement.**
  - Poll every 500 ms. Track how many lines were already consumed, and print only events from new lines.
  - Race the next key against the poll.
  - Restore the terminal's raw mode on every exit path (`try/finally`).
- [ ] **Step 4: Run them to confirm they pass.** **Step 5: Commit.**

### Task 4.3: Wire watch into the launcher, docs, land

- [ ] In `byName.ts`, replace the `watchNotYet` default with `watchWake`, imported lazily (`await import('./watch/index.js')`) to keep the launcher's paint path light.
  - Add a `byName.test.ts` case: `watch` → `'leave'` stops nothing and launches nothing.
  - Add a case: `watch` → `'finished'` resumes `S-1` and stops nothing.
- [ ] Add `watch/events.ts` and `watch/index.ts` to the `04-cli.md` file tree. Add the watch frame to `figma-brief-terminal.md`.
- [ ] Fast gates, PR, auto-merge, `lane_submit`. The `wake-take-over` Goal is done when this lane is accepted.
